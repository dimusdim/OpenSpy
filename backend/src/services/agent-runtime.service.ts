import { ChildProcess, execFileSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { AgentMessageRow, AgentProvider, AgentRepository, AgentRunEventRow, AgentSessionRow } from '../repositories/agent.repository';

type ProviderInfo = {
    provider: AgentProvider;
    label: string;
    command: string;
    available: boolean;
    notes?: string;
};

type LiveRun = {
    runId: string;
    sessionId: string;
    process: ChildProcess;
    emitter: EventEmitter;
    completed: boolean;
    lineQueue: Promise<void>;
    getAssistantText: () => string;
    cancelling?: boolean;
};

type NormalizedEvent = {
    eventType: string;
    payload: Record<string, any>;
};

type ParsedActions = {
    content: string;
    contentJson: Record<string, any> | null;
};

type AgentStreamPart = {
    id: string;
    type: 'text' | 'tool' | 'status';
    text?: string;
    eventType?: string;
    name?: string;
    toolUseId?: string;
    rawType?: string;
    input?: any;
    output?: any;
    state?: 'started' | 'completed' | 'status';
    isError?: boolean;
};

type LaunchConfig = {
    command: string;
    args: string[];
    providerSessionId?: string | null;
    expectsProviderSessionId?: boolean;
    resumeMode: 'native' | 'new' | 'unsupported';
};

type StartRunOptions = {
    requestContext?: Record<string, any> | null;
};

type ProviderLineState = {
    getAssistantText: () => string;
    setAssistantText: (value: string) => void;
    getLastSnapshot: () => string;
    setLastSnapshot: (value: string) => void;
    toolDrafts: Map<string, {
        id: string;
        indexKey: string;
        name: string;
        rawType: string;
        inputJson: string;
        input?: any;
    }>;
};

// Explicit machine-action block used for presentation batches. Inline object,
// area and replay references must use Markdown `ospy://` links instead of
// frontend text guessing.
const ACTION_BLOCK_RE_LIST = [
    /<ACTIONS_JSON>\s*([\s\S]*?)\s*<\/ACTIONS_JSON>/i,
    /```ACTIONS_JSON\s*([\s\S]*?)\s*```/i,
    /ACTIONS_JSON:?\s*```(?:json)?\s*([\s\S]*?)\s*```/i,
];
const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
    'Bash(./.agents/tools/worldview-cli.sh *)',
    'Bash(./.agents/tools/backend-api.sh *)',
    'Bash(./.agents/tools/sql-readonly.sh *)',
    'Bash(./.agents/tools/source-fetch.sh *)',
    'Bash(./.agents/tools/map-command.sh *)',
].join(',');
const DEFAULT_CLAUDE_TOOLS = 'Bash';
const DEFAULT_CLAUDE_DISALLOWED_TOOLS = [
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'Glob',
    'Grep',
    'TodoWrite',
    'ToolSearch',
    'WebFetch',
    'WebSearch',
    'NotebookEdit',
    'LSP',
    'mcp__*',
    'Bash(ls *)',
    'Bash(cat *)',
    'Bash(head *)',
    'Bash(tail *)',
    'Bash(grep *)',
    'Bash(rg *)',
    'Bash(find *)',
    'Bash(wc *)',
    'Bash(diff *)',
    'Bash(stat *)',
    'Bash(du *)',
    'Bash(git *)',
    'Bash(pwd)',
    'Bash(pwd *)',
    'Bash(sed *)',
    'Bash(awk *)',
    'Bash(ps *)',
    'Bash(env *)',
    'Bash(printenv *)',
    'Bash(which *)',
    'Bash(type *)',
    'Bash(command *)',
].join(',');
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const DEFAULT_CODEX_SANDBOX = 'read-only';
const CLAUDE_BARE_AUTH_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
];
function isCodexProviderEnabled(): boolean {
    return process.env.AGENT_ENABLE_CODEX_PROVIDER === 'true';
}

function commandExists(command: string): boolean {
    if (command.includes('/')) {
        try {
            fs.accessSync(command, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    return dirs.some((dir) => {
        try {
            fs.accessSync(path.join(dir, command), fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
}

function ensureUuid(value: string | null | undefined): string {
    if (value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return value;
    }
    return crypto.randomUUID();
}

function extractActions(content: string): ParsedActions {
    let match: RegExpMatchArray | null = null;
    let pattern: RegExp | null = null;
    for (const candidate of ACTION_BLOCK_RE_LIST) {
        match = content.match(candidate);
        if (match) {
            pattern = candidate;
            break;
        }
    }
    if (!match || !pattern) return { content: content.trim(), contentJson: null };
    const visible = content.replace(pattern, '').trim();
    try {
        const parsed = JSON.parse(match[1] || '{}');
        return {
            content: visible,
            contentJson: parsed && typeof parsed === 'object' ? parsed : null,
        };
    } catch (error: any) {
        return {
            content: visible,
            contentJson: {
                actions_parse_error: error?.message || 'Invalid ACTIONS_JSON',
                raw_actions: match[1],
            },
        };
    }
}

function normalizeAssistantVisibleText(text: string): string {
    return String(text || '').trim();
}

function finalAssistantTextAfterLastTool(events: AgentRunEventRow[], fallback: string): string {
    const ordered = [...events].sort((a, b) => Number(a.sequence_no || 0) - Number(b.sequence_no || 0));
    const lastToolSequence = ordered.reduce((max, event) => (
        event.event_type === 'tool.started' || event.event_type === 'tool.completed'
            ? Math.max(max, Number(event.sequence_no || 0))
            : max
    ), -1);
    if (lastToolSequence < 0) return fallback;
    const finalText = ordered
        .filter((event) => event.event_type === 'message.delta' && Number(event.sequence_no || 0) > lastToolSequence)
        .map((event) => String(event.payload?.text || ''))
        .join('');
    return finalText.trim() ? finalText : fallback;
}

function sanitizeJsonForPrompt(value: any, maxChars = 6000): Record<string, any> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    try {
        const json = JSON.stringify(value);
        if (json.length > maxChars) {
            return {
                truncated: true,
                note: `Request context exceeded ${maxChars} characters and was omitted.`,
            };
        }
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function formatRequestContextForPrompt(value: any): string {
    const context = sanitizeJsonForPrompt(value);
    if (!context) return '';
    return JSON.stringify(context, null, 2);
}

function findActionBlockStart(content: string): number {
    let first = -1;
    for (const pattern of ACTION_BLOCK_RE_LIST) {
        const match = content.match(pattern);
        if (match && typeof match.index === 'number') {
            first = first === -1 ? match.index : Math.min(first, match.index);
        }
    }
    return first;
}

function trimTrailingText(parts: AgentStreamPart[]): AgentStreamPart[] {
    const next = [...parts];
    for (let idx = next.length - 1; idx >= 0; idx -= 1) {
        const part = next[idx];
        if (part.type !== 'text') continue;
        const trimmed = (part.text || '').replace(/\s+$/g, '');
        if (trimmed) {
            next[idx] = { ...part, text: trimmed };
            return next;
        }
        next.splice(idx, 1);
    }
    return next;
}

function collectTextFromContent(value: any): string {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value
        .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if (typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
            return '';
        })
        .join('');
}

function firstString(...values: any[]): string {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) return value;
    }
    return '';
}

function summarizeToolName(toolName: string, command: string): string {
    if (toolName !== 'Bash' || !command) return toolName || 'tool';
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    const scriptIndex = tokens.findIndex((token) => /worldview-cli\.sh$/.test(token));
    if (scriptIndex >= 0) {
        return ['worldview-cli', ...tokens.slice(scriptIndex + 1, scriptIndex + 4)].join(' ').trim();
    }
    if (tokens.some((token) => /sql-readonly\.sh$/.test(token))) return 'read-only SQL';
    const sourceIndex = tokens.findIndex((token) => /source-fetch\.sh$/.test(token));
    if (sourceIndex >= 0) return ['source-fetch', ...tokens.slice(sourceIndex + 1, sourceIndex + 3)].join(' ').trim();
    const mapIndex = tokens.findIndex((token) => /map-command\.sh$/.test(token));
    if (mapIndex >= 0) return ['map-command', ...tokens.slice(mapIndex + 1, mapIndex + 3)].join(' ').trim();
    const backendIndex = tokens.findIndex((token) => /backend-api\.sh$/.test(token));
    if (backendIndex >= 0) return ['backend-api', ...tokens.slice(backendIndex + 1, backendIndex + 3)].join(' ').trim();
    return 'Bash';
}

function compactToolPayload(value: any, maxChars = 8000): any {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string') {
        return value.length > maxChars
            ? `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`
            : value;
    }
    try {
        const json = JSON.stringify(value);
        if (json.length <= maxChars) return value;
        return {
            truncated: true,
            preview: json.slice(0, maxChars),
            original_chars: json.length,
        };
    } catch {
        return String(value).slice(0, maxChars);
    }
}

function toolResultOutput(result: any): any {
    if (!result || typeof result !== 'object') return undefined;
    const content = result.content ?? result.result ?? result.output ?? result.text;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object') {
                if (typeof part.text === 'string') return part.text;
                if (typeof part.content === 'string') return part.content;
                return part;
            }
            return part;
        });
    }
    return content;
}

function truthyEnv(value: string | undefined): boolean {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function hasClaudeBareAuth(): boolean {
    if (process.env.AGENT_CLAUDE_SETTINGS && /apiKeyHelper/i.test(process.env.AGENT_CLAUDE_SETTINGS)) {
        return true;
    }
    return CLAUDE_BARE_AUTH_ENV_KEYS.some((key) => Boolean(process.env[key]));
}

export class AgentRuntimeService {
    private readonly liveRuns = new Map<string, LiveRun>();
    private providerCache: ProviderInfo[] | null = null;
    private instructionDocsCache: string | null = null;

    constructor(
        private readonly repository: AgentRepository,
        private readonly repoRoot: string,
    ) {
        this.registerProcessCleanup();
    }

    listProviders(): ProviderInfo[] {
        if (this.providerCache) return this.providerCache;
        const claudeCommand = process.env.AGENT_CLAUDE_COMMAND || 'claude';
        this.providerCache = [
            {
                provider: 'claude_code',
                label: 'Claude Code',
                command: claudeCommand,
                available: commandExists(claudeCommand),
                notes: 'Uses AI Worldview project tools for OSINT data, source checks, map actions and replay.',
            },
            ...(isCodexProviderEnabled() ? [{
                provider: 'codex_cli',
                label: 'Codex CLI',
                command: 'codex',
                available: commandExists('codex'),
                notes: 'Hidden unless explicitly enabled for a separate AI Worldview acceptance pass.',
            } satisfies ProviderInfo] : []),
        ];
        return this.providerCache;
    }

    async listSessions(): Promise<AgentSessionRow[]> {
        return this.repository.listSessions();
    }

    async createSession(provider: AgentProvider, metadata: Record<string, any> = {}): Promise<AgentSessionRow> {
        const providerInfo = this.listProviders().find((item) => item.provider === provider);
        if (!providerInfo) throw new Error(`Unknown agent provider: ${provider}`);
        if (!providerInfo.available) throw new Error(`Agent provider is not installed: ${providerInfo.label}`);
        return this.repository.createSession({
            provider,
            providerSessionId: null,
            metadata: {
                ...metadata,
                providerLabel: providerInfo.label,
                command: providerInfo.command,
            },
        });
    }

    async getSession(sessionId: string): Promise<AgentSessionRow | null> {
        return this.repository.getSession(sessionId);
    }

    async listMessages(sessionId: string): Promise<AgentMessageRow[]> {
        const messages = await this.repository.listMessages(sessionId);
        const runIds = [...new Set(messages
            .map((message) => String(message.metadata?.run_id || ''))
            .filter(Boolean))];
        if (runIds.length === 0) return messages;

        const eventsByRun = new Map<string, AgentRunEventRow[]>();
        await Promise.all(runIds.map(async (runId) => {
            eventsByRun.set(runId, await this.repository.listRunEvents(runId));
        }));

        return messages.map((message) => {
            const runId = String(message.metadata?.run_id || '');
            const events = runId ? eventsByRun.get(runId) || [] : [];
            const cleanedContent = message.role === 'assistant'
                ? normalizeAssistantVisibleText(message.content || '')
                : message.content;
            const baseMessage = cleanedContent === message.content ? message : { ...message, content: cleanedContent };
            if (message.role !== 'assistant' || events.length === 0) return baseMessage;
            const streamParts = this.buildStreamParts(runId, events, cleanedContent);
            if (streamParts.length === 0) return baseMessage;
            return {
                ...baseMessage,
                metadata: {
                    ...(message.metadata || {}),
                    streamParts,
                },
            };
        });
    }

    async recoverInterruptedRuns(reason = 'backend_restart'): Promise<number> {
        const interrupted = await this.repository.interruptRunningRuns(reason);
        for (const run of interrupted) {
            this.killRecordedProcessGroup(run.metadata?.pid, run.metadata?.command);
            await this.repository.appendRunEvent(run.agent_run_id, 'run.failed', {
                status: 'error',
                reason,
                recovered: true,
            });
        }
        if (interrupted.length > 0) {
            console.warn(`[AgentRuntime] Marked ${interrupted.length} stale running agent run(s) as error (${reason})`);
        }
        return interrupted.length;
    }

    async getRun(runId: string) {
        return this.repository.getRun(runId);
    }

    async listRunEvents(runId: string, afterSequence = 0) {
        return this.repository.listRunEvents(runId, afterSequence);
    }

    async startRun(sessionId: string, userPrompt: string, options: StartRunOptions = {}): Promise<{ runId: string }> {
        const session = await this.repository.getSession(sessionId);
        if (!session) throw new Error('Agent session not found');
        if (!userPrompt.trim()) throw new Error('Prompt is required');
        const existingRun = Array.from(this.liveRuns.values()).find((run) => run.sessionId === sessionId && !run.completed);
        if (existingRun) {
            throw new Error('Agent session already has a running request');
        }

        const requestContext = sanitizeJsonForPrompt(options.requestContext);
        const launch = this.buildLaunch(session, userPrompt, { requestContext });
        if (launch.resumeMode === 'unsupported') {
            throw new Error(`Agent provider ${session.provider} cannot resume sessions with the current AI Worldview configuration`);
        }

        const { run } = await this.repository.createRunForPrompt({
            sessionId,
            prompt: userPrompt,
            messageMetadata: {
                source: 'frontend',
                requestContext,
            },
            runMetadata: {
                provider: session.provider,
                startedBy: 'frontend',
                resumeMode: launch.resumeMode,
                requestContext,
            },
        });
        const emitter = new EventEmitter();

        await this.emitRunEvent(run.agent_run_id, emitter, 'run.started', {
            session_id: sessionId,
            provider: session.provider,
            resume_mode: launch.resumeMode,
        });

        await this.repository.updateSession(sessionId, {
            providerSessionId: launch.providerSessionId || session.provider_session_id,
            status: 'active',
            metadata: {
                activeRunId: run.agent_run_id,
                lastRunStatus: 'running',
            },
        });

        const child = spawn(launch.command, launch.args, {
            cwd: this.repoRoot,
            env: this.buildChildEnv(session, run.agent_run_id),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });
        child.unref();

        let stdoutBuffer = '';
        let stderrBuffer = '';
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        let assistantText = '';
        let lastSnapshot = '';
        const state: ProviderLineState = {
            getAssistantText: () => assistantText,
            setAssistantText: (value) => { assistantText = value; },
            getLastSnapshot: () => lastSnapshot,
            setLastSnapshot: (value) => { lastSnapshot = value; },
            toolDrafts: new Map(),
        };

        const liveRun: LiveRun = {
            runId: run.agent_run_id,
            sessionId,
            process: child,
            emitter,
            completed: false,
            lineQueue: Promise.resolve(),
            getAssistantText: () => assistantText,
        };
        this.liveRuns.set(run.agent_run_id, liveRun);
        void this.repository.updateRunMetadata(run.agent_run_id, {
            pid: child.pid || null,
            command: launch.command,
            expectsProviderSessionId: Boolean(launch.expectsProviderSessionId),
        });

        child.stdout.on('data', (chunk: Buffer) => {
            if (liveRun.completed) return;
            stdoutBuffer += stdoutDecoder.write(chunk);
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                this.enqueueProviderLine(liveRun, session, line, state);
            }
        });

        child.stderr.on('data', (chunk: Buffer) => {
            if (liveRun.completed) return;
            stderrBuffer += stderrDecoder.write(chunk);
            const lines = stderrBuffer.split(/\r?\n/);
            stderrBuffer = lines.pop() || '';
            for (const line of lines) {
                if (liveRun.completed) return;
                const trimmed = line.trim();
                if (!trimmed) continue;
                void this.emitRunEvent(run.agent_run_id, emitter, 'status.updated', {
                    level: 'warning',
                    source: 'stderr',
                    message: trimmed.slice(0, 2000),
                });
            }
        });

        child.on('error', (error) => {
            void this.finishRun(run.agent_run_id, sessionId, emitter, 'error', assistantText, {
                error: error.message,
            });
        });

        child.on('close', (code, signal) => {
            stdoutBuffer += stdoutDecoder.end();
            stderrBuffer += stderrDecoder.end();
            if (stdoutBuffer.trim()) {
                this.enqueueProviderLine(liveRun, session, stdoutBuffer, state);
            }
            const status = code === 0 ? 'completed' : 'error';
            liveRun.lineQueue = liveRun.lineQueue
                .then(() => this.finishRun(run.agent_run_id, sessionId, emitter, status, assistantText, {
                    exitCode: code,
                    signal,
                }))
                .catch((error: any) => this.finishRun(run.agent_run_id, sessionId, emitter, 'error', assistantText, {
                    exitCode: code,
                    signal,
                    error: error?.message || String(error),
                }));
        });

        return { runId: run.agent_run_id };
    }

    subscribe(runId: string, listener: (event: AgentRunEventRow) => void): () => void {
        const live = this.liveRuns.get(runId);
        if (!live) return () => {};
        live.emitter.on('event', listener);
        return () => {
            live.emitter.off('event', listener);
        };
    }

    async cancelRun(runId: string): Promise<void> {
        const live = this.liveRuns.get(runId);
        if (!live) return;
        live.cancelling = true;
        this.killProcessGroup(live.process, 'SIGTERM');
        setTimeout(() => this.killProcessGroup(live.process, 'SIGKILL'), 5_000).unref();
        await this.finishRun(runId, live.sessionId, live.emitter, 'cancelled', live.getAssistantText(), {
            cancelledBy: 'frontend',
        });
    }

    buildLaunch(session: AgentSessionRow, userPrompt: string, options: StartRunOptions = {}): LaunchConfig {
        const prompt = this.composePrompt(session, userPrompt, options);
        if (session.provider === 'claude_code') {
            const providerSessionId = ensureUuid(session.provider_session_id);
            const useBare = process.env.AGENT_CLAUDE_BARE
                ? truthyEnv(process.env.AGENT_CLAUDE_BARE)
                : hasClaudeBareAuth();
            const args = [
                '-p',
                prompt,
                '--output-format',
                'stream-json',
                '--verbose',
                '--include-partial-messages',
                '--no-chrome',
                '--disable-slash-commands',
                '--mcp-config',
                process.env.AGENT_CLAUDE_MCP_CONFIG || EMPTY_MCP_CONFIG,
                '--strict-mcp-config',
                '--permission-mode',
                process.env.AGENT_CLAUDE_PERMISSION_MODE || 'dontAsk',
                '--tools',
                process.env.AGENT_CLAUDE_TOOLS || DEFAULT_CLAUDE_TOOLS,
                '--allowed-tools',
                process.env.AGENT_CLAUDE_ALLOWED_TOOLS || DEFAULT_CLAUDE_ALLOWED_TOOLS,
                '--disallowed-tools',
                process.env.AGENT_CLAUDE_DISALLOWED_TOOLS || DEFAULT_CLAUDE_DISALLOWED_TOOLS,
            ];
            if (useBare) {
                args.splice(2, 0, '--bare');
            } else {
                args.push(
                    '--setting-sources',
                    process.env.AGENT_CLAUDE_SETTING_SOURCES || 'user',
                );
            }
            if (process.env.AGENT_CLAUDE_SETTINGS) {
                args.push('--settings', process.env.AGENT_CLAUDE_SETTINGS);
            }
            if (session.provider_session_id) {
                args.push('--resume', providerSessionId);
            } else {
                args.push('--session-id', providerSessionId);
            }
            return {
                command: process.env.AGENT_CLAUDE_COMMAND || 'claude',
                args,
                providerSessionId,
                expectsProviderSessionId: true,
                resumeMode: session.provider_session_id ? 'native' : 'new',
            };
        }

        if (session.provider === 'codex_cli') {
            if (session.provider_session_id) {
                return {
                    command: process.env.AGENT_CODEX_COMMAND || 'codex',
                    args: [
                        'exec',
                        'resume',
                        '--json',
                        '--ignore-user-config',
                        '--sandbox',
                        process.env.AGENT_CODEX_SANDBOX || DEFAULT_CODEX_SANDBOX,
                        '--ask-for-approval',
                        process.env.AGENT_CODEX_APPROVAL || 'never',
                        '-C',
                        this.repoRoot,
                        session.provider_session_id,
                        prompt,
                    ],
                    providerSessionId: session.provider_session_id,
                    expectsProviderSessionId: true,
                    resumeMode: 'native',
                };
            }
            return {
                command: process.env.AGENT_CODEX_COMMAND || 'codex',
                args: [
                    'exec',
                    '--json',
                    '--ignore-user-config',
                    '-C',
                    this.repoRoot,
                    '--sandbox',
                    process.env.AGENT_CODEX_SANDBOX || DEFAULT_CODEX_SANDBOX,
                    '--ask-for-approval',
                    process.env.AGENT_CODEX_APPROVAL || 'never',
                    prompt,
                ],
                expectsProviderSessionId: true,
                resumeMode: 'new',
            };
        }

        throw new Error(`Unknown agent provider: ${session.provider}`);
    }

    private buildStreamParts(runId: string, events: AgentRunEventRow[], finalContent: string): AgentStreamPart[] {
        const parts: AgentStreamPart[] = [];
        const ordered = [...events].sort((a, b) => Number(a.sequence_no || 0) - Number(b.sequence_no || 0));
        const toolNamesById = new Map<string, string>();
        const appendText = (event: AgentRunEventRow, text: string) => {
            if (!text) return;
            const last = parts[parts.length - 1];
            if (last?.type === 'text') {
                last.text = `${last.text || ''}${text}`;
                return;
            }
            parts.push({
                id: `${runId}:${event.sequence_no}:message.delta`,
                type: 'text',
                text,
            });
        };

        for (const event of ordered) {
            const payload = event.payload || {};
            const isTool = event.event_type === 'tool.started' || event.event_type === 'tool.completed';
            if (event.event_type === 'message.delta') {
                appendText(event, String(payload.text || ''));
                continue;
            }
            if (!isTool) continue;

            const state = event.event_type === 'tool.started' ? 'started' : 'completed';
            const toolUseId = String(payload.tool_use_id || '');
            let name = String(payload.name || payload.raw_type || 'tool');
            if (event.event_type === 'tool.started' && toolUseId && name) {
                toolNamesById.set(toolUseId, name);
            } else if (event.event_type === 'tool.completed' && toolUseId && toolNamesById.has(toolUseId)) {
                name = toolNamesById.get(toolUseId) || name;
            }
            const text = `${state === 'started' ? 'started' : 'completed'} ${name}`;
            parts.push({
                id: `${runId}:${event.sequence_no}:${event.event_type}`,
                type: 'tool',
                eventType: event.event_type,
                name,
                toolUseId,
                rawType: String(payload.raw_type || ''),
                input: compactToolPayload(payload.input),
                output: compactToolPayload(payload.output),
                state,
                isError: Boolean(payload.is_error),
                text,
            });
        }

        const hasText = parts.some((part) => part.type === 'text' && String(part.text || '').trim());
        if (!hasText && finalContent) {
            parts.push({
                id: `${runId}:final:text`,
                type: 'text',
                text: finalContent,
            });
        }

        const actionStart = findActionBlockStart(parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text || '')
            .join(''));
        if (actionStart < 0) return trimTrailingText(parts);

        let remainingText = actionStart;
        const visibleParts: AgentStreamPart[] = [];
        for (const part of parts) {
            if (part.type !== 'text') {
                if (remainingText > 0) visibleParts.push(part);
                continue;
            }
            const text = part.text || '';
            if (remainingText <= 0) continue;
            const visibleText = text.slice(0, remainingText);
            remainingText = Math.max(0, remainingText - text.length);
            if (visibleText) visibleParts.push({ ...part, text: visibleText });
        }
        return trimTrailingText(visibleParts);
    }

    private composePrompt(session: AgentSessionRow, userPrompt: string, options: StartRunOptions = {}): string {
        const providerInstruction = session.provider === 'claude_code'
            ? 'This is a non-interactive Claude Code subprocess launched by AI Worldview.'
            : 'This is a non-interactive Codex CLI subprocess launched by AI Worldview.';
        const productInstructions = this.loadProductInstructionDocs();
        const requestContext = formatRequestContextForPrompt(options.requestContext);
        return [
            'You are an AI Worldview OSINT agent.',
            '',
            providerInstruction,
            'The product contract below is loaded from AI Worldview Markdown instructions and skills. Use it as the source of truth for data access, source capability checks, map actions and replay presentation.',
            '',
            '<AI_WORLDVIEW_MARKDOWN_INSTRUCTIONS>',
            productInstructions,
            '</AI_WORLDVIEW_MARKDOWN_INSTRUCTIONS>',
            '',
            ...(requestContext ? [
                '<AI_WORLDVIEW_REQUEST_CONTEXT>',
                requestContext,
                '</AI_WORLDVIEW_REQUEST_CONTEXT>',
                '',
            ] : []),
            'User request:',
            userPrompt,
        ].join('\n');
    }

    private loadProductInstructionDocs(): string {
        if (this.instructionDocsCache !== null) return this.instructionDocsCache;
        const files = [
            '.agents/instructions/product-osint.md',
            '.agents/skills/worldview-data/SKILL.md',
            '.agents/skills/worldview-sources/SKILL.md',
            '.agents/skills/worldview-map-control/SKILL.md',
        ];
        const docs = files.map((relativePath) => {
            const filePath = path.join(this.repoRoot, relativePath);
            try {
                return `# ${relativePath}\n\n${fs.readFileSync(filePath, 'utf8').trim()}`;
            } catch (err: any) {
                return `# ${relativePath}\n\nInstruction file unavailable: ${err?.message || 'read failed'}`;
            }
        });
        this.instructionDocsCache = docs.join('\n\n---\n\n');
        return this.instructionDocsCache;
    }

    private buildChildEnv(session: AgentSessionRow, runId: string): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = {};
        const passThrough = [
            'PATH',
            'USER',
            'LOGNAME',
            'TMPDIR',
            'LANG',
            'LC_ALL',
            'TERM',
            'CODEX_HOME',
        ];
        for (const key of passThrough) {
            if (process.env[key]) env[key] = process.env[key];
        }
        const allowedAgentEnv = new Set([
            'AGENT_API_TOKEN',
            'AGENT_SQL_MAX_ROWS',
            'AGENT_SQL_TIMEOUT_MS',
        ]);
        for (const key of allowedAgentEnv) {
            const value = process.env[key];
            if (value !== undefined) env[key] = value;
        }
        const isolatedHome = path.join(this.repoRoot, '.agents', 'home');
        const claudeHome = process.env.AGENT_CLAUDE_HOME || process.env.HOME || isolatedHome;
        const runtimeHome = session.provider === 'claude_code'
            ? claudeHome
            : (process.env.AGENT_HOME || isolatedHome);
        fs.mkdirSync(runtimeHome, { recursive: true });
        env.HOME = runtimeHome;
        const useClaudeBashGuard = session.provider === 'claude_code' && truthyEnv(process.env.AGENT_CLAUDE_USE_BASH_GUARD);
        env.SHELL = useClaudeBashGuard
            ? path.join(this.repoRoot, '.agents', 'tools', 'claude-bash-guard.sh')
            : (process.env.SHELL || '/bin/bash');
        env.AI_WORLDVIEW_API_URL = process.env.AI_WORLDVIEW_API_URL || `http://127.0.0.1:${process.env.PORT || 3055}`;
        env.AGENT_SESSION_ID = session.agent_session_id;
        env.AGENT_RUN_ID = runId;
        env.AGENT_PROVIDER = session.provider;
        return env;
    }

    private killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
        if (!child.pid || child.killed) return;
        try {
            process.kill(-child.pid, signal);
        } catch {
            try { child.kill(signal); } catch { /* process may have exited */ }
        }
    }

    private recordedProcessMatches(pid: number, expectedCommand: any): boolean {
        if (!expectedCommand || typeof expectedCommand !== 'string') return false;
        try {
            const commandLine = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
                encoding: 'utf8',
                timeout: 1000,
            }).trim();
            if (!commandLine) return false;
            const expectedBase = path.basename(expectedCommand);
            return commandLine.includes(expectedCommand) || commandLine.includes(expectedBase);
        } catch {
            return false;
        }
    }

    private killRecordedProcessGroup(rawPid: any, expectedCommand?: any): void {
        const pid = Number(rawPid);
        if (!Number.isInteger(pid) || pid <= 0) return;
        if (!this.recordedProcessMatches(pid, expectedCommand)) return;
        try {
            process.kill(-pid, 'SIGTERM');
            setTimeout(() => {
                try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
            }, 5_000).unref();
        } catch {
            try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        }
    }

    private registerProcessCleanup(): void {
        const terminateLiveRuns = () => {
            for (const live of this.liveRuns.values()) {
                this.killProcessGroup(live.process, 'SIGTERM');
            }
        };
        process.once('beforeExit', terminateLiveRuns);
        process.once('SIGINT', () => {
            terminateLiveRuns();
            process.exit(130);
        });
        process.once('SIGTERM', () => {
            terminateLiveRuns();
            process.exit(143);
        });
    }

    private enqueueProviderLine(
        liveRun: LiveRun,
        session: AgentSessionRow,
        line: string,
        state: ProviderLineState,
    ): void {
        liveRun.lineQueue = liveRun.lineQueue
            .then(() => this.handleProviderLine(liveRun.runId, liveRun.emitter, session, line, state))
            .catch((error: any) => this.emitRunEvent(liveRun.runId, liveRun.emitter, 'status.updated', {
                level: 'warning',
                source: 'provider-line-queue',
                message: String(error?.message || error).slice(0, 2000),
            }).then(() => undefined));
    }

    private async handleProviderLine(
        runId: string,
        emitter: EventEmitter,
        session: AgentSessionRow,
        line: string,
        state: ProviderLineState,
    ): Promise<void> {
        if (this.liveRuns.get(runId)?.completed) return;
        const trimmed = line.trim();
        if (!trimmed) return;

        let parsed: any = null;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            const current = state.getAssistantText() + trimmed + '\n';
            state.setAssistantText(current);
            await this.emitRunEvent(runId, emitter, 'message.delta', {
                role: 'assistant',
                text: `${trimmed}\n`,
                provider: session.provider,
            });
            return;
        }

        const providerSessionId = this.extractProviderSessionId(session.provider, parsed);
        if (providerSessionId && providerSessionId !== session.provider_session_id) {
            session.provider_session_id = providerSessionId;
            await this.repository.updateSession(session.agent_session_id, {
                providerSessionId,
                metadata: {
                    providerSessionCaptured: true,
                    providerSessionCapturedAt: new Date().toISOString(),
                },
            });
            await this.emitRunEvent(runId, emitter, 'status.updated', {
                provider: session.provider,
                provider_session_id: providerSessionId,
                message: 'provider session captured',
            });
        }

        const normalized = this.normalizeProviderEvent(session.provider, parsed, state);
        if (normalized.snapshot) state.setLastSnapshot(normalized.snapshot);
        if (normalized.delta) {
            state.setAssistantText(state.getAssistantText() + normalized.delta);
            await this.emitRunEvent(runId, emitter, 'message.delta', {
                role: 'assistant',
                text: normalized.delta,
                provider: session.provider,
            });
        }

        for (const event of normalized.events) {
            await this.emitRunEvent(runId, emitter, event.eventType, event.payload);
        }
    }

    private extractProviderSessionId(provider: AgentProvider, event: any): string {
        const raw = event?.type === 'stream_event' && event?.event ? event.event : event;
        const candidates = provider === 'claude_code'
            ? [
                event?.session_id,
                event?.sessionId,
                raw?.session_id,
                raw?.sessionId,
                raw?.message?.session_id,
            ]
            : [
                event?.session_id,
                event?.sessionId,
                raw?.session_id,
                raw?.sessionId,
                raw?.msg?.session_id,
                raw?.message?.session_id,
            ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        }
        return '';
    }

    private normalizeProviderEvent(provider: AgentProvider, event: any, state: ProviderLineState): {
        delta: string;
        snapshot: string | null;
        events: NormalizedEvent[];
    } {
        const events: NormalizedEvent[] = [];
        const raw = event?.type === 'stream_event' && event?.event ? event.event : event;
        const lastSnapshot = state.getLastSnapshot();
        const currentText = state.getAssistantText();

        const type = firstString(raw?.type, event?.type, raw?.msg?.type, raw?.event);
        const toolName = firstString(raw?.content_block?.name, raw?.name, raw?.tool_name, raw?.msg?.name);
        const toolUseId = firstString(raw?.content_block?.id, raw?.tool_use_id, raw?.id, raw?.msg?.id);
        const toolIndexKey = raw?.index !== undefined ? `index:${raw.index}` : '';
        const toolDraftKey = toolUseId || toolIndexKey;
        const toolCommand = firstString(raw?.content_block?.input?.command, raw?.input?.command, raw?.msg?.input?.command);
        const toolInput = raw?.content_block?.input ?? raw?.input ?? raw?.msg?.input;
        const displayName = summarizeToolName(toolName, toolCommand);
        if (provider === 'claude_code' && raw?.type === 'content_block_start' && raw?.content_block?.type === 'tool_use' && toolDraftKey && !toolCommand) {
            const draft = {
                id: toolUseId,
                indexKey: toolIndexKey,
                name: toolName || 'tool',
                rawType: type,
                inputJson: '',
                input: toolInput,
            };
            state.toolDrafts.set(toolDraftKey, draft);
            if (toolUseId && toolIndexKey) state.toolDrafts.set(toolIndexKey, draft);
            return { delta: '', snapshot: null, events };
        }
        if (provider === 'claude_code' && raw?.type === 'content_block_delta') {
            const draft = toolDraftKey ? state.toolDrafts.get(toolDraftKey) : undefined;
            if (draft && typeof raw?.delta?.partial_json === 'string') {
                draft.inputJson += raw.delta.partial_json;
                return { delta: '', snapshot: null, events };
            }
        }
        if (provider === 'claude_code' && raw?.type === 'content_block_stop' && toolDraftKey && state.toolDrafts.has(toolDraftKey)) {
            const draft = state.toolDrafts.get(toolDraftKey)!;
            state.toolDrafts.delete(toolDraftKey);
            if (draft.id) state.toolDrafts.delete(draft.id);
            if (draft.indexKey) state.toolDrafts.delete(draft.indexKey);
            let parsedInput = draft.input;
            if (draft.inputJson.trim()) {
                try {
                    parsedInput = JSON.parse(draft.inputJson);
                } catch {
                    parsedInput = { partial_json: draft.inputJson };
                }
            }
            const command = firstString(parsedInput?.command);
            events.push({
                eventType: 'tool.started',
                payload: {
                    provider,
                    raw_type: draft.rawType || type,
                    name: summarizeToolName(draft.name, command),
                    tool_name: draft.name,
                    tool_use_id: draft.id || toolUseId,
                    input: compactToolPayload(parsedInput),
                },
            });
            return { delta: '', snapshot: null, events };
        }
        const contentBlocks = Array.isArray(raw?.message?.content)
            ? raw.message.content
            : Array.isArray(event?.message?.content)
                ? event.message.content
                : Array.isArray(raw?.content)
                    ? raw.content
                    : [];
        const directToolResults = raw?.type === 'tool_result' ? [raw] : [];
        const toolResults = [
            ...contentBlocks.filter((block: any) => block?.type === 'tool_result'),
            ...directToolResults,
        ];
        if (toolResults.length > 0) {
            for (const result of toolResults) {
                events.push({
                    eventType: 'tool.completed',
                    payload: {
                        provider,
                        raw_type: firstString(result?.type, 'tool_result'),
                        name: firstString(result?.name, result?.tool_name, 'tool'),
                        tool_use_id: firstString(result?.tool_use_id, result?.id),
                        is_error: Boolean(result?.is_error),
                        output: compactToolPayload(toolResultOutput(result)),
                    },
                });
            }
        } else if (
            (raw?.type === 'content_block_start' && raw?.content_block?.type === 'tool_use')
            || (type && /tool/i.test(type) && !/complete|finish|end|result/i.test(type))
        ) {
            events.push({
                eventType: /complete|finish|end|result/i.test(type) ? 'tool.completed' : 'tool.started',
                payload: {
                    provider,
                    raw_type: type,
                    name: displayName,
                    tool_name: toolName,
                    tool_use_id: toolUseId,
                    input: compactToolPayload(toolInput),
                },
            });
        } else if (type && !/assistant|message|delta|result|system|content_block/i.test(type)) {
            events.push({
                eventType: 'status.updated',
                payload: {
                    provider,
                    raw_type: type,
                },
            });
        }

        let text = '';
        let snapshot: string | null = null;

        if (provider === 'claude_code') {
            text = firstString(
                raw?.delta?.text,
                raw?.content_block?.text,
                event?.delta?.text,
                event?.content_block?.text,
            );
            const isAssistantMessage = raw?.type === 'assistant'
                || raw?.message?.role === 'assistant'
                || event?.message?.role === 'assistant';
            const assistantSnapshot = isAssistantMessage
                ? collectTextFromContent(raw?.message?.content || event?.message?.content)
                : '';
            if (assistantSnapshot) {
                snapshot = assistantSnapshot;
                if (assistantSnapshot.startsWith(currentText)) {
                    text = assistantSnapshot.slice(currentText.length);
                } else if (lastSnapshot && assistantSnapshot.startsWith(lastSnapshot)) {
                    text = assistantSnapshot.slice(lastSnapshot.length);
                } else if (!currentText && assistantSnapshot !== lastSnapshot) {
                    text = assistantSnapshot;
                }
            }
            if (raw?.type === 'result' && !currentText && !lastSnapshot) {
                text ||= firstString(raw?.result);
            }
        } else {
            text = firstString(
                raw?.delta?.text,
                raw?.delta,
                raw?.text,
                raw?.message,
                raw?.content,
                raw?.msg?.delta,
                raw?.msg?.text,
                raw?.msg?.message,
            );
        }

        return { delta: text, snapshot, events };
    }

    private async finishRun(
        runId: string,
        sessionId: string,
        emitter: EventEmitter,
        status: 'completed' | 'error' | 'cancelled',
        assistantText: string,
        metadata: Record<string, any>,
    ): Promise<void> {
        const live = this.liveRuns.get(runId);
        if (live?.completed) return;
        if (live) live.completed = true;

        const events = await this.repository.listRunEvents(runId).catch(() => [] as AgentRunEventRow[]);
        const finalAssistantText = status === 'completed'
            ? finalAssistantTextAfterLastTool(events, assistantText)
            : assistantText;
        const parsedRaw = extractActions(finalAssistantText);
        const parsed: ParsedActions = {
            content: normalizeAssistantVisibleText(parsedRaw.content),
            contentJson: parsedRaw.contentJson,
        };
        if (parsed.content || parsed.contentJson) {
            await this.repository.addMessage({
                sessionId,
                role: 'assistant',
                content: parsed.content,
                contentJson: parsed.contentJson,
                metadata: {
                    run_id: runId,
                    status,
                },
            });
            if (parsed.contentJson?.actions) {
                await this.emitRunEvent(runId, emitter, 'action.created', {
                    actions: parsed.contentJson.actions,
                });
            }
            await this.emitRunEvent(runId, emitter, 'message.completed', {
                role: 'assistant',
                content: parsed.content,
                content_json: parsed.contentJson,
            });
        }

        await this.repository.completeRun(runId, status, metadata);
        await this.repository.updateSession(sessionId, {
            status: status === 'error' ? 'error' : 'active',
            metadata: {
                activeRunId: null,
                lastRunId: runId,
                lastRunStatus: status,
            },
        });
        await this.emitRunEvent(runId, emitter, status === 'completed' ? 'run.completed' : 'run.failed', {
            status,
            ...metadata,
        });

        setTimeout(() => {
            this.liveRuns.delete(runId);
            emitter.removeAllListeners();
        }, 30_000);
    }

    private async emitRunEvent(
        runId: string,
        emitter: EventEmitter,
        eventType: string,
        payload: Record<string, any>,
    ): Promise<AgentRunEventRow> {
        const event = await this.repository.appendRunEvent(runId, eventType, payload);
        emitter.emit('event', event);
        return event;
    }
}

export function getRepoRootFromBackend(): string {
    return path.resolve(__dirname, '../../..');
}

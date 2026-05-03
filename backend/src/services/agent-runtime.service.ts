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

type ProviderLineState = {
    getAssistantText: () => string;
    setAssistantText: (value: string) => void;
    getLastSnapshot: () => string;
    setLastSnapshot: (value: string) => void;
};

const ACTION_BLOCK_RE_LIST = [
    /<ACTIONS_JSON>\s*([\s\S]*?)\s*<\/ACTIONS_JSON>/i,
    /```ACTIONS_JSON\s*([\s\S]*?)\s*```/i,
    /ACTIONS_JSON:?\s*```(?:json)?\s*([\s\S]*?)\s*```/i,
];
const INTERNAL_NOISE_RE = /(bash[- ]?guard|shell guard|allowed-tools|tool plumbing|alternative entrypoint|альтернативн.*entrypoint|quoting|квотирован|single-quote|double quote|пайп|кавычк|\$\$|backend-api|eval|pid|sql\s+with\s+quotes|actions_json|об[её]ртка|сыр(ой|ого)\s+sql|запускаю без них|посмотрю, как|api трактует bbox|возвращ[её]нные результаты пришли|перезапрос с правильным порядком|^понятно:?$|^понимаю проблему:?$|^изучаю\b|^анализирую\b|^смотрю\b|^проверяю\b|^получаю\b|^создаю\b|^готовлю\b|^проверю history-плотность|^готовлю отч[её]т|^i have clear coverage\.?$|^let me\b|^now i\b|^i'll\b|^i will\b|^i need\b|^next\b.*\b(check|query|build|create)\b|^got\b.*\bcoverage\b)/i;
const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
    'Bash(./.claude/skills/platform-cli/scripts/worldview-cli.sh *)',
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
const HIDDEN_PROVIDER_TOOLS = new Set([
    'read',
    'write',
    'edit',
    'multiedit',
    'glob',
    'grep',
    'todowrite',
    'toolsearch',
    'webfetch',
    'websearch',
    'notebookedit',
    'lsp',
]);

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

function cleanAssistantVisibleText(text: string): string {
    const withBreaks = text
        .replace(/H3-хексов/gi, 'H3-зон')
        .replace(/H3-хексы/gi, 'H3-зоны')
        .replace(/H3-хекс/gi, 'H3-зона')
        .replace(/хексов/gi, 'зон')
        .replace(/хексы/gi, 'зоны')
        .replace(/хекс/gi, 'зона')
        .replace(/(Bash guard|bash-guard|AI Worldview bash guard)/gi, '\n$1')
        .replace(/(Понятно: bash|Понимаю проблему: bash|Используем структурные команды CLI|Важное открытие: API трактует bbox)/gi, '\n$1')
        .replace(/(Теперь смотрю|Получил реальные|Сводка:|###|##|- )/g, '\n$1');
    return withBreaks
        .replace(/(\|[^\n]*\|)\n\s*\n(?=\s*\|)/g, '$1\n')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => !line || !INTERNAL_NOISE_RE.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
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

function isHiddenProviderTool(toolName: string): boolean {
    return HIDDEN_PROVIDER_TOOLS.has(String(toolName || '').trim().toLowerCase());
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
                ? cleanAssistantVisibleText(message.content || '')
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

    async startRun(sessionId: string, userPrompt: string): Promise<{ runId: string }> {
        const session = await this.repository.getSession(sessionId);
        if (!session) throw new Error('Agent session not found');
        if (!userPrompt.trim()) throw new Error('Prompt is required');
        const existingRun = Array.from(this.liveRuns.values()).find((run) => run.sessionId === sessionId && !run.completed);
        if (existingRun) {
            throw new Error('Agent session already has a running request');
        }

        const launch = this.buildLaunch(session, userPrompt);
        if (launch.resumeMode === 'unsupported') {
            throw new Error(`Agent provider ${session.provider} cannot resume sessions with the current AI Worldview configuration`);
        }

        const { run } = await this.repository.createRunForPrompt({
            sessionId,
            prompt: userPrompt,
            messageMetadata: { source: 'frontend' },
            runMetadata: {
                provider: session.provider,
                startedBy: 'frontend',
                resumeMode: launch.resumeMode,
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

    buildLaunch(session: AgentSessionRow, userPrompt: string): LaunchConfig {
        const prompt = this.composePrompt(session, userPrompt);
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

        for (const event of ordered) {
            const payload = event.payload || {};
            if (event.event_type === 'message.delta') {
                const text = String(payload.text || '');
                if (!text) continue;
                const last = parts[parts.length - 1];
                if (last?.type === 'text') {
                    parts[parts.length - 1] = { ...last, text: `${last.text || ''}${text}` };
                } else {
                    parts.push({
                        id: `${runId}:${event.sequence_no}:text`,
                        type: 'text',
                        text,
                    });
                }
                continue;
            }

            const isTool = event.event_type === 'tool.started' || event.event_type === 'tool.completed';
            if (!isTool) continue;

            const state = event.event_type === 'tool.started' ? 'started' : 'completed';
            const toolUseId = String(payload.tool_use_id || '');
            let name = String(payload.name || payload.raw_type || 'tool');
            if (event.event_type === 'tool.started' && toolUseId && name) {
                toolNamesById.set(toolUseId, name);
            } else if (event.event_type === 'tool.completed' && toolUseId && toolNamesById.has(toolUseId)) {
                name = toolNamesById.get(toolUseId) || name;
            }
            if (isHiddenProviderTool(name) || isHiddenProviderTool(payload.tool_name)) continue;
            const text = `${state === 'started' ? 'started' : 'completed'} ${name}`;
            parts.push({
                id: `${runId}:${event.sequence_no}:${event.event_type}`,
                type: 'tool',
                eventType: event.event_type,
                name,
                state,
                isError: Boolean(payload.is_error),
                text,
            });
        }

        const rawText = parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text || '')
            .join('');
        const actionStart = findActionBlockStart(rawText);
        if (actionStart < 0) {
            if (parts.length === 0 && finalContent) {
                return [{
                    id: `${runId}:final:text`,
                    type: 'text',
                    text: finalContent,
                }];
            }
            return parts;
        }

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

        const cleanedParts = trimTrailingText(visibleParts);
        if (cleanedParts.length === 0 && finalContent) {
            cleanedParts.push({
                id: `${runId}:final:text`,
                type: 'text',
                text: finalContent,
            });
        }
        return cleanedParts;
    }

    private composePrompt(session: AgentSessionRow, userPrompt: string): string {
        const providerInstruction = session.provider === 'claude_code'
            ? 'This is a non-interactive Claude Code subprocess launched by AI Worldview.'
            : 'This is a non-interactive Codex CLI subprocess launched by AI Worldview.';
        return [
            'You are an AI Worldview OSINT agent.',
            '',
            providerInstruction,
            'The instructions in this prompt are authoritative for this product chat. Do not rely on repository instructions, external memory, skills discovery, or provider file tools.',
            'Use only the approved AI Worldview command entrypoints for investigation:',
            '- ./.claude/skills/platform-cli/scripts/worldview-cli.sh for catalog, layer status, local data search, tracks, coverage, and source capabilities.',
            '- ./.agents/tools/sql-readonly.sh for read-only PostgreSQL analysis. For complex SQL use --sql-b64 so shell quoting never becomes part of the task.',
            '- ./.agents/tools/source-fetch.sh only when source capabilities mark a provider operation as available or auth_required.',
            '- ./.agents/tools/backend-api.sh for AI Worldview backend API calls.',
            '- ./.agents/tools/map-command.sh for selections, annotations, filters, replay windows, camera commands, and presentation actions.',
            'Do not use provider file tools such as Read, Write, Edit, Glob, Grep, TodoWrite, ToolSearch, WebFetch, or WebSearch. Do not create temporary files.',
            'Do not mutate the database directly.',
            'Use read-only SQL freely when it is the most direct way to analyze local data.',
            'Do not narrate shell guard, quoting, retries, or internal tool failures to the user; switch tools and report only product-relevant data limits.',
            'For AI Worldview query/replay bbox arguments use south,west,north,east. For geometry/AOI/map payloads use west,south,east,north or GeoJSON [lng,lat] coordinates as documented.',
            'When local data exists, lead with the analytic conclusion and the local evidence. Separate correlation from causation.',
            'State source limitations, missing history, and provider-plan constraints clearly, but do not make the answer mainly about limitations.',
            'Only recommend data expansion when source capabilities say it is available or auth_required. Treat planned or unsupported capabilities as product roadmap, not a user recommendation.',
            'Use one ACTIONS_JSON block at the end when the user should inspect results visually. Valid action types include map.fly_to, map.annotate, replay.play_window, selection.apply, layer.set_visibility, layer.filter, and overlay.draw_geometry.',
            'Never mention ACTIONS_JSON, tool names, shell commands, retries, provider internals, or implementation steps in visible answer text.',
            '',
            'User request:',
            userPrompt,
        ].join('\n');
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

        const normalized = this.normalizeProviderEvent(session.provider, parsed, state.getLastSnapshot(), state.getAssistantText());
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

    private normalizeProviderEvent(provider: AgentProvider, event: any, lastSnapshot: string, currentText: string): {
        delta: string;
        snapshot: string | null;
        events: NormalizedEvent[];
    } {
        const events: NormalizedEvent[] = [];
        const raw = event?.type === 'stream_event' && event?.event ? event.event : event;

        const type = firstString(raw?.type, event?.type, raw?.msg?.type, raw?.event);
        const toolName = firstString(raw?.content_block?.name, raw?.name, raw?.tool_name, raw?.msg?.name);
        const toolUseId = firstString(raw?.content_block?.id, raw?.tool_use_id, raw?.id, raw?.msg?.id);
        const toolCommand = firstString(raw?.content_block?.input?.command, raw?.input?.command, raw?.msg?.input?.command);
        const displayName = summarizeToolName(toolName, toolCommand);
        const contentBlocks = Array.isArray(raw?.message?.content)
            ? raw.message.content
            : Array.isArray(event?.message?.content)
                ? event.message.content
                : Array.isArray(raw?.content)
                    ? raw.content
                    : [];
        const toolResults = contentBlocks.filter((block: any) => block?.type === 'tool_result');
        if (
            (raw?.type === 'content_block_start' && raw?.content_block?.type === 'tool_use')
            || (type && /tool/i.test(type))
        ) {
            events.push({
                eventType: /complete|finish|end|result/i.test(type) ? 'tool.completed' : 'tool.started',
                payload: {
                    provider,
                    raw_type: type,
                    name: displayName,
                    tool_name: toolName,
                    tool_use_id: toolUseId,
                },
            });
        } else if (toolResults.length > 0) {
            for (const result of toolResults) {
                events.push({
                    eventType: 'tool.completed',
                    payload: {
                        provider,
                        raw_type: 'tool_result',
                        name: firstString(result?.name, result?.tool_name, 'tool'),
                        tool_use_id: firstString(result?.tool_use_id, result?.id),
                        is_error: Boolean(result?.is_error),
                    },
                });
            }
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

        const parsedRaw = extractActions(assistantText);
        const parsed: ParsedActions = {
            content: cleanAssistantVisibleText(parsedRaw.content),
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

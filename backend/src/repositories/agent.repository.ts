import crypto from 'crypto';
import { DatabaseService } from '../db/database.service';

const DEFAULT_WORKSPACE_ID = 'default';

export type AgentProvider = 'claude_code' | 'codex_cli';
export type AgentSessionStatus = 'created' | 'active' | 'closed' | 'error';
export type AgentRunStatus = 'started' | 'running' | 'completed' | 'cancelled' | 'error';

export type AgentSessionRow = {
    agent_session_id: string;
    workspace_id: string;
    chat_id: string;
    provider: AgentProvider;
    provider_session_id: string | null;
    status: AgentSessionStatus;
    metadata: Record<string, any>;
    created_at: string;
    updated_at: string;
};

export type AgentMessageRow = {
    agent_message_id: string;
    agent_session_id: string;
    role: string;
    content: string;
    content_json: Record<string, any> | null;
    sequence_no: string;
    metadata: Record<string, any>;
    created_at: string;
};

export type AgentRunRow = {
    agent_run_id: string;
    agent_session_id: string;
    provider_run_id: string | null;
    status: AgentRunStatus;
    started_at: string;
    completed_at: string | null;
    metadata: Record<string, any>;
};

export type AgentRunEventRow = {
    agent_run_event_id: string;
    agent_run_id: string;
    sequence_no: string;
    event_type: string;
    payload: Record<string, any>;
    created_at: string;
};

function id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
}

export class AgentRepository {
    constructor(private readonly database: DatabaseService) {}

    private assertReady() {
        if (!this.database.isReady()) {
            throw new Error('Database is required for agent runtime');
        }
    }

    async listSessions(workspaceId = DEFAULT_WORKSPACE_ID): Promise<AgentSessionRow[]> {
        this.assertReady();
        const result = await this.database.query<AgentSessionRow>(
            `
                SELECT agent_session_id, workspace_id, chat_id, provider, provider_session_id, status, metadata, created_at, updated_at
                FROM app.agent_sessions
                WHERE workspace_id = $1
                ORDER BY updated_at DESC, created_at DESC
            `,
            [workspaceId],
        );
        return result?.rows || [];
    }

    async getSession(sessionId: string, workspaceId = DEFAULT_WORKSPACE_ID): Promise<AgentSessionRow | null> {
        this.assertReady();
        const result = await this.database.query<AgentSessionRow>(
            `
                SELECT agent_session_id, workspace_id, chat_id, provider, provider_session_id, status, metadata, created_at, updated_at
                FROM app.agent_sessions
                WHERE agent_session_id = $1 AND workspace_id = $2
                LIMIT 1
            `,
            [sessionId, workspaceId],
        );
        return result?.rows[0] || null;
    }

    async createSession(input: {
        provider: AgentProvider;
        chatId?: string;
        providerSessionId?: string | null;
        metadata?: Record<string, any>;
        workspaceId?: string;
    }): Promise<AgentSessionRow> {
        this.assertReady();
        const sessionId = id('agent_sess');
        const chatId = input.chatId || `chat_${crypto.randomUUID()}`;
        const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
        await this.database.query(
            `
                INSERT INTO app.agent_sessions (
                    agent_session_id,
                    workspace_id,
                    chat_id,
                    provider,
                    provider_session_id,
                    status,
                    metadata,
                    created_at,
                    updated_at
                )
                VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb, now(), now())
            `,
            [
                sessionId,
                workspaceId,
                chatId,
                input.provider,
                input.providerSessionId || null,
                JSON.stringify(input.metadata || {}),
            ],
        );
        const session = await this.getSession(sessionId, workspaceId);
        if (!session) throw new Error('Failed to create agent session');
        return session;
    }

    async updateSession(sessionId: string, patch: {
        status?: AgentSessionStatus;
        providerSessionId?: string | null;
        metadata?: Record<string, any>;
    }): Promise<void> {
        this.assertReady();
        await this.database.query(
            `
                UPDATE app.agent_sessions
                SET
                    status = COALESCE($2, status),
                    provider_session_id = COALESCE($3, provider_session_id),
                    metadata = CASE WHEN $4::jsonb IS NULL THEN metadata ELSE metadata || $4::jsonb END,
                    updated_at = now()
                WHERE agent_session_id = $1
            `,
            [
                sessionId,
                patch.status || null,
                patch.providerSessionId || null,
                patch.metadata ? JSON.stringify(patch.metadata) : null,
            ],
        );
    }

    async listMessages(sessionId: string): Promise<AgentMessageRow[]> {
        this.assertReady();
        const result = await this.database.query<AgentMessageRow>(
            `
                SELECT agent_message_id, agent_session_id, role, content, content_json, sequence_no::text, metadata, created_at
                FROM app.agent_messages
                WHERE agent_session_id = $1
                ORDER BY sequence_no::bigint ASC
            `,
            [sessionId],
        );
        return result?.rows || [];
    }

    async addMessage(input: {
        sessionId: string;
        role: string;
        content: string;
        contentJson?: Record<string, any> | null;
        metadata?: Record<string, any>;
    }): Promise<AgentMessageRow> {
        this.assertReady();
        return this.database.withTransaction(async () => {
            const messageId = id('agent_msg');
            await this.database.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`agent_messages:${input.sessionId}`]);
            const result = await this.database.query<AgentMessageRow>(
                `
                    WITH next_sequence AS (
                        SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence_no
                        FROM app.agent_messages
                        WHERE agent_session_id = $2
                    )
                    INSERT INTO app.agent_messages (
                        agent_message_id,
                        agent_session_id,
                        role,
                        content,
                        content_json,
                        sequence_no,
                        metadata,
                        created_at
                    )
                    SELECT $1, $2, $3, $4, $5::jsonb, next_sequence.sequence_no, $6::jsonb, now()
                    FROM next_sequence
                    RETURNING agent_message_id, agent_session_id, role, content, content_json, sequence_no::text, metadata, created_at
                `,
                [
                    messageId,
                    input.sessionId,
                    input.role,
                    input.content,
                    input.contentJson ? JSON.stringify(input.contentJson) : null,
                    JSON.stringify(input.metadata || {}),
                ],
            );
            const saved = result?.rows[0];
            if (!saved) throw new Error('Failed to save agent message');
            return saved;
        });
    }

    async createRun(sessionId: string, metadata: Record<string, any> = {}): Promise<AgentRunRow> {
        this.assertReady();
        return this.database.withTransaction(async () => {
            await this.database.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`agent_session_run:${sessionId}`]);
            const existing = await this.database.query<{ agent_run_id: string }>(
                `
                    SELECT agent_run_id
                    FROM app.agent_runs
                    WHERE agent_session_id = $1
                      AND status = 'running'
                    LIMIT 1
                `,
                [sessionId],
            );
            if ((existing?.rowCount || 0) > 0) {
                throw new Error('Agent session already has a running request');
            }

            const runId = id('agent_run');
            const result = await this.database.query<AgentRunRow>(
                `
                    INSERT INTO app.agent_runs (
                        agent_run_id,
                        agent_session_id,
                        status,
                        started_at,
                        metadata
                    )
                    VALUES ($1, $2, 'running', now(), $3::jsonb)
                    RETURNING agent_run_id, agent_session_id, provider_run_id, status, started_at, completed_at, metadata
                `,
                [runId, sessionId, JSON.stringify(metadata)],
            );
            const run = result?.rows[0];
            if (!run) throw new Error('Failed to create agent run');
            return run;
        });
    }

    async createRunForPrompt(input: {
        sessionId: string;
        prompt: string;
        runMetadata?: Record<string, any>;
        messageMetadata?: Record<string, any>;
    }): Promise<{ message: AgentMessageRow; run: AgentRunRow }> {
        this.assertReady();
        return this.database.withTransaction(async () => {
            await this.database.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`agent_session_run:${input.sessionId}`]);
            const existing = await this.database.query<{ agent_run_id: string }>(
                `
                    SELECT agent_run_id
                    FROM app.agent_runs
                    WHERE agent_session_id = $1
                      AND status = 'running'
                    LIMIT 1
                `,
                [input.sessionId],
            );
            if ((existing?.rowCount || 0) > 0) {
                throw new Error('Agent session already has a running request');
            }

            const messageId = id('agent_msg');
            const messageResult = await this.database.query<AgentMessageRow>(
                `
                    WITH next_sequence AS (
                        SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence_no
                        FROM app.agent_messages
                        WHERE agent_session_id = $2
                    )
                    INSERT INTO app.agent_messages (
                        agent_message_id,
                        agent_session_id,
                        role,
                        content,
                        content_json,
                        sequence_no,
                        metadata,
                        created_at
                    )
                    SELECT $1, $2, 'user', $3, NULL::jsonb, next_sequence.sequence_no, $4::jsonb, now()
                    FROM next_sequence
                    RETURNING agent_message_id, agent_session_id, role, content, content_json, sequence_no::text, metadata, created_at
                `,
                [
                    messageId,
                    input.sessionId,
                    input.prompt,
                    JSON.stringify(input.messageMetadata || {}),
                ],
            );
            const message = messageResult?.rows[0];
            if (!message) throw new Error('Failed to save agent message');

            const runId = id('agent_run');
            const runResult = await this.database.query<AgentRunRow>(
                `
                    INSERT INTO app.agent_runs (
                        agent_run_id,
                        agent_session_id,
                        status,
                        started_at,
                        metadata
                    )
                    VALUES ($1, $2, 'running', now(), $3::jsonb)
                    RETURNING agent_run_id, agent_session_id, provider_run_id, status, started_at, completed_at, metadata
                `,
                [
                    runId,
                    input.sessionId,
                    JSON.stringify(input.runMetadata || {}),
                ],
            );
            const run = runResult?.rows[0];
            if (!run) throw new Error('Failed to create agent run');
            return { message, run };
        });
    }

    async getRun(runId: string): Promise<AgentRunRow | null> {
        this.assertReady();
        const result = await this.database.query<AgentRunRow>(
            `
                SELECT agent_run_id, agent_session_id, provider_run_id, status, started_at, completed_at, metadata
                FROM app.agent_runs
                WHERE agent_run_id = $1
                LIMIT 1
            `,
            [runId],
        );
        return result?.rows[0] || null;
    }

    async completeRun(runId: string, status: AgentRunStatus, metadata: Record<string, any> = {}): Promise<void> {
        this.assertReady();
        await this.database.query(
            `
                UPDATE app.agent_runs
                SET status = $2,
                    completed_at = now(),
                    metadata = metadata || $3::jsonb
                WHERE agent_run_id = $1
            `,
            [runId, status, JSON.stringify(metadata)],
        );
    }

    async updateRunMetadata(runId: string, metadata: Record<string, any>): Promise<void> {
        this.assertReady();
        await this.database.query(
            `
                UPDATE app.agent_runs
                SET metadata = metadata || $2::jsonb
                WHERE agent_run_id = $1
            `,
            [runId, JSON.stringify(metadata)],
        );
    }

    async interruptRunningRuns(reason: string): Promise<AgentRunRow[]> {
        this.assertReady();
        const result = await this.database.query<AgentRunRow>(
            `
                UPDATE app.agent_runs
                SET status = 'error',
                    completed_at = now(),
                    metadata = metadata || $1::jsonb
                WHERE status = 'running'
                RETURNING agent_run_id, agent_session_id, provider_run_id, status, started_at, completed_at, metadata
            `,
            [
                JSON.stringify({
                    reason,
                    interruptedAt: new Date().toISOString(),
                }),
            ],
        );
        return result?.rows || [];
    }

    async listRunEvents(runId: string, afterSequence = 0): Promise<AgentRunEventRow[]> {
        this.assertReady();
        const result = await this.database.query<AgentRunEventRow>(
            `
                SELECT agent_run_event_id, agent_run_id, sequence_no::text, event_type, payload, created_at
                FROM app.agent_run_events
                WHERE agent_run_id = $1 AND sequence_no > $2
                ORDER BY sequence_no::bigint ASC
            `,
            [runId, afterSequence],
        );
        return result?.rows || [];
    }

    async appendRunEvent(runId: string, eventType: string, payload: Record<string, any>): Promise<AgentRunEventRow> {
        this.assertReady();
        return this.database.withTransaction(async () => {
            const eventId = id('agent_evt');
            await this.database.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`agent_run_events:${runId}`]);
            const result = await this.database.query<AgentRunEventRow>(
                `
                    WITH next_sequence AS (
                        SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence_no
                        FROM app.agent_run_events
                        WHERE agent_run_id = $2
                    )
                    INSERT INTO app.agent_run_events (
                        agent_run_event_id,
                        agent_run_id,
                        sequence_no,
                        event_type,
                        payload,
                        created_at
                    )
                    SELECT $1, $2, next_sequence.sequence_no, $3, $4::jsonb, now()
                    FROM next_sequence
                    RETURNING agent_run_event_id, agent_run_id, sequence_no::text, event_type, payload, created_at
                `,
                [eventId, runId, eventType, JSON.stringify(payload)],
            );
            const saved = result?.rows[0];
            if (!saved) throw new Error('Failed to save agent event');
            return saved;
        });
    }
}

DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT c.conname
    INTO constraint_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app'
      AND t.relname = 'agent_sessions'
      AND c.contype = 'u'
      AND ARRAY(
          SELECT a.attname
          FROM unnest(c.conkey) WITH ORDINALITY AS cols(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = cols.attnum
          ORDER BY cols.ord
      ) = ARRAY['workspace_id', 'chat_id', 'provider'];

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE app.agent_sessions DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_sessions_workspace_chat_idx
    ON app.agent_sessions (workspace_id, chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_sessions_status_idx
    ON app.agent_sessions (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS agent_messages_session_created_idx
    ON app.agent_messages (agent_session_id, created_at);

CREATE INDEX IF NOT EXISTS agent_runs_session_started_idx
    ON app.agent_runs (agent_session_id, started_at DESC);

CREATE INDEX IF NOT EXISTS agent_run_events_run_created_idx
    ON app.agent_run_events (agent_run_id, sequence_no);

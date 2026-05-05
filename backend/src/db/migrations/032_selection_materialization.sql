ALTER TABLE app.selections
    ADD COLUMN IF NOT EXISTS expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS materialized_at timestamptz,
    ADD COLUMN IF NOT EXISTS materialized_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS materialization_status text NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS materialization_error text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'selections_materialization_status_check'
    ) THEN
        ALTER TABLE app.selections
            ADD CONSTRAINT selections_materialization_status_check
            CHECK (materialization_status IN ('none', 'empty', 'materialized', 'partial', 'error'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS selections_expires_at_idx
    ON app.selections (expires_at)
    WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.selection_items (
    selection_id text NOT NULL REFERENCES app.selections(selection_id) ON DELETE CASCADE,
    workspace_id text NOT NULL DEFAULT 'default',
    layer_id text,
    object_kind text NOT NULL CHECK (object_kind IN ('entity', 'event', 'asset')),
    object_id text NOT NULL,
    observed_at timestamptz,
    display_lat double precision,
    display_lng double precision,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (selection_id, object_kind, object_id)
);

CREATE INDEX IF NOT EXISTS selection_items_workspace_idx
    ON app.selection_items (workspace_id, selection_id);

CREATE INDEX IF NOT EXISTS selection_items_layer_idx
    ON app.selection_items (layer_id, object_kind);

CREATE INDEX IF NOT EXISTS selection_items_observed_at_idx
    ON app.selection_items (observed_at DESC);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_agent_readonly') THEN
        GRANT SELECT ON app.selection_items TO app_agent_readonly;
    END IF;
END $$;

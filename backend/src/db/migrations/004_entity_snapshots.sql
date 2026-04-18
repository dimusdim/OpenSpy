ALTER TABLE core.entities
    ADD COLUMN IF NOT EXISTS latest_snapshot_id text;

CREATE TABLE IF NOT EXISTS core.entity_snapshots (
    entity_snapshot_id text PRIMARY KEY,
    entity_id text NOT NULL REFERENCES core.entities(entity_id) ON DELETE CASCADE,
    ingest_run_id text REFERENCES raw.ingest_runs(ingest_run_id) ON DELETE SET NULL,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE RESTRICT,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    entity_kind text NOT NULL,
    subtype text,
    display_name text,
    observed_at timestamptz,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_snapshots_entity_time_idx
    ON core.entity_snapshots (entity_id, observed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS entity_snapshots_layer_time_idx
    ON core.entity_snapshots (layer_id, observed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS entity_snapshots_source_time_idx
    ON core.entity_snapshots (source_id, observed_at DESC, created_at DESC);

INSERT INTO core.entity_snapshots (
    entity_snapshot_id,
    entity_id,
    ingest_run_id,
    layer_id,
    source_id,
    entity_kind,
    subtype,
    display_name,
    observed_at,
    properties,
    created_at
)
SELECT
    'entity-snap-bootstrap:' || entity_id || ':' || substring(md5(entity_id || ':' || COALESCE(updated_at::text, created_at::text)) from 1 for 16),
    entity_id,
    NULL,
    layer_id,
    source_id,
    entity_kind,
    subtype,
    display_name,
    COALESCE(last_observed_at, updated_at, created_at),
    properties,
    created_at
FROM core.entities
ON CONFLICT (entity_snapshot_id)
DO NOTHING;

UPDATE core.entities
SET latest_snapshot_id = COALESCE(
    latest_snapshot_id,
    'entity-snap-bootstrap:' || entity_id || ':' || substring(md5(entity_id || ':' || COALESCE(updated_at::text, created_at::text)) from 1 for 16)
)
WHERE latest_snapshot_id IS NULL;

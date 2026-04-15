ALTER TABLE core.events
    ADD COLUMN IF NOT EXISTS first_observed_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_observed_at timestamptz,
    ADD COLUMN IF NOT EXISTS latest_snapshot_id text;

UPDATE core.events
SET
    first_observed_at = COALESCE(first_observed_at, observed_at, created_at),
    last_observed_at = COALESCE(last_observed_at, observed_at, updated_at, created_at)
WHERE first_observed_at IS NULL
   OR last_observed_at IS NULL;

CREATE TABLE IF NOT EXISTS core.event_snapshots (
    event_snapshot_id text PRIMARY KEY,
    event_id text NOT NULL,
    ingest_run_id text REFERENCES raw.ingest_runs(ingest_run_id) ON DELETE SET NULL,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE RESTRICT,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    event_kind text NOT NULL,
    subtype text,
    observed_at timestamptz,
    valid_from timestamptz,
    valid_to timestamptz,
    geom geometry(Geometry, 4326),
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_snapshots_event_id_idx
    ON core.event_snapshots (event_id, observed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS event_snapshots_layer_time_idx
    ON core.event_snapshots (layer_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS event_snapshots_geom_idx
    ON core.event_snapshots USING GIST (geom);

INSERT INTO core.event_snapshots (
    event_snapshot_id,
    event_id,
    layer_id,
    source_id,
    event_kind,
    subtype,
    observed_at,
    valid_from,
    valid_to,
    geom,
    properties,
    created_at
)
SELECT
    'bootstrap:' || event_id,
    event_id,
    layer_id,
    source_id,
    event_kind,
    subtype,
    observed_at,
    valid_from,
    valid_to,
    geom,
    properties,
    created_at
FROM core.events
ON CONFLICT (event_snapshot_id)
DO NOTHING;

UPDATE core.events
SET latest_snapshot_id = COALESCE(latest_snapshot_id, 'bootstrap:' || event_id)
WHERE latest_snapshot_id IS NULL;

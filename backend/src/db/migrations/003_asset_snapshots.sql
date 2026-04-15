ALTER TABLE core.assets
    ADD COLUMN IF NOT EXISTS first_observed_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_observed_at timestamptz,
    ADD COLUMN IF NOT EXISTS latest_snapshot_id text;

UPDATE core.assets
SET
    first_observed_at = COALESCE(first_observed_at, created_at),
    last_observed_at = COALESCE(last_observed_at, updated_at, created_at)
WHERE first_observed_at IS NULL
   OR last_observed_at IS NULL;

CREATE TABLE IF NOT EXISTS core.asset_snapshots (
    asset_snapshot_id text PRIMARY KEY,
    asset_id text NOT NULL REFERENCES core.assets(asset_id) ON DELETE CASCADE,
    ingest_run_id text REFERENCES raw.ingest_runs(ingest_run_id) ON DELETE SET NULL,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE RESTRICT,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    asset_kind text NOT NULL,
    subtype text,
    display_name text,
    observed_at timestamptz,
    geom geometry(Geometry, 4326),
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_snapshots_asset_time_idx
    ON core.asset_snapshots (asset_id, observed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_snapshots_layer_time_idx
    ON core.asset_snapshots (layer_id, observed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_snapshots_source_time_idx
    ON core.asset_snapshots (source_id, observed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_snapshots_geom_idx
    ON core.asset_snapshots USING GIST (geom);

INSERT INTO core.asset_snapshots (
    asset_snapshot_id,
    asset_id,
    ingest_run_id,
    layer_id,
    source_id,
    asset_kind,
    subtype,
    display_name,
    observed_at,
    geom,
    properties,
    created_at
)
SELECT
    'asset-snap-bootstrap:' || asset_id || ':' || substring(md5(asset_id || ':' || COALESCE(updated_at::text, created_at::text)) from 1 for 16),
    asset_id,
    NULL,
    layer_id,
    source_id,
    asset_kind,
    subtype,
    display_name,
    COALESCE(last_observed_at, updated_at, created_at),
    geom,
    properties,
    created_at
FROM core.assets
ON CONFLICT (asset_snapshot_id)
DO NOTHING;

UPDATE core.assets
SET latest_snapshot_id = COALESCE(
    latest_snapshot_id,
    'asset-snap-bootstrap:' || asset_id || ':' || substring(md5(asset_id || ':' || COALESCE(updated_at::text, created_at::text)) from 1 for 16)
)
WHERE latest_snapshot_id IS NULL;

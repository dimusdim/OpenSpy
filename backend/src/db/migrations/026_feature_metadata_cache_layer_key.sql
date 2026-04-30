-- 026_feature_metadata_cache_layer_key.sql
-- Keep historical details cache rows isolated by layer. This protects
-- different layers that reuse the same upstream feature id.
-- This intentionally reaffirms the layer-aware key introduced in 016 because
-- the replay/details cache contract is safety-critical and older local DBs may
-- have applied intermediate branches with the old two-column upsert shape.

ALTER TABLE app.feature_metadata_cache
    DROP CONSTRAINT IF EXISTS feature_metadata_cache_pkey;

ALTER TABLE app.feature_metadata_cache
    ADD CONSTRAINT feature_metadata_cache_pkey
    PRIMARY KEY (feature_kind, feature_id, layer_id, as_of);

DROP INDEX IF EXISTS feature_metadata_cache_feature_asof_idx;

CREATE INDEX IF NOT EXISTS feature_metadata_cache_feature_asof_idx
    ON app.feature_metadata_cache (feature_kind, feature_id, layer_id, as_of DESC);

COMMENT ON TABLE app.feature_metadata_cache IS
    'On-demand feature details cache. Historical rows are keyed by (feature_kind, feature_id, layer_id, as_of); writers must not upsert on (feature_kind, feature_id) only.';

CREATE OR REPLACE FUNCTION app.upsert_feature_metadata_cache(
    p_feature_kind text,
    p_feature_id text,
    p_layer_id text,
    p_as_of timestamptz,
    p_metadata jsonb,
    p_source_observed_at timestamptz,
    p_content_hash text,
    p_expires_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE sql
AS $$
    INSERT INTO app.feature_metadata_cache (
        feature_kind,
        feature_id,
        layer_id,
        as_of,
        metadata,
        source_observed_at,
        content_hash,
        built_at,
        expires_at
    )
    VALUES (
        p_feature_kind,
        p_feature_id,
        p_layer_id,
        COALESCE(p_as_of, '-infinity'::timestamptz),
        COALESCE(p_metadata, '{}'::jsonb),
        p_source_observed_at,
        p_content_hash,
        now(),
        p_expires_at
    )
    ON CONFLICT (feature_kind, feature_id, layer_id, as_of)
    DO UPDATE SET
        metadata = EXCLUDED.metadata,
        source_observed_at = EXCLUDED.source_observed_at,
        content_hash = EXCLUDED.content_hash,
        built_at = now(),
        expires_at = EXCLUDED.expires_at;
$$;

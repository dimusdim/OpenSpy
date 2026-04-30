-- 022_feature_metadata_cache_contract.sql
-- Document and enforce the historical details-cache key introduced in 016.

COMMENT ON TABLE app.feature_metadata_cache IS
    'On-demand feature details cache. Historical rows are keyed by (feature_kind, feature_id, layer_id, as_of); writers must not upsert on (feature_kind, feature_id) only.';

COMMENT ON COLUMN app.feature_metadata_cache.as_of IS
    'Historical point-in-time this metadata row describes. Use -infinity for timeless/live-latest metadata.';

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

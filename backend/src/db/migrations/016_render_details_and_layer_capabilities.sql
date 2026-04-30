-- 016_render_details_and_layer_capabilities.sql
-- Make replay details explicitly historical and mark live-only layers so
-- replay hydration can ignore contextual overlays.

ALTER TABLE app.feature_metadata_cache
    ADD COLUMN IF NOT EXISTS as_of timestamptz;

UPDATE app.feature_metadata_cache
SET as_of = COALESCE(source_observed_at, '-infinity'::timestamptz)
WHERE as_of IS NULL;

ALTER TABLE app.feature_metadata_cache
    ALTER COLUMN as_of SET DEFAULT '-infinity'::timestamptz,
    ALTER COLUMN as_of SET NOT NULL;

ALTER TABLE app.feature_metadata_cache
    DROP CONSTRAINT IF EXISTS feature_metadata_cache_pkey;

ALTER TABLE app.feature_metadata_cache
    ADD CONSTRAINT feature_metadata_cache_pkey
    PRIMARY KEY (feature_kind, feature_id, layer_id, as_of);

CREATE INDEX IF NOT EXISTS feature_metadata_cache_feature_asof_idx
    ON app.feature_metadata_cache (feature_kind, feature_id, layer_id, as_of DESC);

CREATE INDEX IF NOT EXISTS render_chunk_index_mode_layer_hash_idx
    ON app.render_chunk_index (mode, layer_id, content_hash);

UPDATE catalog.layers
SET
    history_mode = 'time_series',
    coverage_scope = 'global',
    capabilities = capabilities || jsonb_build_object(
        'replay', true,
        'replayBlocking', true,
        'renderBatch', true,
        'detailsOnDemand', true,
        'motionModel', 'observed_fixes'
    ),
    updated_at = now()
WHERE layer_id IN ('aircraft', 'vessel');

UPDATE catalog.layers
SET
    history_mode = 'ephemeris',
    coverage_scope = 'global',
    capabilities = capabilities || jsonb_build_object(
        'replay', true,
        'replayBlocking', true,
        'renderBatch', true,
        'detailsOnDemand', true,
        'motionModel', 'tle_sgp4'
    ),
    updated_at = now()
WHERE layer_id = 'satellite';

UPDATE catalog.layers
SET
    history_mode = 'event_snapshots',
    coverage_scope = 'global',
    capabilities = capabilities || jsonb_build_object(
        'replay', true,
        'replayBlocking', false,
        'renderBatch', true,
        'detailsOnDemand', true,
        'motionModel', 'none'
    ),
    updated_at = now()
WHERE layer_id IN ('fire', 'conflict', 'disasters', 'outage', 'jamming', 'gfw');

UPDATE catalog.layers
SET
    history_mode = 'versioned_assets',
    coverage_scope = 'global',
    capabilities = capabilities || jsonb_build_object(
        'replay', true,
        'replayBlocking', false,
        'renderBatch', true,
        'detailsOnDemand', true,
        'motionModel', 'none'
    ),
    updated_at = now()
WHERE layer_id IN ('airspace', 'cable', 'pipeline', 'border');

UPDATE catalog.layers
SET
    history_mode = 'none',
    capabilities = capabilities || jsonb_build_object(
        'replay', false,
        'replayBlocking', false,
        'renderBatch', false,
        'detailsOnDemand', false,
        'liveOnly', true
    ),
    updated_at = now()
WHERE layer_id IN (
    'traffic',
    'webcam',
    'imagery-overlay',
    'infrastructure',
    'widget-oilpriceswidget',
    'data-layer-no-map-visual',
    'not-active-code-exists-but-not-started',
    'not-integrated',
    'not-integrated-service-deleted',
    'ui-feature-not-a-data-source'
);

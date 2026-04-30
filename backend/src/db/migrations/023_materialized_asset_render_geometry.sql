-- 023_materialized_asset_render_geometry.sql
-- Precompute low-LOD render geometry for heavy static/semi-static assets.

ALTER TABLE core.assets
    ADD COLUMN IF NOT EXISTS geom_render_low geometry(Geometry, 4326);

ALTER TABLE core.asset_snapshots
    ADD COLUMN IF NOT EXISTS geom_render_low geometry(Geometry, 4326);

UPDATE core.assets
SET geom_render_low = CASE
    WHEN layer_id = 'airspace' THEN ST_SimplifyPreserveTopology(geom, 0.03)
    WHEN layer_id IN ('pipeline', 'cable') THEN ST_SimplifyPreserveTopology(geom, 0.02)
    ELSE geom
END
WHERE geom IS NOT NULL
  AND geom_render_low IS NULL;

UPDATE core.asset_snapshots
SET geom_render_low = CASE
    WHEN layer_id = 'airspace' THEN ST_SimplifyPreserveTopology(geom, 0.03)
    WHEN layer_id IN ('pipeline', 'cable') THEN ST_SimplifyPreserveTopology(geom, 0.02)
    ELSE geom
END
WHERE geom IS NOT NULL
  AND geom_render_low IS NULL
  AND observed_at >= now() - INTERVAL '59 days';

CREATE INDEX IF NOT EXISTS assets_geom_render_low_idx
    ON core.assets USING GIST (geom_render_low)
    WHERE geom_render_low IS NOT NULL;

CREATE INDEX IF NOT EXISTS asset_snapshots_geom_render_low_idx
    ON core.asset_snapshots USING GIST (geom_render_low)
    WHERE geom_render_low IS NOT NULL;

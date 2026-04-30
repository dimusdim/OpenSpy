-- 025_materialized_event_render_geometry.sql
-- Generic materialized render geometry for polygon-heavy event replay layers.
-- Layer-specific tolerances live in config/layer-contracts.json and are applied
-- by SourcePersistenceService when event snapshots are written.

ALTER TABLE core.events
    ADD COLUMN IF NOT EXISTS geom_render_low geometry(Geometry, 4326);

ALTER TABLE core.event_snapshots
    ADD COLUMN IF NOT EXISTS geom_render_low geometry(Geometry, 4326);

CREATE INDEX IF NOT EXISTS events_geom_render_low_idx
    ON core.events USING GIST (geom_render_low)
    WHERE geom_render_low IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_snapshots_geom_render_low_idx
    ON core.event_snapshots USING GIST (geom_render_low)
    WHERE geom_render_low IS NOT NULL;

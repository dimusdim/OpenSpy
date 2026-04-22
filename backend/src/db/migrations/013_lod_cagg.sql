-- 013_lod_cagg.sql
-- Continuous aggregate for 5-minute LOD of position fixes.
-- Used by /api/trajectories when data age > 30d and window > 2h.

CREATE MATERIALIZED VIEW app.ca_position_fixes_5min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('5 minutes', observed_at) AS bucket,
       layer_id, entity_id,
       last(geom, observed_at)        AS last_geom,
       last(altitude_m, observed_at)  AS last_alt,
       last(speed_mps, observed_at)   AS last_speed,
       last(heading_deg, observed_at) AS last_heading,
       max(observed_at)                AS last_observed_at,
       count(*)                       AS n_samples
FROM core.position_fixes
GROUP BY bucket, layer_id, entity_id
WITH NO DATA;

CREATE INDEX IF NOT EXISTS ca_pf_5min_layer_bucket_idx
  ON app.ca_position_fixes_5min (layer_id, bucket DESC);
CREATE INDEX IF NOT EXISTS ca_pf_5min_entity_bucket_idx
  ON app.ca_position_fixes_5min (entity_id, bucket DESC);
CREATE INDEX IF NOT EXISTS ca_pf_5min_geom_idx
  ON app.ca_position_fixes_5min USING GIST (last_geom);

SELECT add_continuous_aggregate_policy('app.ca_position_fixes_5min',
        start_offset => INTERVAL '180 days',
        end_offset   => INTERVAL '5 minutes',
        schedule_interval => INTERVAL '1 minute');

SELECT add_retention_policy('app.ca_position_fixes_5min', INTERVAL '180 days',
        if_not_exists => TRUE);

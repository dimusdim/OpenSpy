-- 037_drop_dead_indexes.sql
-- Drop indexes verified near-zero-scan against the live cluster (chunk-aggregated
-- idx_scan from pg_stat_user_indexes). Frees ~1 GB of index bytes and speeds
-- inserts on the hot ingest path. Every index here is recreatable and no table
-- data is touched. Hot indexes (position_fixes_layer_entity_time_idx 2.3M scans,
-- position_fixes_entity_time_idx 1.2M, all pkeys) are intentionally kept.

-- position_fixes: layer_time_entity 4.1k scans (337 MB) and geom 72 scans (161 MB)
-- are redundant next to the hot layer_entity_time / entity_time indexes.
DROP INDEX IF EXISTS core.position_fixes_layer_time_entity_idx;
DROP INDEX IF EXISTS core.position_fixes_geom_idx;

-- entity_snapshots: 0 scans.
DROP INDEX IF EXISTS core.entity_snapshots_entity_time_idx;
DROP INDEX IF EXISTS core.entity_snapshots_source_time_idx;

-- entity_live_states geom: 0 scans, and it blocks HOT updates on a table that
-- takes ~14.5M updates over the sample window (only ~2.9% HOT).
DROP INDEX IF EXISTS app.idx_entity_live_states_geom;

-- LOD cagg secondary indexes: 0 scans (geom 193 MB, entity_bucket 263 MB). The
-- layer_id + bucket predicate in the trajectory queries is selective enough; the
-- kept layer/bucket index covers them. These physically live in the internal
-- materialized-hypertable schema.
DROP INDEX IF EXISTS _timescaledb_internal.ca_pf_5min_geom_idx;
DROP INDEX IF EXISTS _timescaledb_internal.ca_pf_5min_entity_bucket_idx;

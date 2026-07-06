-- 036_compression_retention_tuning.sql
-- Shorten the hot uncompressed window on the highest-volume hypertables and fix
-- the 5-minute LOD continuous aggregate. This is an explicit, documented policy
-- change, NOT a data cap: all live/replay data stays fully queryable, compression
-- is transparent, and retention windows are unchanged except where noted.

-- 1) Shorten compress_after on the hottest hypertables.
--    position_fixes at ~4.5 GB/day uncompressed dominated disk; 3 days keeps a
--    small hot window and lets the 9.5x columnstore compression reclaim the rest.
SELECT remove_compression_policy('core.position_fixes', if_exists => true);
SELECT add_compression_policy('core.position_fixes', INTERVAL '3 days');

SELECT remove_compression_policy('core.entity_snapshots', if_exists => true);
SELECT add_compression_policy('core.entity_snapshots', INTERVAL '7 days');

SELECT remove_compression_policy('core.event_snapshots', if_exists => true);
SELECT add_compression_policy('core.event_snapshots', INTERVAL '7 days');

-- 2) asset_snapshots had compression but no retention (gap in 012). Match its
--    siblings' 730-day window so it does not grow unbounded.
SELECT add_retention_policy('core.asset_snapshots', INTERVAL '730 days', if_not_exists => true);

-- 3) Fix the 5-min LOD continuous aggregate refresh policy.
--    Old policy (start_offset 180d, schedule 1min) rescanned 180 days every run;
--    overlapping runs produced ~37% failed jobs. Narrow the refresh window and
--    slow the cadence. The invalidation log still captures late-arriving edits
--    inside the 14-day window, and materialized_only=false serves fresher reads.
SELECT remove_continuous_aggregate_policy('app.ca_position_fixes_5min', if_not_exists => true);
SELECT add_continuous_aggregate_policy('app.ca_position_fixes_5min',
        start_offset      => INTERVAL '14 days',
        end_offset        => INTERVAL '5 minutes',
        schedule_interval => INTERVAL '15 minutes');

-- 4) Enable compression on the LOD cagg (was uncompressed ~1.1 GB).
ALTER MATERIALIZED VIEW app.ca_position_fixes_5min SET (timescaledb.compress = true);
SELECT add_compression_policy('app.ca_position_fixes_5min',
        compress_after => INTERVAL '7 days', if_not_exists => true);

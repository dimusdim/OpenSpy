-- 012_compression_retention.sql
-- Enable columnstore compression and retention policies on hypertables.

ALTER TABLE core.position_fixes SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'layer_id',
  timescaledb.compress_orderby = 'entity_id ASC, observed_at DESC'
);
SELECT add_compression_policy('core.position_fixes', INTERVAL '30 days');
SELECT add_retention_policy  ('core.position_fixes', INTERVAL '365 days');

ALTER TABLE core.entity_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'layer_id',
  timescaledb.compress_orderby = 'entity_id ASC, observed_at DESC'
);
SELECT add_compression_policy('core.entity_snapshots', INTERVAL '30 days');
SELECT add_retention_policy  ('core.entity_snapshots', INTERVAL '730 days');

ALTER TABLE core.event_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'layer_id',
  timescaledb.compress_orderby = 'observed_at DESC'
);
SELECT add_compression_policy('core.event_snapshots', INTERVAL '30 days');
SELECT add_retention_policy  ('core.event_snapshots', INTERVAL '730 days');

ALTER TABLE core.asset_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'layer_id',
  timescaledb.compress_orderby = 'asset_id, observed_at DESC'
);
SELECT add_compression_policy('core.asset_snapshots', INTERVAL '60 days');

ALTER TABLE core.orbital_elements SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'norad_id',
  timescaledb.compress_orderby = 'observed_at DESC'
);
SELECT add_compression_policy('core.orbital_elements', INTERVAL '30 days');
SELECT add_retention_policy  ('core.orbital_elements', INTERVAL '180 days');

-- 011_hypertables.sql
-- Convert snapshot/position time-series tables to TimescaleDB hypertables.
-- Tables must be empty (TRUNCATEd) and have observed_at in the PK (009).

SELECT create_hypertable('core.position_fixes',   'observed_at',
        chunk_time_interval => INTERVAL '1 day',   if_not_exists => TRUE,
        migrate_data => FALSE, create_default_indexes => FALSE);

SELECT create_hypertable('core.entity_snapshots', 'observed_at',
        chunk_time_interval => INTERVAL '7 days',  if_not_exists => TRUE,
        migrate_data => FALSE, create_default_indexes => FALSE);

SELECT create_hypertable('core.event_snapshots',  'observed_at',
        chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE,
        migrate_data => FALSE, create_default_indexes => FALSE);

SELECT create_hypertable('core.asset_snapshots',  'observed_at',
        chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE,
        migrate_data => FALSE, create_default_indexes => FALSE);

SELECT create_hypertable('core.orbital_elements', 'observed_at',
        chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE,
        migrate_data => FALSE, create_default_indexes => FALSE);

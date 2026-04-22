-- 010_extensions.sql
-- Install TimescaleDB and btree_gist. Requires
-- shared_preload_libraries='timescaledb' and a PG restart (handled in ops).

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE INDEX IF NOT EXISTS entity_aliases_entity_id_idx
    ON core.entity_aliases (entity_id);

CREATE INDEX IF NOT EXISTS raw_payloads_ingest_run_id_idx
    ON raw.raw_payloads (ingest_run_id);

CREATE INDEX IF NOT EXISTS entity_snapshots_ingest_run_id_idx
    ON core.entity_snapshots (ingest_run_id);

CREATE INDEX IF NOT EXISTS event_snapshots_ingest_run_id_idx
    ON core.event_snapshots (ingest_run_id);

CREATE INDEX IF NOT EXISTS asset_snapshots_ingest_run_id_idx
    ON core.asset_snapshots (ingest_run_id);

CREATE INDEX IF NOT EXISTS ingest_runs_started_completed_idx
    ON raw.ingest_runs (started_at DESC, completed_at DESC);

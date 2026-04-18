CREATE INDEX IF NOT EXISTS position_fixes_layer_entity_time_idx
    ON core.position_fixes (layer_id, entity_id, observed_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS entity_snapshots_entity_effective_time_idx
    ON core.entity_snapshots (entity_id, (COALESCE(observed_at, created_at)) DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS entity_snapshots_layer_entity_effective_time_idx
    ON core.entity_snapshots (layer_id, entity_id, (COALESCE(observed_at, created_at)) DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS event_snapshots_layer_event_effective_time_idx
    ON core.event_snapshots (layer_id, event_id, (COALESCE(observed_at, valid_from, created_at)) DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS asset_snapshots_layer_asset_effective_time_idx
    ON core.asset_snapshots (layer_id, asset_id, (COALESCE(observed_at, created_at)) DESC, created_at DESC);

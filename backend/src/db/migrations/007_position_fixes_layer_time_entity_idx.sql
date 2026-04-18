CREATE INDEX IF NOT EXISTS position_fixes_layer_time_entity_idx
ON core.position_fixes (layer_id, observed_at DESC, entity_id, created_at DESC);

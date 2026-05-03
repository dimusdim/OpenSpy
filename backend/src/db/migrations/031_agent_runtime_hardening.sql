UPDATE app.agent_runs
SET status = 'error',
    completed_at = COALESCE(completed_at, now()),
    metadata = metadata || jsonb_build_object(
        'reason', 'migration_running_run_cleanup',
        'interruptedAt', now()
    )
WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_running_per_session_idx
    ON app.agent_runs (agent_session_id)
    WHERE status = 'running';

REVOKE SELECT ON ALL TABLES IN SCHEMA app FROM app_agent_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE SELECT ON TABLES FROM app_agent_readonly;

GRANT USAGE ON SCHEMA app TO app_agent_readonly;
GRANT SELECT ON
    app.layer_runtime_states,
    app.selections,
    app.view_states,
    app.entity_live_states,
    app.replay_tile_index,
    app.render_chunk_index,
    app.render_chunk_feature_index,
    app.feature_metadata_cache,
    app.wifi_observations,
    app.wifi_observation_history,
    app.wifi_viewport_tiles,
    app.wifi_observation_tiles
TO app_agent_readonly;

DO $$
BEGIN
    EXECUTE format('GRANT app_agent_readonly TO %I', current_user);
END $$;

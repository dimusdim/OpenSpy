DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_agent_readonly') THEN
        CREATE ROLE app_agent_readonly NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA raw, core, catalog, app TO app_agent_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA raw, core, catalog TO app_agent_readonly;
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
ALTER DEFAULT PRIVILEGES IN SCHEMA raw GRANT SELECT ON TABLES TO app_agent_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT ON TABLES TO app_agent_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT ON TABLES TO app_agent_readonly;

DO $$
BEGIN
    EXECUTE format('GRANT app_agent_readonly TO %I', current_user);
END $$;

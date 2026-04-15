CREATE TABLE IF NOT EXISTS app.entity_live_states (
    entity_id text PRIMARY KEY REFERENCES core.entities(entity_id) ON DELETE CASCADE,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id),
    source_id text NULL REFERENCES catalog.sources(source_id),
    observed_at timestamptz NOT NULL,
    geom geometry(Point, 4326) NOT NULL,
    altitude_m double precision NULL,
    heading_deg double precision NULL,
    speed_mps double precision NULL,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_live_states_layer_observed_at
    ON app.entity_live_states(layer_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_live_states_source_observed_at
    ON app.entity_live_states(source_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_live_states_geom
    ON app.entity_live_states
    USING GIST(geom);

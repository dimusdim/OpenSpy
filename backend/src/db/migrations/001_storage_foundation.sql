CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS catalog.sources (
    source_id text PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    display_name text NOT NULL,
    provider_kind text NOT NULL,
    status text NOT NULL DEFAULT 'defined',
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.layers (
    layer_id text PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    display_name text NOT NULL,
    layer_type text NOT NULL,
    geometry_kind text,
    history_mode text NOT NULL DEFAULT 'none',
    coverage_scope text NOT NULL DEFAULT 'unknown',
    completeness_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
    capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.layer_sources (
    layer_source_id text PRIMARY KEY,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE CASCADE,
    source_id text NOT NULL REFERENCES catalog.sources(source_id) ON DELETE CASCADE,
    binding_kind text NOT NULL DEFAULT 'primary',
    priority integer NOT NULL DEFAULT 100,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (layer_id, source_id, binding_kind)
);

CREATE TABLE IF NOT EXISTS catalog.layer_fields (
    layer_field_id text PRIMARY KEY,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE CASCADE,
    field_key text NOT NULL,
    field_type text NOT NULL,
    semantic_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    filterable boolean NOT NULL DEFAULT false,
    aggregatable boolean NOT NULL DEFAULT false,
    nullable boolean NOT NULL DEFAULT true,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (layer_id, field_key)
);

CREATE TABLE IF NOT EXISTS catalog.layer_relations (
    layer_relation_id text PRIMARY KEY,
    from_layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE CASCADE,
    to_layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE CASCADE,
    relation_type text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.ui_taxonomy_nodes (
    node_id text PRIMARY KEY,
    parent_node_id text REFERENCES catalog.ui_taxonomy_nodes(node_id) ON DELETE CASCADE,
    node_kind text NOT NULL,
    slug text NOT NULL UNIQUE,
    label text NOT NULL,
    layer_id text REFERENCES catalog.layers(layer_id) ON DELETE SET NULL,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    icon_key text,
    sort_order integer NOT NULL DEFAULT 0,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.entities (
    entity_id text PRIMARY KEY,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE RESTRICT,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    entity_kind text NOT NULL,
    subtype text,
    display_name text,
    first_observed_at timestamptz,
    last_observed_at timestamptz,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.entity_aliases (
    entity_alias_id text PRIMARY KEY,
    entity_id text NOT NULL REFERENCES core.entities(entity_id) ON DELETE CASCADE,
    alias_type text NOT NULL,
    alias_value text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (alias_type, alias_value)
);

CREATE TABLE IF NOT EXISTS core.position_fixes (
    position_fix_id text PRIMARY KEY,
    entity_id text NOT NULL REFERENCES core.entities(entity_id) ON DELETE CASCADE,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE RESTRICT,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    observed_at timestamptz NOT NULL,
    geom geometry(Point, 4326) NOT NULL,
    altitude_m double precision,
    heading_deg double precision,
    speed_mps double precision,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS position_fixes_entity_time_idx
    ON core.position_fixes (entity_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS position_fixes_geom_idx
    ON core.position_fixes USING GIST (geom);

CREATE TABLE IF NOT EXISTS core.events (
    event_id text PRIMARY KEY,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE RESTRICT,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    event_kind text NOT NULL,
    subtype text,
    observed_at timestamptz,
    valid_from timestamptz,
    valid_to timestamptz,
    geom geometry(Geometry, 4326),
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_observed_at_idx
    ON core.events (observed_at DESC);
CREATE INDEX IF NOT EXISTS events_geom_idx
    ON core.events USING GIST (geom);

CREATE TABLE IF NOT EXISTS core.assets (
    asset_id text PRIMARY KEY,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE RESTRICT,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    asset_kind text NOT NULL,
    subtype text,
    display_name text,
    geom geometry(Geometry, 4326),
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_geom_idx
    ON core.assets USING GIST (geom);

CREATE TABLE IF NOT EXISTS core.observations (
    observation_id text PRIMARY KEY,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE RESTRICT,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    observation_kind text NOT NULL,
    observed_at timestamptz NOT NULL,
    geom geometry(Geometry, 4326),
    metric_value double precision,
    unit text,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS observations_time_idx
    ON core.observations (observed_at DESC);
CREATE INDEX IF NOT EXISTS observations_geom_idx
    ON core.observations USING GIST (geom);

CREATE TABLE IF NOT EXISTS core.regions (
    region_id text PRIMARY KEY,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    region_kind text NOT NULL,
    slug text UNIQUE,
    display_name text NOT NULL,
    geom geometry(MultiPolygon, 4326),
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS regions_geom_idx
    ON core.regions USING GIST (geom);

CREATE TABLE IF NOT EXISTS core.orbital_elements (
    orbital_element_id text PRIMARY KEY,
    entity_id text REFERENCES core.entities(entity_id) ON DELETE CASCADE,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    observed_at timestamptz NOT NULL,
    norad_id text,
    tle_line1 text,
    tle_line2 text,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orbital_elements_entity_time_idx
    ON core.orbital_elements (entity_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS raw.ingest_runs (
    ingest_run_id text PRIMARY KEY,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    layer_id text REFERENCES catalog.layers(layer_id) ON DELETE SET NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    status text NOT NULL DEFAULT 'started',
    record_count integer NOT NULL DEFAULT 0,
    error_message text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS raw.raw_payloads (
    raw_payload_id text PRIMARY KEY,
    ingest_run_id text REFERENCES raw.ingest_runs(ingest_run_id) ON DELETE SET NULL,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE SET NULL,
    layer_id text REFERENCES catalog.layers(layer_id) ON DELETE SET NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    upstream_id text,
    payload jsonb NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS raw_payloads_observed_at_idx
    ON raw.raw_payloads (observed_at DESC);

CREATE TABLE IF NOT EXISTS app.layer_runtime_states (
    layer_runtime_state_id text PRIMARY KEY,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE CASCADE,
    source_id text REFERENCES catalog.sources(source_id) ON DELETE CASCADE,
    state_scope text NOT NULL DEFAULT 'layer',
    status text NOT NULL,
    note text,
    count integer,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    observed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (layer_id, source_id, state_scope)
);

CREATE TABLE IF NOT EXISTS app.selections (
    selection_id text PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default',
    layer_id text REFERENCES catalog.layers(layer_id) ON DELETE SET NULL,
    selection_mode text NOT NULL DEFAULT 'filter',
    predicate jsonb NOT NULL DEFAULT '{}'::jsonb,
    geometry geometry(Geometry, 4326),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS selections_geom_idx
    ON app.selections USING GIST (geometry);

CREATE TABLE IF NOT EXISTS app.view_states (
    view_state_id text PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default',
    chat_id text,
    requested_tile_mode text,
    effective_tile_mode text,
    state jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, view_state_id)
);

CREATE TABLE IF NOT EXISTS app.agent_sessions (
    agent_session_id text PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default',
    chat_id text NOT NULL,
    provider text NOT NULL,
    provider_session_id text,
    status text NOT NULL DEFAULT 'created',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, chat_id, provider)
);

CREATE TABLE IF NOT EXISTS app.agent_messages (
    agent_message_id text PRIMARY KEY,
    agent_session_id text NOT NULL REFERENCES app.agent_sessions(agent_session_id) ON DELETE CASCADE,
    role text NOT NULL,
    content text NOT NULL DEFAULT '',
    content_json jsonb,
    sequence_no bigint NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_session_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS app.agent_runs (
    agent_run_id text PRIMARY KEY,
    agent_session_id text NOT NULL REFERENCES app.agent_sessions(agent_session_id) ON DELETE CASCADE,
    provider_run_id text,
    status text NOT NULL DEFAULT 'started',
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS app.agent_run_events (
    agent_run_event_id text PRIMARY KEY,
    agent_run_id text NOT NULL REFERENCES app.agent_runs(agent_run_id) ON DELETE CASCADE,
    sequence_no bigint NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_run_id, sequence_no)
);


-- 014_render_chunks_and_feature_metadata.sql
-- Server-built render batches for replay/live drawing, plus on-demand
-- feature metadata lookup for cards/details.

CREATE TABLE IF NOT EXISTS app.render_chunk_index (
    render_chunk_id text PRIMARY KEY,
    mode text NOT NULL CHECK (mode IN ('replay', 'live')),
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE CASCADE,
    renderer_kind text NOT NULL CHECK (renderer_kind IN (
        'points-v1',
        'lines-v1',
        'polygons-v1',
        'mixed-v1',
        'moving-points-delta-v1'
    )),
    format_version integer NOT NULL DEFAULT 1 CHECK (format_version > 0),

    -- Tile identity. z/x/y = 0/0/0 is the whole-world render chunk.
    z smallint NOT NULL DEFAULT 0 CHECK (z >= 0),
    x integer NOT NULL DEFAULT 0 CHECK (x >= 0),
    y integer NOT NULL DEFAULT 0 CHECK (y >= 0),
    t_bucket timestamptz NOT NULL,
    bucket_seconds integer NOT NULL CHECK (bucket_seconds > 0),
    lod text NOT NULL DEFAULT 'world',
    bbox geometry(Polygon, 4326),

    -- Binary location. Start with local files; storage_kind=url makes the
    -- contract portable to object storage/CDN without schema churn.
    storage_kind text NOT NULL DEFAULT 'file' CHECK (storage_kind IN ('file', 'object', 'db')),
    storage_url text,
    payload bytea,
    content_hash text NOT NULL,
    byte_length bigint NOT NULL CHECK (byte_length >= 0),

    -- Render counts, not domain object counts.
    feature_count integer NOT NULL DEFAULT 0 CHECK (feature_count >= 0),
    point_count integer NOT NULL DEFAULT 0 CHECK (point_count >= 0),
    line_vertex_count integer NOT NULL DEFAULT 0 CHECK (line_vertex_count >= 0),
    fill_vertex_count integer NOT NULL DEFAULT 0 CHECK (fill_vertex_count >= 0),
    fill_index_count integer NOT NULL DEFAULT 0 CHECK (fill_index_count >= 0),

    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    built_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,

    CHECK (
        (storage_kind = 'db' AND payload IS NOT NULL)
        OR (storage_kind <> 'db' AND storage_url IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS render_chunk_index_identity_idx
    ON app.render_chunk_index (
        mode,
        layer_id,
        renderer_kind,
        format_version,
        z,
        x,
        y,
        t_bucket,
        lod
    );

CREATE INDEX IF NOT EXISTS render_chunk_index_layer_time_idx
    ON app.render_chunk_index (mode, layer_id, t_bucket DESC, z, x, y);

CREATE INDEX IF NOT EXISTS render_chunk_index_hash_idx
    ON app.render_chunk_index (content_hash);

CREATE INDEX IF NOT EXISTS render_chunk_index_bbox_idx
    ON app.render_chunk_index USING GIST (bbox);

CREATE INDEX IF NOT EXISTS render_chunk_index_expires_at_idx
    ON app.render_chunk_index (expires_at)
    WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.render_chunk_feature_index (
    render_chunk_id text NOT NULL REFERENCES app.render_chunk_index(render_chunk_id) ON DELETE CASCADE,
    local_feature_index integer NOT NULL CHECK (local_feature_index >= 0),
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE CASCADE,
    feature_kind text NOT NULL CHECK (feature_kind IN ('entity', 'event', 'asset')),
    feature_id text NOT NULL,

    -- Optional render-facing fields. These are for picking and diagnostics;
    -- card/detail fields stay in core snapshots or feature_metadata_cache.
    render_feature_id bigint,
    style_id integer,
    display_label text,
    bbox geometry(Geometry, 4326),
    observed_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

    PRIMARY KEY (render_chunk_id, local_feature_index)
);

CREATE INDEX IF NOT EXISTS render_chunk_feature_index_feature_idx
    ON app.render_chunk_feature_index (feature_kind, feature_id);

CREATE INDEX IF NOT EXISTS render_chunk_feature_index_layer_feature_idx
    ON app.render_chunk_feature_index (layer_id, feature_kind, feature_id);

CREATE INDEX IF NOT EXISTS render_chunk_feature_index_render_feature_idx
    ON app.render_chunk_feature_index (render_chunk_id, render_feature_id)
    WHERE render_feature_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS render_chunk_feature_index_bbox_idx
    ON app.render_chunk_feature_index USING GIST (bbox);

CREATE TABLE IF NOT EXISTS app.feature_metadata_cache (
    feature_kind text NOT NULL CHECK (feature_kind IN ('entity', 'event', 'asset')),
    feature_id text NOT NULL,
    layer_id text NOT NULL REFERENCES catalog.layers(layer_id) ON DELETE CASCADE,

    -- JSON returned by on-demand card/detail endpoints.
    metadata jsonb NOT NULL,
    source_observed_at timestamptz,
    content_hash text NOT NULL,
    built_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,

    PRIMARY KEY (feature_kind, feature_id)
);

CREATE INDEX IF NOT EXISTS feature_metadata_cache_layer_idx
    ON app.feature_metadata_cache (layer_id, built_at DESC);

CREATE INDEX IF NOT EXISTS feature_metadata_cache_expires_at_idx
    ON app.feature_metadata_cache (expires_at)
    WHERE expires_at IS NOT NULL;


CREATE TABLE IF NOT EXISTS app.replay_tile_index (
    layer_id TEXT NOT NULL,
    z SMALLINT NOT NULL,
    x INT NOT NULL,
    y INT NOT NULL,
    t_bucket TIMESTAMPTZ NOT NULL,
    content_hash TEXT NOT NULL,
    item_count INT NOT NULL,
    bytes INT NOT NULL,
    built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (layer_id, z, x, y, t_bucket)
);

CREATE INDEX IF NOT EXISTS replay_tile_index_built_at_idx
    ON app.replay_tile_index (built_at);

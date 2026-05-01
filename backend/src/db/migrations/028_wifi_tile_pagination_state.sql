-- 028_wifi_tile_pagination_state.sql
-- Backend-owned WiGLE pagination state. The frontend requests our viewport
-- tile/state; backend persists every fetched page, tracks searchAfter cursor
-- and exposes explicit completeness instead of silently returning page 1 only.

CREATE TABLE IF NOT EXISTS app.wifi_viewport_tiles (
    tile_key text PRIMARY KEY,
    source_id text NOT NULL DEFAULT 'wigle',
    south double precision NOT NULL CHECK (south BETWEEN -90 AND 90),
    west double precision NOT NULL CHECK (west BETWEEN -180 AND 180),
    north double precision NOT NULL CHECK (north BETWEEN -90 AND 90),
    east double precision NOT NULL CHECK (east BETWEEN -180 AND 180),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'fetching', 'partial', 'complete', 'rate_limited', 'error')),
    total_results integer,
    fetched_count integer NOT NULL DEFAULT 0,
    page_count integer NOT NULL DEFAULT 0,
    next_search_after text,
    last_fetch_at timestamptz,
    next_fetch_after timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wifi_viewport_tiles_status_next_idx
    ON app.wifi_viewport_tiles (status, next_fetch_after);

CREATE TABLE IF NOT EXISTS app.wifi_observation_tiles (
    tile_key text NOT NULL REFERENCES app.wifi_viewport_tiles(tile_key) ON DELETE CASCADE,
    wifi_id text NOT NULL REFERENCES app.wifi_observations(wifi_id) ON DELETE CASCADE,
    first_seen_in_tile timestamptz NOT NULL DEFAULT now(),
    last_seen_in_tile timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tile_key, wifi_id)
);

CREATE INDEX IF NOT EXISTS wifi_observation_tiles_wifi_idx
    ON app.wifi_observation_tiles (wifi_id);

COMMENT ON TABLE app.wifi_viewport_tiles IS
    'Persisted WiGLE viewport tile pagination state: cursor, completeness, provider cooldown and latest known counts.';

COMMENT ON TABLE app.wifi_observation_tiles IS
    'Join table between WiGLE viewport tiles and observations fetched for those tiles.';

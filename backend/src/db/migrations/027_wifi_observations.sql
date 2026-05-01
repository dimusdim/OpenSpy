-- 027_wifi_observations.sql
-- Viewport-scoped Wi-Fi observation cache. The render payload stays minimal;
-- detail fields are loaded on demand by id and the history table records
-- provider-state changes without full repeated snapshots.

CREATE TABLE IF NOT EXISTS app.wifi_observations (
    wifi_id text PRIMARY KEY,
    source_id text NOT NULL DEFAULT 'wigle',
    ssid text,
    bssid_masked text,
    lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
    security text NOT NULL CHECK (security IN ('open', 'encrypted', 'unknown')),
    encryption text,
    channel integer,
    network_type text,
    first_seen timestamptz,
    last_seen timestamptz,
    provider_updated_at timestamptz,
    quality double precision,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    payload_hash text NOT NULL,
    first_seen_by_us timestamptz NOT NULL DEFAULT now(),
    last_seen_by_us timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wifi_observations_source_idx
    ON app.wifi_observations (source_id, last_seen_by_us DESC);

CREATE INDEX IF NOT EXISTS wifi_observations_security_idx
    ON app.wifi_observations (security);

CREATE INDEX IF NOT EXISTS wifi_observations_last_seen_idx
    ON app.wifi_observations (last_seen DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS app.wifi_observation_history (
    wifi_history_id bigserial PRIMARY KEY,
    wifi_id text NOT NULL REFERENCES app.wifi_observations(wifi_id) ON DELETE CASCADE,
    source_id text NOT NULL DEFAULT 'wigle',
    observed_at timestamptz NOT NULL,
    lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
    security text NOT NULL CHECK (security IN ('open', 'encrypted', 'unknown')),
    payload_hash text NOT NULL,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    stored_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (wifi_id, source_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS wifi_observation_history_time_idx
    ON app.wifi_observation_history (observed_at DESC);

CREATE INDEX IF NOT EXISTS wifi_observation_history_wifi_time_idx
    ON app.wifi_observation_history (wifi_id, observed_at DESC);

COMMENT ON TABLE app.wifi_observations IS
    'Current Wi-Fi observation cache for viewport rendering and on-demand details. Render API must not return raw BSSID or descriptive metadata.';

COMMENT ON TABLE app.wifi_observation_history IS
    'Deduplicated provider-state history for Wi-Fi observations. Stores changes by payload_hash, not repeated full viewport snapshots.';

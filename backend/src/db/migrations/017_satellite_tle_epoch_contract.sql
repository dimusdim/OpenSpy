-- 017_satellite_tle_epoch_contract.sql
-- Separate the TLE epoch from the time we fetched/stored the catalog.
-- Existing rows keep working through COALESCE(tle_epoch_at, observed_at)
-- so compressed historical chunks do not need to be rewritten.

ALTER TABLE core.orbital_elements
    ADD COLUMN IF NOT EXISTS tle_epoch_at timestamptz,
    ADD COLUMN IF NOT EXISTS fetched_at timestamptz,
    ADD COLUMN IF NOT EXISTS provider text,
    ADD COLUMN IF NOT EXISTS source_publication_at timestamptz;

CREATE INDEX IF NOT EXISTS orbital_elements_layer_entity_tle_epoch_idx
    ON core.orbital_elements (
        layer_id,
        entity_id,
        (COALESCE(tle_epoch_at, observed_at)) DESC,
        (COALESCE(fetched_at, observed_at)) DESC,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS orbital_elements_layer_tle_epoch_idx
    ON core.orbital_elements (
        layer_id,
        (COALESCE(tle_epoch_at, observed_at)) DESC,
        (COALESCE(fetched_at, observed_at)) DESC
    );

CREATE INDEX IF NOT EXISTS orbital_elements_provider_fetched_idx
    ON core.orbital_elements (provider, (COALESCE(fetched_at, observed_at)) DESC)
    WHERE provider IS NOT NULL;

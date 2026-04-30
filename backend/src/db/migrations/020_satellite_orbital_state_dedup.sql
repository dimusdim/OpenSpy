-- 020_satellite_orbital_state_dedup.sql
-- Timescale hypertables cannot enforce a unique index that omits the time
-- partition column. Use a small ledger table to make satellite TLE state
-- deduplication schema-enforced across cache reloads and restarts.

ALTER TABLE core.orbital_elements
    ADD COLUMN IF NOT EXISTS state_hash text;

UPDATE core.orbital_elements
SET state_hash = md5(COALESCE(tle_line1, '') || '|' || COALESCE(tle_line2, ''))
WHERE (state_hash IS NULL OR state_hash <> md5(COALESCE(tle_line1, '') || '|' || COALESCE(tle_line2, '')))
  AND (tle_line1 IS NOT NULL OR tle_line2 IS NOT NULL)
  AND observed_at >= now() - INTERVAL '29 days';

CREATE TABLE IF NOT EXISTS core.orbital_element_state_hashes (
    entity_id text NOT NULL REFERENCES core.entities(entity_id) ON DELETE CASCADE,
    state_hash text NOT NULL,
    first_observed_at timestamptz,
    first_orbital_element_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_id, state_hash)
);

WITH orbital_hashes AS (
    SELECT
        entity_id,
        COALESCE(state_hash, md5(COALESCE(tle_line1, '') || '|' || COALESCE(tle_line2, ''))) AS effective_state_hash,
        COALESCE(tle_epoch_at, observed_at) AS effective_observed_at,
        orbital_element_id,
        created_at
    FROM core.orbital_elements
    WHERE state_hash IS NOT NULL
       OR tle_line1 IS NOT NULL
       OR tle_line2 IS NOT NULL
)
INSERT INTO core.orbital_element_state_hashes (
    entity_id,
    state_hash,
    first_observed_at,
    first_orbital_element_id
)
SELECT DISTINCT ON (entity_id, effective_state_hash)
    entity_id,
    effective_state_hash,
    effective_observed_at,
    orbital_element_id
FROM orbital_hashes
WHERE effective_state_hash <> ''
ORDER BY entity_id, effective_state_hash, effective_observed_at ASC, created_at ASC
ON CONFLICT (entity_id, state_hash) DO NOTHING;

CREATE INDEX IF NOT EXISTS orbital_elements_entity_state_hash_idx
    ON core.orbital_elements (entity_id, state_hash)
    WHERE state_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS orbital_element_state_hashes_created_idx
    ON core.orbital_element_state_hashes (created_at DESC);

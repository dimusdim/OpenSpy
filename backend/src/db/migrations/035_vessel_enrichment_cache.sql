-- 035_vessel_enrichment_cache.sql
-- On-demand vessel enrichment cache: Wikimedia Commons photos (by IMO
-- category) and Global Fishing Watch registry identity (by IMO/MMSI).
-- Reference-class lookup data fetched when an entity card is opened;
-- rows are refreshed lazily after fetched_at ages out (service-side TTL).

CREATE TABLE IF NOT EXISTS core.vessel_enrichment (
    imo             TEXT PRIMARY KEY,
    mmsi            TEXT,
    photos          JSONB NOT NULL DEFAULT '[]'::jsonb,
    gfw_identity    JSONB,
    provider_status JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vessel_enrichment_mmsi_idx
    ON core.vessel_enrichment (mmsi)
    WHERE mmsi IS NOT NULL;

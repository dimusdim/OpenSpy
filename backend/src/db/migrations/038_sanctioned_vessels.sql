-- 038_sanctioned_vessels.sql
-- Enrichment table for OpenSanctions maritime data: sanctioned vessels keyed by
-- IMO and MMSI so live AIS tracks can be flagged. Refreshed by opensanctions.service
-- from the free daily maritime.csv (OpenSanctions aggregates OFAC/EU/UK/UAE/Tokyo MoU
-- and more). Data license is CC-BY-NC; provenance stays in the `datasets` column.

CREATE TABLE IF NOT EXISTS app.sanctioned_vessels (
    id         text PRIMARY KEY,          -- OpenSanctions entity id
    caption    text,                       -- vessel name
    imo        text,
    mmsi       text,
    flag       text,
    countries  text,
    risk       text,
    datasets   text,                       -- source lists (provenance)
    url        text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Lookup by identifier. Partial indexes skip the many rows lacking one id.
CREATE INDEX IF NOT EXISTS idx_sanctioned_vessels_imo
    ON app.sanctioned_vessels (imo) WHERE imo IS NOT NULL AND imo <> '';
CREATE INDEX IF NOT EXISTS idx_sanctioned_vessels_mmsi
    ON app.sanctioned_vessels (mmsi) WHERE mmsi IS NOT NULL AND mmsi <> '';

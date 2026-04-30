-- 018_satellite_tle_epoch_backfill_recent.sql
-- Backfill recent, normally uncompressed satellite rows so existing replay
-- data immediately uses the TLE epoch. Older/compressed chunks keep the
-- COALESCE(tle_epoch_at, observed_at) fallback until an explicit maintenance
-- decompress/backfill job is run.

CREATE OR REPLACE FUNCTION app.parse_tle_epoch_at(tle_line1 text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    epoch_year integer;
    day_of_year double precision;
    full_year integer;
BEGIN
    IF tle_line1 IS NULL OR length(tle_line1) < 32 THEN
        RETURN NULL;
    END IF;

    epoch_year := substring(tle_line1 from 19 for 2)::integer;
    day_of_year := substring(tle_line1 from 21 for 12)::double precision;

    IF day_of_year < 1 THEN
        RETURN NULL;
    END IF;

    full_year := CASE
        WHEN epoch_year >= 57 THEN 1900 + epoch_year
        ELSE 2000 + epoch_year
    END;

    RETURN make_timestamptz(full_year, 1, 1, 0, 0, 0, 'UTC')
        + ((day_of_year - 1) * INTERVAL '1 day');
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$;

UPDATE core.orbital_elements
SET
    tle_epoch_at = COALESCE(tle_epoch_at, app.parse_tle_epoch_at(tle_line1)),
    fetched_at = COALESCE(fetched_at, observed_at),
    provider = COALESCE(provider, properties->>'provider'),
    source_publication_at = COALESCE(source_publication_at, app.parse_tle_epoch_at(tle_line1))
WHERE observed_at >= now() - INTERVAL '29 days'
  AND (tle_epoch_at IS NULL OR fetched_at IS NULL OR provider IS NULL OR source_publication_at IS NULL);

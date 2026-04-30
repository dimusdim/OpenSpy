-- 015_ingest_payload_metrics.sql
-- Make raw snapshot payloads measurable and deduplicatable.

ALTER TABLE raw.raw_payloads
    ADD COLUMN IF NOT EXISTS content_hash text,
    ADD COLUMN IF NOT EXISTS payload_bytes bigint;

UPDATE raw.raw_payloads
SET
    content_hash = COALESCE(content_hash, md5(payload::text)),
    payload_bytes = COALESCE(payload_bytes, octet_length(payload::text)::bigint)
WHERE content_hash IS NULL
   OR payload_bytes IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'raw_payloads_payload_bytes_nonnegative'
    ) THEN
        ALTER TABLE raw.raw_payloads
            ADD CONSTRAINT raw_payloads_payload_bytes_nonnegative
            CHECK (payload_bytes IS NULL OR payload_bytes >= 0)
            NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS raw_payloads_source_content_idx
    ON raw.raw_payloads (
        source_id,
        layer_id,
        content_hash,
        upstream_id
    )
    WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS raw_payloads_source_observed_idx
    ON raw.raw_payloads (source_id, layer_id, observed_at DESC);

-- 024_latest_source_ingest_metrics.sql
-- Normalize latest ingest metrics per source/layer for status endpoints.

CREATE OR REPLACE VIEW raw.latest_source_ingest_metrics AS
WITH ranked AS (
    SELECT
        ingest_run_id,
        source_id,
        layer_id,
        started_at,
        completed_at,
        status,
        record_count,
        error_message,
        metadata,
        row_number() OVER (
            PARTITION BY COALESCE(source_id, '__none__'), COALESCE(layer_id, '__none__')
            ORDER BY completed_at DESC NULLS LAST, started_at DESC
        ) AS rn
    FROM raw.ingest_runs
)
SELECT
    ingest_run_id,
    source_id,
    layer_id,
    started_at,
    completed_at,
    status,
    record_count,
    error_message,
    COALESCE(NULLIF(metadata #>> '{sourceMetrics,upstreamBytes}', '')::bigint, NULLIF(metadata ->> 'rawPayloadBytes', '')::bigint, 0) AS upstream_bytes,
    COALESCE(NULLIF(metadata #>> '{sourceMetrics,rawCount}', '')::integer, NULLIF(metadata ->> 'rawPayloadCount', '')::integer, 0) AS raw_count,
    COALESCE(NULLIF(metadata #>> '{sourceMetrics,normalizedCount}', '')::integer, record_count, 0) AS normalized_count,
    COALESCE(NULLIF(metadata #>> '{sourceMetrics,changedCount}', '')::integer, NULLIF(metadata ->> 'rawPayloadStoredCount', '')::integer, record_count, 0) AS changed_count,
    NULLIF(metadata #>> '{sourceMetrics,parseMs}', '')::double precision AS parse_ms,
    COALESCE(NULLIF(metadata #>> '{sourceMetrics,dbWriteMs}', '')::double precision, NULLIF(metadata #>> '{timingsMs,canonicalWrite}', '')::double precision) AS db_write_ms,
    NULLIF(metadata #>> '{sourceMetrics,rawPersistMs}', '')::double precision AS raw_persist_ms,
    COALESCE(NULLIF(metadata #>> '{sourceMetrics,totalMs}', '')::double precision, NULLIF(metadata #>> '{timingsMs,total}', '')::double precision) AS total_ms,
    NULLIF(metadata #>> '{sourceMetrics,renderBatchBytes}', '')::bigint AS render_batch_bytes,
    COALESCE(
        NULLIF(metadata #>> '{sourceMetrics,completeness}', ''),
        NULLIF(metadata ->> 'completeness', ''),
        NULLIF(metadata ->> 'apiCompleteness', ''),
        CASE WHEN status = 'failed' THEN 'unavailable' ELSE 'complete' END
    ) AS completeness,
    metadata
FROM ranked
WHERE rn = 1;

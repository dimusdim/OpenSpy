-- 034_gdacs_live_contract_replace.sql
-- GDACS is fetched as a current bulletin collection for the live map. Event
-- snapshots/raw payloads remain append/idempotent storage details, but the
-- public live contract must be `replace` so catalog/API/smoke agree.

UPDATE catalog.sources
SET
    manifest = jsonb_set(
        COALESCE(manifest, '{}'::jsonb),
        '{live_contract}',
        jsonb_build_object(
            'delivery_mode', 'replace',
            'poll_ms', 300000,
            'stale_after_sec', NULL,
            'remove_after_sec', NULL,
            'notes', 'GDACS MAP endpoint returns the current bulletin collection; OpenSpy replaces the live disaster view on each poll while canonical event snapshots remain append/idempotent in storage.'
        ),
        true
    ),
    updated_at = now()
WHERE source_id = 'gdacs';

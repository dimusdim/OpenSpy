-- 021_source_motion_contracts.sql
-- Make replay motion cadence explicit in catalog manifests. `stale_after_sec`
-- controls whether an object is still visible; `motion_max_gap_sec` controls
-- whether browser replay may interpolate between two observed fixes.

UPDATE catalog.sources
SET
    manifest = jsonb_set(
        COALESCE(manifest, '{}'::jsonb),
        '{live_contract}',
        COALESCE(manifest->'live_contract', '{}'::jsonb) || jsonb_build_object(
            'poll_ms', 90000,
            'motion_max_gap_sec', 300
        ),
        true
    ),
    updated_at = now()
WHERE source_id = 'opensky';

UPDATE catalog.sources
SET
    manifest = jsonb_set(
        COALESCE(manifest, '{}'::jsonb),
        '{live_contract}',
        COALESCE(manifest->'live_contract', '{}'::jsonb) || jsonb_build_object(
            'throttle_ms', 60000,
            'motion_max_gap_sec', 600
        ),
        true
    ),
    updated_at = now()
WHERE source_id = 'aisstream';

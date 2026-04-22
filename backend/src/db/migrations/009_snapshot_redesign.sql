-- 009_snapshot_redesign.sql
-- Enforce observed_at NOT NULL on snapshot tables and convert PKs to composite
-- (id, observed_at). Required before converting to TimescaleDB hypertables.

ALTER TABLE core.position_fixes DROP CONSTRAINT IF EXISTS position_fixes_pkey;
ALTER TABLE core.position_fixes
  ADD CONSTRAINT position_fixes_pkey PRIMARY KEY (position_fix_id, observed_at);

ALTER TABLE core.entity_snapshots ALTER COLUMN observed_at SET NOT NULL;
ALTER TABLE core.entity_snapshots DROP CONSTRAINT IF EXISTS entity_snapshots_pkey;
ALTER TABLE core.entity_snapshots
  ADD CONSTRAINT entity_snapshots_pkey PRIMARY KEY (entity_snapshot_id, observed_at);

ALTER TABLE core.event_snapshots ALTER COLUMN observed_at SET NOT NULL;
ALTER TABLE core.event_snapshots DROP CONSTRAINT IF EXISTS event_snapshots_pkey;
ALTER TABLE core.event_snapshots
  ADD CONSTRAINT event_snapshots_pkey PRIMARY KEY (event_snapshot_id, observed_at);

ALTER TABLE core.asset_snapshots ALTER COLUMN observed_at SET NOT NULL;
ALTER TABLE core.asset_snapshots DROP CONSTRAINT IF EXISTS asset_snapshots_pkey;
ALTER TABLE core.asset_snapshots
  ADD CONSTRAINT asset_snapshots_pkey PRIMARY KEY (asset_snapshot_id, observed_at);

ALTER TABLE core.orbital_elements ALTER COLUMN observed_at SET NOT NULL;
ALTER TABLE core.orbital_elements DROP CONSTRAINT IF EXISTS orbital_elements_pkey;
ALTER TABLE core.orbital_elements
  ADD CONSTRAINT orbital_elements_pkey PRIMARY KEY (orbital_element_id, observed_at);

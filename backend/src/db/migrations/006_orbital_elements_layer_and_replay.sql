ALTER TABLE core.orbital_elements
    ADD COLUMN IF NOT EXISTS layer_id text;

UPDATE core.orbital_elements oe
SET layer_id = e.layer_id
FROM core.entities e
WHERE oe.entity_id = e.entity_id
  AND oe.layer_id IS NULL;

ALTER TABLE core.orbital_elements
    ALTER COLUMN layer_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'orbital_elements_layer_id_fkey'
    ) THEN
        ALTER TABLE core.orbital_elements
            ADD CONSTRAINT orbital_elements_layer_id_fkey
            FOREIGN KEY (layer_id)
            REFERENCES catalog.layers(layer_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS orbital_elements_layer_time_idx
    ON core.orbital_elements (layer_id, observed_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS orbital_elements_layer_entity_time_idx
    ON core.orbital_elements (layer_id, entity_id, observed_at DESC, created_at DESC);

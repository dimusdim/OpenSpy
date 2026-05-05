-- Preserve pre-standardization saved selections. Saved app.selections rows are
-- produced by agent/UI selection paths, whose bbox predicates already used the
-- OpenSpy public order west,south,east,north before the order marker existed.
-- Provider/internal south,west,north,east conversion stays behind API
-- boundaries and should not be stamped onto saved UI selections.
UPDATE app.selections
SET predicate = jsonb_set(predicate, '{bbox_order}', to_jsonb('west,south,east,north'::text), true),
    updated_at = now()
WHERE predicate ? 'bbox'
  AND NOT (predicate ? 'bbox_order')
  AND NOT (predicate ? 'bboxOrder');

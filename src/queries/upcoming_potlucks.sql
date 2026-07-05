SELECT
  e.id,
  e.title,
  e.date,
  e.location,
  e.notes,
  COUNT(DISTINCT s.id) AS slot_count,
  COUNT(c.id) AS claim_count,
  COALESCE(SUM(s.capacity), 0) AS total_capacity
FROM app_potluck__events e
LEFT JOIN app_potluck__slots s ON s.event_id = e.id
LEFT JOIN app_potluck__claims c ON c.slot_id = s.id
WHERE e.archived = 0
GROUP BY e.id
ORDER BY e.date ASC

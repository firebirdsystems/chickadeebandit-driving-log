SELECT
  e.id AS event_id,
  e.title AS event_title,
  s.id AS slot_id,
  s.name AS slot_name,
  s.capacity,
  COUNT(c.id) AS claimed_count,
  GROUP_CONCAT(c.member_name, ', ') AS claimed_by
FROM app_potluck__events e
JOIN app_potluck__slots s ON s.event_id = e.id
LEFT JOIN app_potluck__claims c ON c.slot_id = s.id
WHERE e.archived = 0
GROUP BY e.id, s.id
ORDER BY e.date ASC, s.sort_order ASC, s.name ASC

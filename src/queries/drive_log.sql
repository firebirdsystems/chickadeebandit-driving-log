SELECT
  id,
  driver_id,
  supervisor_id,
  date,
  minutes,
  night_minutes,
  weather,
  road
FROM app_driving_log__drives
ORDER BY date DESC
LIMIT 300

-- Migration 002: views.training_sessions um Garmin-Distanz/-Dauer, Pace und Geschwindigkeit
-- erweitern (Aufgabe 004c Teil A).
--
-- Idempotent (CREATE OR REPLACE VIEW). Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 002_training_sessions_pace.sql
--
-- Neue Spalten:
--   distance_m    numeric  -- Meter, bevorzugt aus raw.garmin_activities.distanceM (Tages-Match,
--                           -- s. Kommentar unten), sonst entries.distanz (km) * 1000
--   duration_sec  numeric  -- Sekunden, bevorzugt aus garmin_activities.durationSec, sonst aus
--                           -- entries.zeit ("HH:MM:SS") berechnet
--   pace_min_km   numeric  -- nur bei typ IN ('laufen','gehen','wandern') UND distance_m > 0
--   speed_kmh     numeric  -- bei distance_m > 0 UND duration_sec > 0 (alle Typen)

CREATE OR REPLACE VIEW views.training_sessions AS
SELECT
  e.id AS entry_id,
  e.day,
  e.data->>'typ' AS typ,
  e.data->>'source' AS source,
  (e.data->>'distanz')::numeric AS distanz,
  e.data->>'zeit' AS zeit,
  (e.data->>'kalorien')::numeric AS kalorien_device,
  (e.data->>'act_kcal_calc')::numeric AS act_kcal_calc,
  (e.data->>'steps')::numeric AS steps,
  ga.avg_hr,
  ga.max_hr,
  ga.garmin_kcal,
  COALESCE(ga.distance_m, (e.data->>'distanz')::numeric * 1000) AS distance_m,
  COALESCE(
    ga.duration_sec,
    CASE WHEN e.data->>'zeit' ~ '^\d{1,2}:\d{2}:\d{2}$' THEN
      split_part(e.data->>'zeit', ':', 1)::numeric * 3600
      + split_part(e.data->>'zeit', ':', 2)::numeric * 60
      + split_part(e.data->>'zeit', ':', 3)::numeric
    END
  ) AS duration_sec,
  CASE
    WHEN e.data->>'typ' IN ('laufen', 'gehen', 'wandern')
     AND COALESCE(ga.distance_m, (e.data->>'distanz')::numeric * 1000) > 0
     AND COALESCE(
           ga.duration_sec,
           CASE WHEN e.data->>'zeit' ~ '^\d{1,2}:\d{2}:\d{2}$' THEN
             split_part(e.data->>'zeit', ':', 1)::numeric * 3600
             + split_part(e.data->>'zeit', ':', 2)::numeric * 60
             + split_part(e.data->>'zeit', ':', 3)::numeric
           END
         ) > 0
    THEN
      (COALESCE(
         ga.duration_sec,
         CASE WHEN e.data->>'zeit' ~ '^\d{1,2}:\d{2}:\d{2}$' THEN
           split_part(e.data->>'zeit', ':', 1)::numeric * 3600
           + split_part(e.data->>'zeit', ':', 2)::numeric * 60
           + split_part(e.data->>'zeit', ':', 3)::numeric
         END
       ) / 60.0)
      / (COALESCE(ga.distance_m, (e.data->>'distanz')::numeric * 1000) / 1000.0)
  END AS pace_min_km,
  CASE
    WHEN COALESCE(ga.distance_m, (e.data->>'distanz')::numeric * 1000) > 0
     AND COALESCE(
           ga.duration_sec,
           CASE WHEN e.data->>'zeit' ~ '^\d{1,2}:\d{2}:\d{2}$' THEN
             split_part(e.data->>'zeit', ':', 1)::numeric * 3600
             + split_part(e.data->>'zeit', ':', 2)::numeric * 60
             + split_part(e.data->>'zeit', ':', 3)::numeric
           END
         ) > 0
    THEN
      (COALESCE(ga.distance_m, (e.data->>'distanz')::numeric * 1000) / 1000.0)
      / (COALESCE(
           ga.duration_sec,
           CASE WHEN e.data->>'zeit' ~ '^\d{1,2}:\d{2}:\d{2}$' THEN
             split_part(e.data->>'zeit', ':', 1)::numeric * 3600
             + split_part(e.data->>'zeit', ':', 2)::numeric * 60
             + split_part(e.data->>'zeit', ':', 3)::numeric
           END
         ) / 3600.0)
  END AS speed_kmh
FROM raw.entries e
LEFT JOIN LATERAL (
  SELECT
    (g.data->>'avgHr')::numeric AS avg_hr,
    (g.data->>'maxHr')::numeric AS max_hr,
    (g.data->>'garminKcal')::numeric AS garmin_kcal,
    (g.data->>'distanceM')::numeric AS distance_m,
    (g.data->>'durationSec')::numeric AS duration_sec
  FROM raw.garmin_activities g
  WHERE g.deleted_at IS NULL AND g.day = e.day
  LIMIT 1
) ga ON true
WHERE e.deleted_at IS NULL
  AND e.data->>'typ' NOT IN ('tageslog', 'phonesteps');

GRANT SELECT ON views.training_sessions TO fuelofit_ro;

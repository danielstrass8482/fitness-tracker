-- Migration 004: views.training_sessions um neue Garmin-Aktivitaetsfelder erweitern
-- (Aufgabe 004c Teil C.5): Trittfrequenz, Training Effect, Hoehenmeter, Geschwindigkeit.
--
-- Quelle: raw.garmin_activities (Tages-Match wie bisher, s. Migration 002). Cadence nur bei
-- Lauf-Typen gefuellt (Garmin liefert avgCadence/maxCadence nur fuer running/treadmill_running),
-- sonst NULL. avg_speed_ms kommt direkt vom Geraet (Garmin-Feld averageSpeed, m/s) -- kann von
-- distance_m/duration_sec (Migration 002) leicht abweichen, wenn Garmin intern movingDuration
-- statt der Gesamtdauer verwendet.
--
-- Idempotent (CREATE OR REPLACE VIEW, Spalten nur angehaengt). Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 004_training_sessions_garmin_detail.sql

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
  END AS speed_kmh,
  ga.aerobic_te,
  ga.anaerobic_te,
  ga.elevation_gain_m,
  ga.avg_speed_ms,
  ga.avg_cadence,
  ga.max_cadence
FROM raw.entries e
LEFT JOIN LATERAL (
  SELECT
    (g.data->>'avgHr')::numeric AS avg_hr,
    (g.data->>'maxHr')::numeric AS max_hr,
    (g.data->>'garminKcal')::numeric AS garmin_kcal,
    (g.data->>'distanceM')::numeric AS distance_m,
    (g.data->>'durationSec')::numeric AS duration_sec,
    (g.data->>'aerobicTE')::numeric AS aerobic_te,
    (g.data->>'anaerobicTE')::numeric AS anaerobic_te,
    (g.data->>'elevationGainM')::numeric AS elevation_gain_m,
    (g.data->>'avgSpeedMs')::numeric AS avg_speed_ms,
    (g.data->>'avgCadence')::numeric AS avg_cadence,
    (g.data->>'maxCadence')::numeric AS max_cadence
  FROM raw.garmin_activities g
  WHERE g.deleted_at IS NULL AND g.day = e.day
  LIMIT 1
) ga ON true
WHERE e.deleted_at IS NULL
  AND e.data->>'typ' NOT IN ('tageslog', 'phonesteps');

GRANT SELECT ON views.training_sessions TO fuelofit_ro;

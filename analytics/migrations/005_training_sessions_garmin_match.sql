-- Migration 005: views.training_sessions -- Garmin-Zuordnung pro Aktivitaet statt pro Tag
-- (Aufgabe 008a2, Befund 007a).
--
-- Bisher (002/004): LEFT JOIN LATERAL ... WHERE g.day = e.day LIMIT 1 -> an Tagen mit mehreren
-- Garmin-Aktivitaeten bekam JEDER Eintrag des Tages (auch Plan-Eintraege ohne Garmin-Bezug)
-- dieselbe, beliebige Aktivitaet (z. B. 10.11.: Lauf mit E-Bike-Werten).
--
-- Neu: Abgleich ueber Startzeit. Eine eindeutige ID-Verknuepfung Eintrag <-> Aktivitaet gibt es
-- nicht: raw.entries hat kein garminId-Feld; daily_snapshots.activities fuehrt je Position
-- entweder eine entries-id oder 'garmin_'||id (12 von 26), nie beides. Daher Match: gleicher
-- Tag und entries.garminTime = Uhrzeit von startLocal,
-- exakt (Stand 11.11.2026: 26/26 Aktivitaeten genau ein Treffer, kein Toleranzfenster noetig).
-- Jede Aktivitaet hoechstens einem Eintrag; Eintraege ohne Treffer -> Garmin-Felder NULL.
--
-- Spaltennamen, -reihenfolge und -typen unveraendert (CREATE OR REPLACE VIEW). Idempotent.
-- Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 005_training_sessions_garmin_match.sql

CREATE OR REPLACE VIEW views.training_sessions AS
WITH garmin_match AS (
  -- Zuordnung Garmin-Aktivitaet -> Eintrag: gleicher Tag UND entries.garminTime ("HH:MM:SS")
  -- = Uhrzeit aus startLocal ("YYYY-MM-DDTHH:MM:SS+hh:mm", Zeichen 12-19). DISTINCT ON
  -- (g.id): jede Aktivitaet hoechstens EINEM Eintrag (bei Gleichstand kleinste entry id).
  SELECT DISTINCT ON (g.id) g.id AS garmin_id, e.id AS entry_id
  FROM raw.garmin_activities g
  JOIN raw.entries e
    ON e.day = g.day
   AND e.data->>'garminTime' = substr(g.data->>'startLocal', 12, 8)
  WHERE g.deleted_at IS NULL
    AND e.deleted_at IS NULL
    AND e.data->>'typ' NOT IN ('tageslog', 'phonesteps')
  ORDER BY g.id, e.id
)
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
  FROM garmin_match m
  JOIN raw.garmin_activities g ON g.id = m.garmin_id
  WHERE m.entry_id = e.id
  ORDER BY g.id
  LIMIT 1
) ga ON true
WHERE e.deleted_at IS NULL
  AND e.data->>'typ' NOT IN ('tageslog', 'phonesteps');

GRANT SELECT ON views.training_sessions TO fuelofit_ro;

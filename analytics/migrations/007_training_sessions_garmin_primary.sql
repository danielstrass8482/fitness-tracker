-- Migration 007: views.training_sessions -- Garmin-Aktivitaeten als primaere Quelle (Aufgabe 012,
-- Google Fit abloesen).
--
-- Bisher (005): je entries-Dokument eine Zeile, Garmin-Werte nur angehaengt. Garmin-Aktivitaeten
-- OHNE Google-Fit-Eintrag fehlten komplett -> nach dem Ende von Google Fit fehlten alle neuen
-- Trainings.
--
-- Neu:
--  1. Je Garmin-Aktivitaet (raw.garmin_activities, nicht geloescht, nicht in raw.garmin_hidden)
--     eine Zeile: entry_id = 'garmin_' || Aktivitaets-ID (wie App/dailySnapshots), source = 'garmin',
--     typ wie garminActivityToEntry() in index.html:
--       garminType = 'strength_training'      -> 'kraft'
--       mappedTyp vorhanden und <> 'unmapped' -> mappedTyp
--       sonst                                 -> 'sonstiges_garmin'
--     Werte aus Garmin: distanz (km, round(distanceM)/1000 wie App), zeit (HH:MM:SS aus durationSec,
--     '' bei 0 wie App), steps, Puls, garmin_kcal, Detailwerte. kalorien_device = NULL (der
--     Geraetewert steht in garmin_kcal; entries.kalorien war bei Google Fit immer 0).
--  2. Ein passender Google-Fit-Eintrag (source 'googlefit', gleicher Tag UND garminTime = Uhrzeit
--     aus startLocal, exakt wie 005) liefert NUR act_kcal_calc und wird selbst keine Zeile mehr.
--     Garmin-Aktivitaet ohne Google-Fit-Eintrag: act_kcal_calc aus dailySnapshots
--     (activities[].kcalGezaehlt mit id 'garmin_<id>', = App-Wert), sonst NULL - keine neue Formel.
--  3. Alle uebrigen entries (manual, plan/zirkel, Google Fit ohne Garmin-Gegenstueck) bleiben wie
--     bisher eigene Zeilen (Garmin-Felder NULL).
--  Ausgeblendete Garmin-Aktivitaeten (garmin_hidden) erzeugen keine Zeile und blenden ihren
--  Google-Fit-Eintrag ebenfalls aus (wie getEffectiveTrainingEntries in der App).
--  Zirkel-verknuepfte Kraft-Aktivitaeten bleiben (wie bisher der Google-Fit-Kraft-Eintrag) eigene
--  Zeilen; die App haengt sie stattdessen an den Zirkel-Eintrag (dort nicht nachgebaut).
--
-- Spaltennamen, -reihenfolge und -typen unveraendert (CREATE OR REPLACE VIEW). Idempotent.
-- Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 007_training_sessions_garmin_primary.sql

CREATE OR REPLACE VIEW views.training_sessions AS
WITH ga_all AS (
  SELECT g.id, g.day, g.data,
         substr(g.data->>'startLocal', 12, 8) AS start_time,
         EXISTS (SELECT 1 FROM raw.garmin_hidden h WHERE h.id = g.id AND h.deleted_at IS NULL) AS hidden
  FROM raw.garmin_activities g
  WHERE g.deleted_at IS NULL
),
gfit_match AS (
  -- Garmin-Aktivitaet -> Google-Fit-Eintrag (gleicher Tag, garminTime = Startuhrzeit, exakt).
  -- DISTINCT ON (g.id): jede Aktivitaet hoechstens EINEM Eintrag (bei Gleichstand kleinste id).
  SELECT DISTINCT ON (g.id) g.id AS garmin_id, e.id AS entry_id,
         (e.data->>'act_kcal_calc')::numeric AS act_kcal_calc
  FROM ga_all g
  JOIN raw.entries e
    ON e.day = g.day
   AND e.data->>'garminTime' = g.start_time
  WHERE e.deleted_at IS NULL
    AND e.data->>'source' = 'googlefit'
  ORDER BY g.id, e.id
),
snap_kcal AS (
  SELECT DISTINCT ON (x->>'id') x->>'id' AS act_id, (x->>'kcalGezaehlt')::numeric AS kcal
  FROM raw.daily_snapshots s, jsonb_array_elements(s.data->'activities') x
  WHERE s.deleted_at IS NULL
    AND jsonb_typeof(s.data->'activities') = 'array'
    AND x->>'id' LIKE 'garmin\_%'
  ORDER BY x->>'id', s.day DESC
),
base AS (
  -- 1) Garmin-Aktivitaeten
  SELECT
    'garmin_' || g.id AS entry_id,
    g.day,
    CASE
      WHEN g.data->>'garminType' = 'strength_training' THEN 'kraft'
      WHEN COALESCE(g.data->>'mappedTyp', '') NOT IN ('', 'unmapped') THEN g.data->>'mappedTyp'
      ELSE 'sonstiges_garmin'
    END AS typ,
    'garmin'::text AS source,
    CASE WHEN (g.data->>'distanceM')::numeric > 0
         THEN round((g.data->>'distanceM')::numeric) / 1000 ELSE 0 END AS distanz,
    CASE WHEN (g.data->>'durationSec')::numeric > 0
         THEN lpad((round((g.data->>'durationSec')::numeric)::int / 3600)::text, 2, '0') || ':'
           || lpad(((round((g.data->>'durationSec')::numeric)::int % 3600) / 60)::text, 2, '0') || ':'
           || lpad((round((g.data->>'durationSec')::numeric)::int % 60)::text, 2, '0')
         ELSE '' END AS zeit,
    NULL::numeric AS kalorien_device,
    COALESCE(m.act_kcal_calc, sk.kcal) AS act_kcal_calc,
    (g.data->>'steps')::numeric AS steps,
    (g.data->>'avgHr')::numeric AS avg_hr,
    (g.data->>'maxHr')::numeric AS max_hr,
    (g.data->>'garminKcal')::numeric AS garmin_kcal,
    (g.data->>'distanceM')::numeric AS g_distance_m,
    (g.data->>'durationSec')::numeric AS g_duration_sec,
    (g.data->>'aerobicTE')::numeric AS aerobic_te,
    (g.data->>'anaerobicTE')::numeric AS anaerobic_te,
    (g.data->>'elevationGainM')::numeric AS elevation_gain_m,
    (g.data->>'avgSpeedMs')::numeric AS avg_speed_ms,
    (g.data->>'avgCadence')::numeric AS avg_cadence,
    (g.data->>'maxCadence')::numeric AS max_cadence
  FROM ga_all g
  LEFT JOIN gfit_match m ON m.garmin_id = g.id
  LEFT JOIN snap_kcal sk ON sk.act_id = 'garmin_' || g.id
  WHERE NOT g.hidden

  UNION ALL

  -- 2) entries ohne Garmin-Gegenstueck (manual, plan/zirkel, Google Fit ohne Garmin)
  SELECT
    e.id,
    e.day,
    e.data->>'typ',
    e.data->>'source',
    (e.data->>'distanz')::numeric,
    e.data->>'zeit',
    (e.data->>'kalorien')::numeric,
    (e.data->>'act_kcal_calc')::numeric,
    (e.data->>'steps')::numeric,
    NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric
  FROM raw.entries e
  WHERE e.deleted_at IS NULL
    AND e.data->>'typ' NOT IN ('tageslog', 'phonesteps')
    AND NOT EXISTS (SELECT 1 FROM gfit_match m WHERE m.entry_id = e.id)
),
calc AS (
  SELECT b.*,
    COALESCE(b.g_distance_m, b.distanz * 1000) AS distance_m,
    COALESCE(
      b.g_duration_sec,
      CASE WHEN b.zeit ~ '^\d{1,2}:\d{2}:\d{2}$' THEN
        split_part(b.zeit, ':', 1)::numeric * 3600
        + split_part(b.zeit, ':', 2)::numeric * 60
        + split_part(b.zeit, ':', 3)::numeric
      END
    ) AS duration_sec
  FROM base b
)
SELECT
  entry_id,
  day,
  typ,
  source,
  distanz,
  zeit,
  kalorien_device,
  act_kcal_calc,
  steps,
  avg_hr,
  max_hr,
  garmin_kcal,
  distance_m,
  duration_sec,
  CASE WHEN typ IN ('laufen', 'gehen', 'wandern') AND distance_m > 0 AND duration_sec > 0
       THEN (duration_sec / 60.0) / (distance_m / 1000.0) END AS pace_min_km,
  CASE WHEN distance_m > 0 AND duration_sec > 0
       THEN (distance_m / 1000.0) / (duration_sec / 3600.0) END AS speed_kmh,
  aerobic_te,
  anaerobic_te,
  elevation_gain_m,
  avg_speed_ms,
  avg_cadence,
  max_cadence
FROM calc;

GRANT SELECT ON views.training_sessions TO fuelofit_ro;

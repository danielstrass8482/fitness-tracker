-- Migration 009: views.training_sessions -- zirkel-verknuepfte Garmin-Kraft-Zeilen bekommen
-- act_kcal_calc = NULL statt dem gfit-Fallback-Wert (Aufgabe 012c, Entscheidung Daniel/Claude
-- 14.11.2026, siehe Bericht 012b).
--
-- Hintergrund: die App haengt bei einem Zirkel mit verknuepfter Garmin-Kraft-Aktivitaet
-- (computeZirkelGarminLinksForDate in index.html) den Garmin-Wert NICHT als eigene
-- dailySnapshots.activities[]-Zeile ein -- der gezaehlte Wert steckt stattdessen im
-- Zirkel-Eintrag selbst (activities[].id = Zirkel-id, typ 'zirkel'). Migration 008 erkennt
-- das bereits daran, dass 'garmin_<id>' in keinem Snapshot auftaucht (snap_kcal liefert NULL),
-- faellt dann aber auf den alten Google-Fit-act_kcal_calc zurueck (Schritt 3 der Kette) --
-- das war vor 012b/15.11. der einzige verfuegbare Wert, seitdem gibt es dafuer keinen
-- Google-Fit-Eintrag mehr. Diese Migration macht aus dem Fallback fuer genau diesen Fall NULL,
-- damit der Garmin-Kraft-Wert nicht fuer die Analyse verfuegbar aussieht, obwohl er in
-- Wirklichkeit im Zirkel-Eintrag (eigene Zeile, typ 'zirkel') steckt -- sonst drohte eine
-- Verwechslung/Doppelzaehlung bei einer Summierung ueber act_kcal_calc.
--
-- Erkennung identisch zur Zirkel-Snapshot-Erkennung aus 008, zusaetzlich gegen eine zufaellig
-- fehlende/alte Snapshot-Zeile abgesichert durch die Zirkel-Tagesbedingung:
--   g.data->>'garminType' = 'strength_training'   -- Kraft-Aktivitaet
--   AND sk.kcal IS NULL                           -- kein eigener 'garmin_<id>'-Snapshot-Eintrag
--   AND es existiert ein Zirkel-Eintrag (raw.entries, typ='zirkel') am selben Tag
--
-- Betroffen (Beleg Bericht 012c): die 8 Zeilen aus 012b (01./02./04./06./08./09./11./13.11.2026,
-- bisher 164/247/248/252/154/245/239/240) + neue seit 15.11. (bisher ebenfalls schon NULL, da
-- kein Google-Fit-Fallback mehr existiert -- diese Migration aendert an ihnen nichts, macht die
-- NULL aber zur gleichen, ausdruecklichen Regel statt Zufall der fehlenden Kette).
-- Alle anderen Zeilen (auch "covered" Kraft ohne Zirkel, z.B. 07.11.: eigener Snapshot-Eintrag
-- mit kcalGezaehlt=0 -> sk.kcal = 0, NICHT NULL -> unveraendert) bleiben unveraendert.
-- Zeilen, Distanz, Dauer, alle anderen Spalten unveraendert. Spaltennamen/-reihenfolge/-typen
-- unveraendert (CREATE OR REPLACE VIEW). Idempotent.
-- Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 009_training_sessions_zirkel_kraft_null.sql

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
  -- App-Wert je Aktivitaets-id (garmin_<id> ODER Google-Fit-Eintrags-id), juengster Snapshot gewinnt.
  SELECT DISTINCT ON (x->>'id') x->>'id' AS act_id, (x->>'kcalGezaehlt')::numeric AS kcal
  FROM raw.daily_snapshots s, jsonb_array_elements(s.data->'activities') x
  WHERE s.deleted_at IS NULL
    AND jsonb_typeof(s.data->'activities') = 'array'
    AND x->>'kcalGezaehlt' IS NOT NULL
  ORDER BY x->>'id', s.day DESC
),
zirkel_days AS (
  -- Tage mit mindestens einem Zirkel-Eintrag (fuer die Zirkel-Erkennung unten).
  SELECT DISTINCT e.day FROM raw.entries e
  WHERE e.deleted_at IS NULL AND e.data->>'typ' = 'zirkel'
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
    CASE
      WHEN g.data->>'garminType' = 'strength_training'
       AND sk.kcal IS NULL
       AND g.day IN (SELECT day FROM zirkel_days)
      THEN NULL
      ELSE COALESCE(sk.kcal, skg.kcal, m.act_kcal_calc)
    END AS act_kcal_calc,
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
  LEFT JOIN snap_kcal skg ON skg.act_id = m.entry_id
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

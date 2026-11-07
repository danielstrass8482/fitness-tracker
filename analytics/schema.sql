-- Fuelofit Analyse-DB (Phase 1a) -- Schema
--
-- Grundlage: docs/datenmodell.md ("Analytics-DB"). Rohdaten aus Firestore (Projekt
-- fitness-tracker-c6f97), geholt ueber die Cloud Function exportAnalytics (siehe ~/functions),
-- NICHT direkt aus Firestore. Single-User-App: keine uid-Spalte, kein Nutzer-Bezug in den Tabellen.
--
-- Diese Datei ist idempotent (CREATE ... IF NOT EXISTS / DO-Bloecke), kann also mehrfach
-- ausgefuehrt werden, um das Schema auf den aktuellen Stand zu bringen.
--
-- Manueller Schritt VOR dieser Datei, als Superuser, AUSSERHALB einer Transaktion
-- (CREATE DATABASE ist in keinem DO-Block/keiner Transaktion moeglich):
--
--   CREATE DATABASE fuelofit_analytics;
--
-- Danach mit \c fuelofit_analytics (oder -d fuelofit_analytics) verbinden und diese Datei
-- ausfuehren: psql -d fuelofit_analytics -f schema.sql
--
-- Passwoerter fuer die Rollen fuelofit_sync/fuelofit_ro werden NICHT hier gesetzt (dieses File
-- wird committet). Siehe Teil C2 im Auftrag: Passwort je Rolle zufaellig erzeugen und per
-- ALTER ROLE ... PASSWORD '...' direkt auf dem VPS setzen, nie in eine Datei im Repo schreiben.

-- ===== Rollen (idempotent, ohne Passwort) =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fuelofit_sync') THEN
    CREATE ROLE fuelofit_sync LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fuelofit_ro') THEN
    CREATE ROLE fuelofit_ro LOGIN;
  END IF;
END
$$;

-- ===== Schemas =====
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS views;

GRANT USAGE ON SCHEMA raw TO fuelofit_sync, fuelofit_ro;
GRANT USAGE ON SCHEMA views TO fuelofit_ro;

-- ===== raw.* -- eine Tabelle pro Whitelist-Collection aus exportAnalytics =====
-- id        = Firestore Doc-ID
-- day       = Datum aus dem Doc, soweit vorhanden (s. je Tabelle); NULL bei Collections ohne
--             Datumsfeld (foods, recipes, weekly_stats, training_types, interval_templates,
--             garmin_links, garmin_hidden) -- dort nur mode=full
-- data      = komplettes, bereits serverseitig von Secret-Feldern befreites Firestore-Doc (jsonb)
-- synced_at = Zeitpunkt des letzten erfolgreichen Sync-Schreibens dieser Zeile
-- deleted_at = gesetzt, wenn das Doc bei einem Sync-Lauf nicht mehr geliefert wurde
--             (window: innerhalb des Zeitfensters; full: ueberhaupt), NULL = aktuell

CREATE TABLE IF NOT EXISTS raw.log_entries (
  id text PRIMARY KEY,
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS log_entries_day_idx ON raw.log_entries (day);
CREATE INDEX IF NOT EXISTS log_entries_data_gin ON raw.log_entries USING gin (data);

CREATE TABLE IF NOT EXISTS raw.entries (
  id text PRIMARY KEY,
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS entries_day_idx ON raw.entries (day);
CREATE INDEX IF NOT EXISTS entries_data_gin ON raw.entries USING gin (data);

CREATE TABLE IF NOT EXISTS raw.foods (
  id text PRIMARY KEY,
  day date,                       -- immer NULL (Katalog, kein Datumsfeld), mode=full
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS foods_data_gin ON raw.foods USING gin (data);

CREATE TABLE IF NOT EXISTS raw.recipes (
  id text PRIMARY KEY,
  day date,                       -- immer NULL, mode=full
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS recipes_data_gin ON raw.recipes USING gin (data);

CREATE TABLE IF NOT EXISTS raw.weekly_stats (
  id text PRIMARY KEY,            -- Firestore-Doc-ID, Format YYYY-Www
  day date,                       -- immer NULL (kein Tagesdatum), mode=full
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS weekly_stats_data_gin ON raw.weekly_stats USING gin (data);

CREATE TABLE IF NOT EXISTS raw.oura_daily (
  id text PRIMARY KEY,            -- = YYYY-MM-DD
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS oura_daily_day_idx ON raw.oura_daily (day);
CREATE INDEX IF NOT EXISTS oura_daily_data_gin ON raw.oura_daily USING gin (data);

CREATE TABLE IF NOT EXISTS raw.oura_workouts (
  id text PRIMARY KEY,            -- UUID
  day date,                       -- aus data->>'day'
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS oura_workouts_day_idx ON raw.oura_workouts (day);

CREATE TABLE IF NOT EXISTS raw.garmin_activities (
  id text PRIMARY KEY,            -- activityId
  day date,                       -- Datumsteil aus data->>'startLocal'
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS garmin_activities_day_idx ON raw.garmin_activities (day);
CREATE INDEX IF NOT EXISTS garmin_activities_data_gin ON raw.garmin_activities USING gin (data);

CREATE TABLE IF NOT EXISTS raw.garmin_daily (
  id text PRIMARY KEY,            -- = YYYY-MM-DD, kein eigenes Datumsfeld im Doc
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS garmin_daily_day_idx ON raw.garmin_daily (day);

CREATE TABLE IF NOT EXISTS raw.ciq_steps (
  id text PRIMARY KEY,            -- = YYYY-MM-DD, kein eigenes Datumsfeld im Doc
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS ciq_steps_day_idx ON raw.ciq_steps (day);

CREATE TABLE IF NOT EXISTS raw.daily_check (
  id text PRIMARY KEY,            -- = YYYY-MM-DD
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS daily_check_day_idx ON raw.daily_check (day);
CREATE INDEX IF NOT EXISTS daily_check_data_gin ON raw.daily_check USING gin (data);

CREATE TABLE IF NOT EXISTS raw.daily_check_call_log (
  id text PRIMARY KEY,            -- = YYYY-MM-DD_{ms}
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS daily_check_call_log_day_idx ON raw.daily_check_call_log (day);

CREATE TABLE IF NOT EXISTS raw.trainingplans (
  id text PRIMARY KEY,            -- = Montag der Planwoche, YYYY-MM-DD
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS trainingplans_day_idx ON raw.trainingplans (day);
CREATE INDEX IF NOT EXISTS trainingplans_data_gin ON raw.trainingplans USING gin (data);

CREATE TABLE IF NOT EXISTS raw.daily_snapshots (
  id text PRIMARY KEY,            -- = YYYY-MM-DD (Firestore-Doc-ID, siehe Teil B Aufgabe 003c)
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS daily_snapshots_day_idx ON raw.daily_snapshots (day);
CREATE INDEX IF NOT EXISTS daily_snapshots_data_gin ON raw.daily_snapshots USING gin (data);

CREATE TABLE IF NOT EXISTS raw.training_types (
  id text PRIMARY KEY,
  day date,                       -- immer NULL, mode=full
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS raw.interval_templates (
  id text PRIMARY KEY,
  day date,                       -- immer NULL, mode=full
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS raw.garmin_links (
  id text PRIMARY KEY,            -- activityId
  day date,                       -- immer NULL, mode=full
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS raw.garmin_hidden (
  id text PRIMARY KEY,            -- activityId
  day date,                       -- immer NULL, mode=full
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ===== Rechte: fuelofit_sync schreibt raw.*, fuelofit_ro liest raw.* und views.* =====
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA raw TO fuelofit_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw GRANT SELECT, INSERT, UPDATE ON TABLES TO fuelofit_sync;

GRANT SELECT ON ALL TABLES IN SCHEMA raw TO fuelofit_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw GRANT SELECT ON TABLES TO fuelofit_ro;

GRANT SELECT ON ALL TABLES IN SCHEMA views TO fuelofit_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA views GRANT SELECT ON TABLES TO fuelofit_ro;

-- ===== views.* -- typisierte Sichten fuer die wichtigsten Auswertungen =====
-- Feldnamen aus docs/datenmodell.md. Live berechnete Werte (BMR, Kalorienziel,
-- Zirkel-/Puls-Mischung, Schrittquelle je Tag) werden hier bewusst NICHT nachgebaut -- die
-- Formeln liegen nur in index.html. Das kommt als Snapshot-Tabelle in Phase 1b
-- (siehe docs/datenmodell.md Abschnitt 7a).

-- 1) Tagesernaehrung / Makros: Summe je Tag aus raw.log_entries (aktive Zeilen).
CREATE OR REPLACE VIEW views.daily_nutrition AS
SELECT
  day,
  count(*) AS entries,
  sum((data->>'kcal')::numeric) AS kcal,
  sum((data->>'protein')::numeric) AS protein,
  sum((data->>'carbs')::numeric) AS carbs,
  sum((data->>'fat')::numeric) AS fat
FROM raw.log_entries
WHERE deleted_at IS NULL AND day IS NOT NULL
GROUP BY day;

-- 2) Gewicht: aus entries.typ='tageslog', Feld weight (nur gesetzt, wenn im Tageslog erfasst).
CREATE OR REPLACE VIEW views.body_weight AS
SELECT
  day,
  (data->>'weight')::numeric AS weight_kg
FROM raw.entries
WHERE deleted_at IS NULL
  AND data->>'typ' = 'tageslog'
  AND data->>'weight' IS NOT NULL;

-- 3) Trainings inkl. Puls: entries (Trainingstypen, ohne tageslog/phonesteps) links gegen
-- garmin_activities desselben Tages (avg_hr/max_hr/garmin_kcal/distance_m/duration_sec), falls
-- vorhanden. Eine Garmin-Aktivitaet kann zu keinem, einem oder mehreren entries-Docs am selben
-- Tag passen -- die genaue Zuordnung macht live computeZirkelGarminLinksForDate() in index.html,
-- hier nur die Rohwerte nebeneinander. distance_m/duration_sec bevorzugen Garmin-Werte (Tages-
-- Match), fallen sonst auf entries.distanz (km->m) bzw. entries.zeit ("HH:MM:SS"->Sekunden)
-- zurueck. pace_min_km nur bei Lauf-/Gehtypen (laufen/gehen/wandern) und distance_m > 0.
-- speed_kmh bei allen Typen mit distance_m > 0 und duration_sec > 0. (004c, 07.11.2026)
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

-- 4) Schritte je Tag und Quelle, NICHT zusammengefuehrt (die Auswahl der "gueltigen" Quelle
-- je Tag ist App-Logik, getStepsSourceForDate() in index.html -- absichtlich nicht
-- nachgebaut).
CREATE OR REPLACE VIEW views.daily_steps_by_source AS
SELECT day, 'garmin_daily'::text AS source, (data->>'steps')::numeric AS steps
FROM raw.garmin_daily WHERE deleted_at IS NULL
UNION ALL
SELECT day, 'oura'::text AS source, (data->>'steps')::numeric AS steps
FROM raw.oura_daily WHERE deleted_at IS NULL
UNION ALL
SELECT day, 'ciq'::text AS source, (data->>'steps')::numeric AS steps
FROM raw.ciq_steps WHERE deleted_at IS NULL
UNION ALL
SELECT day, 'googlefit_tageslog'::text AS source, (data->>'steps')::numeric AS steps
FROM raw.entries WHERE deleted_at IS NULL AND data->>'typ' = 'tageslog' AND data->>'steps' IS NOT NULL;

-- 5) Schlaf / Erholung: oura_daily-Felder. remSleepSec/lightSleepSec/awakeSec/sleepEfficiency/
-- respiratoryRate/sleepLatencySec/bedtimeStart/bedtimeEnd seit 004c (07.11.2026, selber
-- /v2/usercollection/sleep-Call, kein neuer API-Request).
CREATE OR REPLACE VIEW views.sleep_recovery AS
SELECT
  day,
  (data->>'sleepDurationSec')::numeric AS sleep_duration_sec,
  (data->>'deepSleepSec')::numeric AS deep_sleep_sec,
  (data->>'hrvAvg')::numeric AS hrv_avg,
  (data->>'restingHr')::numeric AS resting_hr,
  (data->>'sleepScore')::numeric AS sleep_score,
  (data->>'readinessScore')::numeric AS readiness_score,
  (data->>'tempDeviation')::numeric AS temp_deviation,
  (data->>'remSleepSec')::numeric AS rem_sleep_sec,
  (data->>'lightSleepSec')::numeric AS light_sleep_sec,
  (data->>'awakeSec')::numeric AS awake_sec,
  (data->>'sleepEfficiency')::numeric AS sleep_efficiency,
  (data->>'respiratoryRate')::numeric AS respiratory_rate,
  (data->>'sleepLatencySec')::numeric AS sleep_latency_sec,
  data->>'bedtimeStart' AS bedtime_start,
  data->>'bedtimeEnd' AS bedtime_end
FROM raw.oura_daily
WHERE deleted_at IS NULL;

-- 6) Tages-Zusammenfassung (Phase 1b): live berechnete Werte aus raw.daily_snapshots (von der
-- App selbst berechnet und geschrieben, siehe B1 in index.html -- KEINE Formel-Nachbildung
-- hier). Bilanz = Intake - Kalorienziel (negativ = Defizit). Gewicht aus views.body_weight
-- (separat erfasst, nicht Teil des Snapshots).
CREATE OR REPLACE VIEW views.daily_summary AS
SELECT
  ds.day,
  (ds.data->'kcalGoal'->>'total')::numeric AS kcal_goal_total,
  (ds.data->'kcalGoal'->>'base')::numeric AS kcal_goal_base,
  (ds.data->'kcalGoal'->>'activity')::numeric AS kcal_goal_activity,
  (ds.data->'kcalGoal'->>'daily')::numeric AS kcal_goal_daily,
  (ds.data->'intake'->>'kcal')::numeric AS intake_kcal,
  (ds.data->'intake'->>'protein')::numeric AS intake_protein,
  (ds.data->'intake'->>'carbs')::numeric AS intake_carbs,
  (ds.data->'intake'->>'fat')::numeric AS intake_fat,
  (ds.data->'intake'->>'kcal')::numeric - (ds.data->'kcalGoal'->>'total')::numeric AS balance_kcal,
  (ds.data->'steps'->>'display')::numeric AS steps_display,
  ds.data->'steps'->>'source' AS steps_source,
  (SELECT COALESCE(sum((a->>'kcalGezaehlt')::numeric), 0)
     FROM jsonb_array_elements(ds.data->'activities') a) AS activity_kcal_sum,
  bw.weight_kg,
  (ds.data->>'final')::boolean AS final,
  (ds.data->>'backfilled')::boolean AS backfilled,
  ds.data->>'appBuild' AS app_build
FROM raw.daily_snapshots ds
LEFT JOIN views.body_weight bw ON bw.day = ds.day
WHERE ds.deleted_at IS NULL;

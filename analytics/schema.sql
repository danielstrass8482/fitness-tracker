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

-- fuelofit_ro (MCP-Server, 008b/008b3): nur Lesen auf views, hoechstens 3 Verbindungen,
-- jede Transaktion read-only, 10 s Statement-Timeout. Stand = vps/mcp/db_role.sql (fuelofit-functions).
ALTER ROLE fuelofit_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
ALTER ROLE fuelofit_ro SET default_transaction_read_only = on;
ALTER ROLE fuelofit_ro SET statement_timeout = '10s';

-- ===== Schemas =====
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS views;

GRANT USAGE ON SCHEMA raw TO fuelofit_sync;
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

-- Lauf-Protokoll von sync.py selbst (Betriebsdaten, keine Fuelofit-Fachdaten; Migration 010,
-- Aufgabe 016 Teil C) - jeder Lauf, erfolgreich UND fehlgeschlagen, siehe record_sync_run in
-- sync.py und migrations/010_sync_runs.sql fuer die Begruendung.
CREATE TABLE IF NOT EXISTS raw.sync_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('window', 'full')),
  days        integer,
  rows        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ok          boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_runs_mode_finished_idx ON raw.sync_runs (mode, finished_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_finished_idx ON raw.sync_runs (finished_at DESC);

-- ===== Rechte: fuelofit_sync schreibt raw.*, fuelofit_ro liest NUR views.* =====
-- views.* gehoeren dem ausfuehrenden Superuser und laufen mit Owner-Rechten (kein
-- security_invoker), fuelofit_ro braucht daher keinen Zugriff auf raw (008b/008b3).
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA raw TO fuelofit_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw GRANT SELECT, INSERT, UPDATE ON TABLES TO fuelofit_sync;

-- raw: fuelofit_ro alles entziehen (falls aus Phase 1a noch vorhanden; idempotent)
REVOKE ALL ON ALL TABLES IN SCHEMA raw FROM fuelofit_ro;
REVOKE ALL ON SCHEMA raw FROM fuelofit_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA raw REVOKE ALL ON TABLES FROM fuelofit_ro;

-- views: USAGE (oben) + SELECT, auch fuer kuenftige Views
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
-- Stand Migration 025 (Aufgabe 047): Waage (weightGarmin) vor Handeintrag (weight); weight_kg = weight_used_kg.
-- Stand Migration 026 (Aufgabe 048): Plausibilitaetsfilter Waage (> 5 kg vom Median der 14 Tage davor -> verworfen).
CREATE OR REPLACE VIEW views.body_weight AS
WITH RECURSIVE t AS (
  SELECT
    day,
    NULLIF((data->>'weightGarmin')::numeric, 0) AS g,
    NULLIF((data->>'weight')::numeric, 0) AS m,
    row_number() OVER (ORDER BY day) AS rn
  FROM raw.entries
  WHERE deleted_at IS NULL
    AND data->>'typ' = 'tageslog'
    AND (NULLIF((data->>'weightGarmin')::numeric, 0) IS NOT NULL
         OR NULLIF((data->>'weight')::numeric, 0) IS NOT NULL)
),
-- r: je Tag Entscheidung; hd/hw = bisherige Tage mit eigenem genutztem Gewicht (Historie)
r AS (
  SELECT t.rn, t.day, t.g, t.m,
         NULL::numeric AS ref,
         CASE WHEN t.g IS NULL THEN NULL ELSE true END AS plausibel,
         COALESCE(t.g, t.m) AS own_w,
         COALESCE(t.g, t.m) AS used_w,
         ARRAY[t.day] AS hd,
         ARRAY[COALESCE(t.g, t.m)] AS hw
  FROM t WHERE t.rn = 1
  UNION ALL
  SELECT t.rn, t.day, t.g, t.m, x.ref, x.plausibel, y.own_w,
         COALESCE(y.own_w, r.hw[array_length(r.hw, 1)]) AS used_w,
         CASE WHEN y.own_w IS NULL THEN r.hd ELSE r.hd || t.day END,
         CASE WHEN y.own_w IS NULL THEN r.hw ELSE r.hw || y.own_w END
  FROM r
  JOIN t ON t.rn = r.rn + 1
  CROSS JOIN LATERAL (
    SELECT ref, CASE WHEN t.g IS NULL THEN NULL ELSE (ref IS NULL OR abs(t.g - ref) <= 5) END AS plausibel
    FROM (SELECT CASE WHEN t.g IS NULL THEN NULL ELSE COALESCE(
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY u.w)::numeric
               FROM unnest(r.hd, r.hw) AS u(d, w)
              WHERE u.d >= t.day - 14 AND u.d < t.day
             HAVING count(*) > 0),
            r.hw[array_length(r.hw, 1)]) END AS ref) q
  ) x
  CROSS JOIN LATERAL (
    SELECT CASE WHEN t.g IS NOT NULL AND x.plausibel THEN t.g ELSE t.m END AS own_w
  ) y
)
SELECT
  day,
  used_w AS weight_kg,
  g AS weight_garmin_kg,
  m AS weight_manual_kg,
  used_w AS weight_used_kg,
  CASE WHEN g IS NULL THEN 'manuell'
       WHEN plausibel THEN 'waage'
       ELSE 'waage_verworfen' END AS quelle,
  plausibel AS weight_garmin_plausibel
FROM r;

CREATE OR REPLACE VIEW views.koerperzusammensetzung AS
SELECT
  e.day,
  substr(e.data->>'weightGarminTs', 12, 5) AS uhrzeit,
  (e.data->>'weightGarmin')::numeric AS gewicht_kg,
  (e.data->>'bodyFatPct')::numeric AS koerperfett_pct,
  (e.data->>'muscleMassKg')::numeric AS muskelmasse_kg,
  (e.data->>'boneMassKg')::numeric AS knochenmasse_kg,
  (e.data->>'bodyWaterPct')::numeric AS koerperwasser_pct,
  (e.data->>'bmiGarmin')::numeric AS bmi,
  (e.data->>'weighInsGarmin')::int AS wiegungen,
  bw.weight_garmin_plausibel AS plausibel
FROM raw.entries e
LEFT JOIN views.body_weight bw ON bw.day = e.day
WHERE e.deleted_at IS NULL
  AND e.data->>'typ' = 'tageslog'
  AND NULLIF((e.data->>'weightGarmin')::numeric, 0) IS NOT NULL;

COMMENT ON VIEW views.body_weight IS
  'Gewicht je Tag mit Messung. weight_kg = weight_used_kg (Waage vor Handeintrag; Waage > 5 kg vom Median der 14 Tage davor -> verworfen, quelle waage_verworfen, weight_garmin_plausibel false). Aufgaben 047/048.';
COMMENT ON VIEW views.koerperzusammensetzung IS
  'Waagen-Schaetzung (BIA), absolute Werte ungenau, nur fuer Trends. Letzte Wiegung je Tag (Garmin-Waage, Aufgabe 047). plausibel = false: Wiegung verworfen (> 5 kg Abweichung, Aufgabe 048), Werte nicht verwenden.';

-- 3) Trainings (Stand Migration 009, Aufgabe 012c; Garmin primaer seit 007/012).
-- Je Garmin-Aktivitaet (nicht geloescht, nicht in garmin_hidden) eine Zeile mit
-- entry_id 'garmin_<id>', source 'garmin', typ wie garminActivityToEntry() in index.html
-- (strength_training -> kraft, sonst mappedTyp, unmapped -> sonstiges_garmin), Werte aus Garmin.
-- Ein passender Google-Fit-Eintrag (gleicher Tag, garminTime = Uhrzeit aus startLocal, exakt)
-- ist keine eigene Zeile. act_kcal_calc der Garmin-Zeilen = App-Wert: zuerst
-- dailySnapshots.activities[].kcalGezaehlt fuer 'garmin_<id>', sonst fuer die id des passenden
-- Google-Fit-Eintrags (22.-28.10.2026), sonst act_kcal_calc des Google-Fit-Eintrags, sonst NULL.
-- Kraft-Zeilen mit Zirkel: Kalorien stehen im Zirkel-Eintrag -- eine Garmin-Kraft-Aktivitaet ohne
-- eigenen 'garmin_<id>'-Snapshot-Eintrag an einem Tag mit Zirkel-Eintrag bekommt act_kcal_calc =
-- NULL (Migration 009, nicht der alte Google-Fit-Fallback; der Zirkel-Wert wird nicht zugeordnet,
-- sonst doppelt). Alle uebrigen entries (manual, plan/zirkel, Google Fit ohne Garmin-Gegenstueck;
-- ohne tageslog/phonesteps) bleiben eigene Zeilen mit Garmin-Feldern NULL. distance_m/duration_sec:
-- Garmin-Werte, sonst entries.distanz (km->m) bzw. entries.zeit ("HH:MM:SS"->Sekunden).
-- pace_min_km nur bei laufen/gehen/wandern und distance_m > 0, speed_kmh bei allen Typen mit
-- distance_m > 0 und duration_sec > 0.
CREATE OR REPLACE VIEW views.training_sessions AS
WITH ga_all AS (
  SELECT g.id, g.day, g.data,
         substr(g.data->>'startLocal', 12, 8) AS start_time,
         EXISTS (SELECT 1 FROM raw.garmin_hidden h WHERE h.id = g.id AND h.deleted_at IS NULL) AS hidden,
         -- Startzeit (Migration 020): FIT-Session bevorzugt (UTC -> Europe/Berlin), sonst startLocal
         -- (Garmin-Ortsuhrzeit, erste 19 Zeichen). fit_elapsed_sec = FIT total_elapsed_time_sec.
         (f.start_time AT TIME ZONE 'Europe/Berlin') AS fit_start_lokal,
         f.total_elapsed_time_sec AS fit_elapsed_sec
  FROM raw.garmin_activities g
  LEFT JOIN raw.garmin_fit_session f ON f.activity_id::text = g.id
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
  -- Tage mit mindestens einem Zirkel-Eintrag (fuer die Zirkel-Erkennung unten, Migration 009).
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
    (g.data->>'maxCadence')::numeric AS max_cadence,
    COALESCE(g.fit_start_lokal, substr(g.data->>'startLocal', 1, 19)::timestamp) AS start_lokal,
    CASE WHEN g.fit_start_lokal IS NOT NULL THEN 'fit'
         WHEN g.data->>'startLocal' IS NOT NULL THEN 'garmin_api' END AS startzeit_quelle,
    g.fit_elapsed_sec
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
    NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    -- Startzeit nur bei Google Fit (timestamp = Start der Health-Sync-Einheit, UTC mit 'Z' -> Berlin).
    -- manual/plan: NULL (timestamp dort = Erfassungs-/Speicherzeit, kein Start; Migration 020).
    CASE WHEN e.data->>'source' = 'googlefit' AND e.data->>'timestamp' ~ '(Z|[+-]\d\d:\d\d)$'
         THEN ((e.data->>'timestamp')::timestamptz AT TIME ZONE 'Europe/Berlin') END,
    CASE WHEN e.data->>'source' = 'googlefit' AND e.data->>'timestamp' ~ '(Z|[+-]\d\d:\d\d)$'
         THEN 'entry_field' END,
    NULL::numeric
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
  max_cadence,
  start_lokal,
  start_lokal + COALESCE(fit_elapsed_sec, duration_sec) * interval '1 second' AS ende_lokal,
  startzeit_quelle
FROM calc;

GRANT SELECT ON views.training_sessions TO fuelofit_ro;

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
  ds.data->>'appBuild' AS app_build,
  -- Migration 018 (Aufgabe 040): Makroziele des Tages aus dem Snapshot, keine Rueckrechnung
  (ds.data->>'goal_protein_g')::numeric AS ziel_protein_g,
  (ds.data->>'goal_fat_g')::numeric AS ziel_fett_g,
  (ds.data->>'goal_carbs_g')::numeric AS ziel_kh_g,
  CASE
    WHEN ds.data->>'goal_protein_g' IS NULL THEN NULL
    -- Migration 019 (040a): Modellkennung aus dem Snapshot, sonst Datums-Rueckfall (018)
    WHEN ds.data->>'makro_modell' IS NOT NULL THEN ds.data->>'makro_modell'
    WHEN ds.day < DATE '2026-11-21' THEN NULL
    WHEN ds.day < DATE '2026-11-24' THEN 'fix_027'
    ELSE 'prozent_040'
  END AS makro_modell
FROM raw.daily_snapshots ds
LEFT JOIN views.body_weight bw ON bw.day = ds.day
WHERE ds.deleted_at IS NULL;

-- Trinktage aus foods.alkohol (Migration 006, Aufgabe 011b). Regel siehe migrations/006_alkohol_tage.sql.
CREATE OR REPLACE VIEW views.alkohol_tage AS
WITH e AS (
  SELECT
    l.day,
    f.data->>'name' AS food_name,
    f.data->>'alkohol' AS alkohol,
    l.data->>'time' AS t,
    CASE WHEN (l.data->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
         THEN (l.data->>'amount')::numeric END AS amount,
    (COALESCE(l.data->>'recipeId', '') <> '' OR COALESCE(l.data->>'_fromRecipe', '') <> '') AS aus_rezept
  FROM raw.log_entries l
  JOIN raw.foods f ON f.id = l.data->>'foodId' AND f.deleted_at IS NULL
  WHERE l.deleted_at IS NULL
    AND l.day IS NOT NULL
    AND f.data->>'alkohol' IN ('ja', 'kochen')
)
SELECT
  day,
  count(*) AS getraenke,
  sum(amount) AS menge_ml,
  string_agg(DISTINCT food_name, ' | ' ORDER BY food_name) AS lebensmittel
FROM e
WHERE alkohol = 'ja'
   OR ( alkohol = 'kochen'
        AND t ~ '^[0-9]{2}:[0-9]{2}$'
        AND (t >= '18:00' OR t < '06:00')
        AND amount >= 100
        AND NOT aus_rezept )
GROUP BY day;

GRANT SELECT ON views.alkohol_tage TO fuelofit_ro;

-- 7) Sync-Status: letzter erfolgreicher Lauf je mode + letzter Lauf ueberhaupt (Migration 010,
-- Aufgabe 016 Teil C - Betriebsdaten des Sync-Jobs, nicht Fuelofit-Fachdaten). Schwellen
-- (26h/2h/days>=7) wertet der MCP-/status-Endpunkt aus, nicht diese View.
CREATE OR REPLACE VIEW views.sync_status AS
WITH last_any AS (
  SELECT DISTINCT ON (mode) mode, finished_at AS last_run_at, ok AS last_run_ok
  FROM raw.sync_runs
  ORDER BY mode, finished_at DESC
),
last_success AS (
  SELECT mode, max(finished_at) AS last_success_at, max(days) AS last_success_days
  FROM raw.sync_runs
  WHERE ok
  GROUP BY mode
)
SELECT
  a.mode,
  s.last_success_at,
  s.last_success_days,
  a.last_run_at,
  NOT a.last_run_ok AS last_run_failed
FROM last_any a
LEFT JOIN last_success s ON s.mode = a.mode;

GRANT SELECT ON views.sync_status TO fuelofit_ro;

-- Einzeilige Ergaenzung zu views.sync_status: "big sync"-Schwelle ueber beide modes hinweg
-- (Fenster-Lauf mit days>=7 ODER Voll-Lauf), siehe migrations/010_sync_runs.sql.
CREATE OR REPLACE VIEW views.sync_health AS
SELECT
  (SELECT max(finished_at) FROM raw.sync_runs
    WHERE ok AND (mode = 'full' OR (mode = 'window' AND days >= 7))) AS last_big_success_at,
  (SELECT max(finished_at) FROM raw.sync_runs) AS last_run_at;

GRANT SELECT ON views.sync_health TO fuelofit_ro;

-- 10/11) food_log_entries + exercise_sets (Migration 012, Aufgabe 016g/016h) -- Begruendung
-- und Regeln siehe analytics/migrations/012_views_food_entries_exercise_sets.sql.
CREATE OR REPLACE VIEW views.food_log_entries AS
WITH l AS (
  SELECT
    le.id,
    le.day,
    le.data->>'time' AS uhrzeit,
    le.data->>'name' AS lebensmittel,
    (le.data->>'amount')::numeric AS menge,
    le.data->>'unit' AS unit_raw,
    (le.data->>'kcal')::numeric AS kcal,
    (le.data->>'protein')::numeric AS protein,
    (le.data->>'carbs')::numeric AS carbs,
    (le.data->>'fat')::numeric AS fat,
    NULLIF(le.data->>'recipeId', '') AS recipe_id,
    NULLIF(le.data->>'_fromRecipe', '') AS from_recipe,
    le.data->>'foodId' AS food_id,
    split_part(le.id, '_', 1) || '_' || right(le.id, 4) AS entry_id_kurz
  FROM raw.log_entries le
  WHERE le.deleted_at IS NULL AND le.day IS NOT NULL
)
SELECT
  l.day,
  l.uhrzeit,
  l.lebensmittel,
  l.menge,
  CASE l.unit_raw WHEN 'grams' THEN 'g' WHEN 'portions' THEN 'portion' ELSE 'g' END AS einheit,
  l.kcal,
  l.protein,
  l.carbs,
  l.fat,
  CASE
    WHEN l.recipe_id IS NOT NULL OR r_food.id IS NOT NULL THEN 'gerichte'
    ELSE COALESCE(f.data->>'kategorie', 'unbekannt')
  END AS kategorie,
  COALESCE(r_rid.data->>'name', l.from_recipe) AS aus_rezept,
  f.data->>'alkohol' AS alkohol,
  l.entry_id_kurz AS entry_id
FROM l
LEFT JOIN raw.foods f ON f.id = l.food_id AND f.deleted_at IS NULL
LEFT JOIN raw.recipes r_food ON r_food.id = l.food_id AND r_food.deleted_at IS NULL
LEFT JOIN raw.recipes r_rid ON r_rid.id = l.recipe_id AND r_rid.deleted_at IS NULL;

GRANT SELECT ON views.food_log_entries TO fuelofit_ro;

CREATE OR REPLACE VIEW views.exercise_sets AS
WITH base AS (
  SELECT
    e.id,
    e.day,
    COALESCE(
      e.data->>'typ',
      CASE e.data->>'type' WHEN 'pull' THEN 'pullups' WHEN 'push' THEN 'pushups' ELSE e.data->>'type' END
    ) AS uebung,
    e.data->>'source' AS quelle,
    NULLIF(e.data->>'sets', '') AS sets_raw,
    e.data->'holdSec' AS hold_sec_raw,
    lower(trim(COALESCE(NULLIF(e.data->>'variant', ''), NULLIF(e.data->>'variante', ''), 'regulaer'))) AS variant_raw,
    split_part(e.id, '_', 1) || '_' || right(e.id, 4) AS entry_id_kurz
  FROM raw.entries e
  WHERE e.deleted_at IS NULL
),
filtered AS (
  SELECT *
  FROM base
  WHERE uebung IN ('pullups', 'pushups', 'lunges') OR uebung ~ '^custom_'
),
parsed AS (
  SELECT
    f.*,
    ARRAY(
      SELECT n::int
      FROM unnest(string_to_array(COALESCE(f.sets_raw, ''), '-')) AS n
      WHERE n ~ '^[0-9]+$' AND n::int > 0
    ) AS nums,
    ARRAY(
      SELECT (h)::numeric::int
      FROM jsonb_array_elements_text(COALESCE(f.hold_sec_raw, '[]'::jsonb)) AS h
    ) AS hold_nums
  FROM filtered f
)
SELECT
  p.day,
  p.uebung,
  CASE p.variant_raw
    WHEN 'regulär' THEN 'regulaer'
    WHEN 'regular' THEN 'regulaer'
    WHEN 'regulaer' THEN 'regulaer'
    WHEN 'reverse' THEN 'reverse'
    WHEN 'hammer grip' THEN 'hammer'
    WHEN 'hammer' THEN 'hammer'
    WHEN 'weit' THEN 'weit'
    WHEN 'eng' THEN 'eng'
    WHEN 'diamond' THEN 'diamond'
    WHEN 'normal' THEN 'normal'
    WHEN 'elevated feet' THEN 'elevated_feet'
    WHEN 'elevated_feet' THEN 'elevated_feet'
    WHEN 'mit gewichten' THEN 'weighted'
    WHEN 'weighted' THEN 'weighted'
    ELSE p.variant_raw
  END AS variante,
  p.quelle,
  COALESCE(array_length(p.nums, 1), 0) AS saetze,
  COALESCE((SELECT sum(x) FROM unnest(p.nums) x), 0) AS wdh_gesamt,
  COALESCE((SELECT max(x) FROM unnest(p.nums) x), 0) AS wdh_max,
  p.sets_raw AS wdh_je_satz,
  CASE WHEN array_length(p.hold_nums, 1) > 0 THEN (SELECT sum(x) FROM unnest(p.hold_nums) x) END AS haltezeit_sek_gesamt,
  CASE WHEN array_length(p.hold_nums, 1) > 0 THEN array_to_string(p.hold_nums, '-') END AS haltezeit_je_satz,
  p.entry_id_kurz AS entry_id
FROM parsed p;

GRANT SELECT ON views.exercise_sets TO fuelofit_ro;

-- 12) zirkel_uebungen (Migration 013, Aufgabe 016i) -- Begruendung und Regeln siehe
-- analytics/migrations/013_view_zirkel_uebungen.sql.
CREATE OR REPLACE VIEW views.zirkel_uebungen AS
WITH z AS (
  SELECT
    e.id,
    e.day,
    e.data->>'source' AS quelle,
    NULLIF(e.data->>'runden', '')::int AS zirkel_runden,
    CASE WHEN jsonb_typeof(e.data->'uebungen') = 'array' THEN e.data->'uebungen' END AS uebungen_raw,
    CASE WHEN jsonb_typeof(e.data->'details') = 'array' AND jsonb_array_length(e.data->'details') > 0
         THEN e.data->'details' END AS details_raw,
    split_part(e.id, '_', 1) || '_' || right(e.id, 4) AS zirkel_id
  FROM raw.entries e
  WHERE e.deleted_at IS NULL AND e.data->>'typ' = 'zirkel'
),
ueb AS (
  SELECT
    z.id,
    (u.ord - 1)::int AS idx,
    u.val->>'typ' AS typ,
    trim(COALESCE(u.val->>'variant', '')) AS variant_raw,
    CASE u.val->>'mode' WHEN 'time' THEN 'zeit' WHEN 'reps' THEN 'wdh' END AS mode,
    NULLIF(u.val->>'wdh', '')::int AS wdh,
    NULLIF(u.val->>'holdSec', '')::int AS hold_sec
  FROM z, jsonb_array_elements(z.uebungen_raw) WITH ORDINALITY AS u(val, ord)
  WHERE z.uebungen_raw IS NOT NULL
),
det AS (
  SELECT
    z.id,
    d.ord AS detail_ord,
    NULLIF(d.val->>'round', '')::int AS runde,
    d.val->>'typ' AS typ,
    trim(COALESCE(d.val->>'variant', '')) AS variant_raw,
    CASE d.val->>'mode' WHEN 'time' THEN 'zeit' WHEN 'reps' THEN 'wdh' END AS mode,
    NULLIF(d.val->>'wdh', '')::int AS wdh,
    NULLIF(d.val->>'sec', '')::int AS sec,
    d.val->>'side' AS seite,
    (d.val->>'perSide')::boolean AS per_side_flag,
    CASE WHEN (d.val->'exIdx') IS NOT NULL AND d.val->'exIdx' <> 'null'::jsonb
         THEN (d.val->>'exIdx')::int END AS exidx
  FROM z, jsonb_array_elements(z.details_raw) WITH ORDINALITY AS d(val, ord)
  WHERE z.details_raw IS NOT NULL
),
entry_hasexidx AS (
  SELECT z.id, COALESCE(bool_or(det.exidx IS NOT NULL), false) AS has_exidx
  FROM z LEFT JOIN det ON det.id = z.id
  WHERE z.details_raw IS NOT NULL
  GROUP BY z.id
),
det_ranked AS (
  SELECT det.*,
    ROW_NUMBER() OVER (PARTITION BY det.id, det.runde, det.typ, det.variant_raw ORDER BY det.detail_ord) - 1 AS occ_rank
  FROM det
),
ueb_ranked AS (
  SELECT ueb.*,
    ROW_NUMBER() OVER (PARTITION BY ueb.id, ueb.typ, ueb.variant_raw ORDER BY ueb.idx) - 1 AS occ_rank
  FROM ueb
),
det_slot AS (
  SELECT
    dr.id, dr.detail_ord, dr.runde, dr.typ, dr.variant_raw, dr.mode, dr.wdh, dr.sec, dr.seite,
    dr.per_side_flag,
    CASE WHEN eh.has_exidx THEN dr.exidx ELSE ur.idx END AS slot
  FROM det_ranked dr
  JOIN entry_hasexidx eh ON eh.id = dr.id
  LEFT JOIN ueb_ranked ur
    ON ur.id = dr.id AND ur.typ = dr.typ AND ur.variant_raw = dr.variant_raw AND ur.occ_rank = dr.occ_rank
    AND NOT eh.has_exidx
),
det_full AS (
  SELECT
    ds.id, ds.detail_ord, ds.runde, ds.slot, ds.typ, ds.variant_raw, ds.mode, ds.wdh, ds.sec,
    ds.seite, ds.per_side_flag,
    u2.hold_sec AS matched_hold_sec,
    CASE
      WHEN ds.mode = 'zeit' THEN (ds.sec IS DISTINCT FROM u2.hold_sec)
      WHEN ds.mode = 'wdh' THEN (ds.sec IS DISTINCT FROM ds.wdh * 3 * (CASE WHEN ds.per_side_flag THEN 2 ELSE 1 END))
      ELSE false
    END AS deviates
  FROM det_slot ds
  LEFT JOIN ueb u2 ON u2.id = ds.id AND u2.idx = ds.slot
),
weg_calc AS (
  SELECT id,
    CASE
      WHEN bool_or(deviates) THEN 'timer'
      WHEN bool_or(mode = 'wdh') THEN 'plan_abhaken'
      ELSE 'unbekannt'
    END AS weg
  FROM det_full
  GROUP BY id
),
details_rows AS (
  SELECT
    z.day,
    z.zirkel_id,
    z.quelle,
    wc.weg,
    df.runde,
    df.slot,
    df.typ AS uebung,
    COALESCE(NULLIF(df.variant_raw, ''), 'regulaer') AS variante,
    df.mode,
    df.seite,
    'details'::text AS datenbasis,
    CASE WHEN df.mode = 'wdh' THEN df.wdh END AS wdh_soll,
    CASE WHEN df.mode = 'zeit' THEN df.matched_hold_sec END AS haltezeit_soll_sek,
    df.sec AS dauer_sek,
    z.zirkel_runden
  FROM det_full df
  JOIN z ON z.id = df.id
  JOIN weg_calc wc ON wc.id = df.id
),
geplant_rows AS (
  SELECT
    z.day,
    z.zirkel_id,
    z.quelle,
    'unbekannt'::text AS weg,
    r.runde,
    ueb.idx AS slot,
    ueb.typ AS uebung,
    COALESCE(NULLIF(ueb.variant_raw, ''), 'regulaer') AS variante,
    ueb.mode,
    NULL::text AS seite,
    'geplant'::text AS datenbasis,
    CASE WHEN ueb.mode = 'wdh' THEN ueb.wdh END AS wdh_soll,
    CASE WHEN ueb.mode = 'zeit' THEN ueb.hold_sec END AS haltezeit_soll_sek,
    NULL::int AS dauer_sek,
    z.zirkel_runden
  FROM z
  JOIN ueb ON ueb.id = z.id
  CROSS JOIN LATERAL generate_series(1, z.zirkel_runden) AS r(runde)
  WHERE z.details_raw IS NULL AND z.zirkel_runden > 0 AND z.uebungen_raw IS NOT NULL
)
SELECT * FROM details_rows
UNION ALL
SELECT * FROM geplant_rows;

GRANT SELECT ON views.zirkel_uebungen TO fuelofit_ro;

-- ===== Ausruestung (028b, Migration 016_ausruestung.sql, identischer Block) =====
CREATE TABLE IF NOT EXISTS raw.gear (
  id text PRIMARY KEY,            -- gear_{ms}
  day date,                       -- immer NULL, mode=full
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS raw.gear_assignments (
  id text PRIMARY KEY,            -- Garmin-activityId
  day date,                       -- Datumsteil von 'at' (letzte Aenderung der Zuordnung, UTC)
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS gear_assignments_day_idx ON raw.gear_assignments (day);

GRANT SELECT, INSERT, UPDATE ON raw.gear, raw.gear_assignments TO fuelofit_sync;

CREATE OR REPLACE VIEW views.lauf_ausruestung AS
SELECT
  'garmin_' || g.id                                        AS entry_id,
  g.id                                                     AS activity_id,
  g.day,
  round(COALESCE(NULLIF(g.data->>'distanceM', '')::numeric, 0) / 1000, 2) AS distanz_km,
  g.data->>'garminType'                                    AS garmin_typ,
  a.data->>'gearId'                                        AS gear_id,
  ge.data->>'name'                                         AS gear_name,
  a.data->>'quelle'                                        AS zuordnung_quelle,
  GREATEST(COALESCE(NULLIF(g.data->>'distanceM', '')::numeric, 0), 0) AS distanz_m
FROM raw.garmin_activities g
LEFT JOIN raw.gear_assignments a ON a.id = g.id AND a.deleted_at IS NULL
LEFT JOIN raw.gear ge ON ge.id = a.data->>'gearId' AND ge.deleted_at IS NULL
WHERE g.deleted_at IS NULL
  AND g.data->>'mappedTyp' = 'laufen'
  AND NOT EXISTS (SELECT 1 FROM raw.garmin_hidden h WHERE h.id = g.id AND h.deleted_at IS NULL)
ORDER BY g.day, g.id;

GRANT SELECT ON views.lauf_ausruestung TO fuelofit_ro;

CREATE OR REPLACE VIEW views.ausruestung AS
WITH runs AS (
  SELECT gear_id, count(*) AS laeufe, sum(distanz_m) / 1000 AS km_laeufe, min(day) AS erster_lauf, max(day) AS letzter_lauf
  FROM views.lauf_ausruestung
  WHERE gear_id IS NOT NULL
  GROUP BY gear_id
), g AS (
  SELECT
    ge.id                                                                AS gear_id,
    ge.data->>'name'                                                     AS name,
    ge.data->>'typ'                                                      AS typ,
    COALESCE((ge.data->>'aktiv')::boolean, false)                         AS aktiv,
    COALESCE((ge.data->>'standard')::boolean, false)
      AND COALESCE((ge.data->>'aktiv')::boolean, false)                   AS standard,
    COALESCE(NULLIF(ge.data->>'start_km', '')::numeric, 0)                AS start_km,
    COALESCE(NULLIF(NULLIF(ge.data->>'wechsel_km', '')::numeric, 0), 600) AS wechsel_km,
    NULLIF(ge.data->>'angelegt_am', '')::date                             AS angelegt_am,
    NULLIF(ge.data->>'ausgemustert_am', '')::date                         AS ausgemustert_am
  FROM raw.gear ge
  WHERE ge.deleted_at IS NULL
)
SELECT
  g.gear_id, g.name, g.typ, g.aktiv, g.standard, g.start_km,
  round(g.start_km + COALESCE(r.km_laeufe, 0), 1)                       AS km_gesamt,
  round(COALESCE(r.km_laeufe, 0), 1)                                    AS km_laeufe,
  COALESCE(r.laeufe, 0)::int                                            AS laeufe,
  r.erster_lauf, r.letzter_lauf,
  g.wechsel_km,
  round((g.start_km + COALESCE(r.km_laeufe, 0)) / g.wechsel_km * 100, 1) AS anteil_pct,
  g.angelegt_am, g.ausgemustert_am
FROM g
LEFT JOIN runs r ON r.gear_id = g.gear_id
ORDER BY g.aktiv DESC, g.standard DESC, g.name;

GRANT SELECT ON views.ausruestung TO fuelofit_ro;

-- ===== Kraft-Saetze aus Garmin-FIT (037, Migration 017_kraft_saetze.sql) =====
-- NICHT hier dupliziert: Tabelle raw.garmin_fit_sets haengt per FK an raw.garmin_fit_session
-- (Migration 014, ebenfalls nicht in dieser Datei -- FIT-Tabellen werden vom Garmin-Sync
-- geschrieben, nicht von sync.py). Tabelle, Zuordnungsregel und views.kraft_saetze stehen
-- vollstaendig in analytics/migrations/017_kraft_saetze.sql (nach 014 ausfuehren).

-- ===== Notiz + Sensor-Flags je Aktivitaet (042, Migration 021_aktivitaet_notiz_sensoren.sql) =====
-- raw.activity_notes (Firestore users/{uid}/activityNotes, sync.py, nur full) steht hier, damit sync.py
-- bei einem Neuaufbau laeuft. raw.garmin_fit_session.rd_source, views.aktivitaet_sensoren und die um
-- hf_quelle/laufdynamik_quelle/hf_verwertbar/laufdynamik_verwertbar/notiz ERWEITERTEN Views
-- training_sessions/lauf_kilometer/aktivitaet_runden/aktivitaet_verlauf stehen NUR in Migration 021
-- (braucht die FIT-Tabellen aus 014) -- training_sessions oben ist der Stand vor 021; nach 014/017/020
-- die Migration 021 ausfuehren.
CREATE TABLE IF NOT EXISTS raw.activity_notes (
  id text PRIMARY KEY,            -- Garmin-activityId
  day date,                       -- immer NULL (mode=full)
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON raw.activity_notes TO fuelofit_sync;

-- ===== Wetter je Aktivitaet (044, Migration 022_aktivitaet_wetter.sql) =====
-- raw.aktivitaet_wetter, Rolle fuelofit_wetter_write und die um Wetter-Spalten erweiterten Views
-- training_sessions/lauf_kilometer stehen NUR in Migration 022 (braucht 014/021) -- nach 021 ausfuehren.

-- ===== Lauf-Zusatzwerte (046, Migration 024_lauf_details.sql) =====
-- Neue Spalten in raw.garmin_fit_session/raw.garmin_fit_laps, raw.garmin_fit_zeit_in_zone,
-- raw.garmin_fit_record_extras, views.lauf_details und die erweiterten Views training_sessions/
-- aktivitaet_runden/aktivitaet_verlauf stehen NUR in Migration 024 (braucht 014/021/022) -- nach 023 ausfuehren.

-- ===== Lauf-Zusatzwerte 8-10 (049, Migration 027_lauf_extras_8_10.sql) =====
-- Weitere Spalten in raw.garmin_fit_session/raw.garmin_fit_laps/raw.garmin_fit_record_extras (Atemfrequenz,
-- Bodenkontakt %, Schrittlaenge je Runde, Ausdauer, Schweissverlust, Gefuehl/RPE, Zieltempo) und die erweiterten Views
-- lauf_details/aktivitaet_runden/aktivitaet_verlauf stehen NUR in Migration 027 (braucht 024) -- nach 026 ausfuehren.

-- ===== food_log_zutaten (045, Migration 023_food_log_zutaten.sql) =====
-- Rezept-Bloecke in Zutaten zerlegt; Regeln (herkunft, Faktor, Skalierung, Rest-Zeilen, alkohol)
-- siehe Kopf von migrations/023_food_log_zutaten.sql. Alkohol-Regel zaehlt Rezeptzutaten nie.
CREATE OR REPLACE VIEW views.food_log_zutaten AS
WITH l AS (
  SELECT
    le.id,
    le.day,
    le.data->>'time' AS uhrzeit,
    le.data->>'name' AS lebensmittel,
    (le.data->>'amount')::numeric AS menge,
    le.data->>'unit' AS unit_raw,
    (le.data->>'kcal')::numeric AS kcal,
    (le.data->>'protein')::numeric AS protein,
    (le.data->>'carbs')::numeric AS carbs,
    (le.data->>'fat')::numeric AS fat,
    NULLIF(le.data->>'recipeId', '') AS recipe_id,
    NULLIF(le.data->>'_fromRecipe', '') AS from_recipe,
    le.data->>'foodId' AS food_id,
    split_part(le.id, '_', 1) || '_' || right(le.id, 4) AS entry_id_kurz
  FROM raw.log_entries le
  WHERE le.deleted_at IS NULL AND le.day IS NOT NULL
),
lj AS (
  SELECT
    l.*,
    f.data AS food,
    (l.recipe_id IS NOT NULL OR r_food.id IS NOT NULL) AS ist_block,
    COALESCE(r_rid.data, CASE WHEN l.recipe_id IS NULL THEN r_food.data END) AS rezept_data
  FROM l
  LEFT JOIN raw.foods f ON f.id = l.food_id AND f.deleted_at IS NULL
  LEFT JOIN raw.recipes r_food ON r_food.id = l.food_id AND r_food.deleted_at IS NULL
  LEFT JOIN raw.recipes r_rid ON r_rid.id = l.recipe_id AND r_rid.deleted_at IS NULL
),
-- Bloecke mit Faktor
b AS (
  SELECT
    lj.*,
    lj.rezept_data->>'name' AS rezept_name,
    CASE
      WHEN lj.rezept_data IS NULL THEN NULL
      WHEN lj.unit_raw = 'portions' AND (lj.rezept_data->>'portions')::numeric > 0
        THEN lj.menge / (lj.rezept_data->>'portions')::numeric
      WHEN lj.unit_raw = 'grams' AND (lj.rezept_data->>'totalWeight')::numeric > 0
        THEN lj.menge / (lj.rezept_data->>'totalWeight')::numeric
      WHEN (lj.rezept_data->>'kcal')::numeric > 0
        THEN lj.kcal / (lj.rezept_data->>'kcal')::numeric
    END AS faktor
  FROM lj
  WHERE lj.ist_block
),
-- Zutaten ungeskaliert
z AS (
  SELECT
    b.id AS block_id,
    z.ord,
    zf.id IS NOT NULL AS food_da,
    COALESCE(zf.data->>'name', z.ing->>'name') AS name,
    (z.ing->>'amount')::numeric * b.faktor AS menge,
    zf.data->>'kategorie' AS kategorie,
    zf.data->>'alkohol' AS alkohol,
    CASE WHEN zf.id IS NOT NULL
      THEN (zf.data->>'kcal')::numeric * COALESCE((z.ing->>'amount')::numeric, 100) / 100 * b.faktor
      ELSE (z.ing->>'kcal')::numeric * b.faktor END AS kcal,
    CASE WHEN zf.id IS NOT NULL THEN (zf.data->>'protein')::numeric * COALESCE((z.ing->>'amount')::numeric, 100) / 100
      ELSE (z.ing->>'protein')::numeric END * b.faktor AS protein,
    CASE WHEN zf.id IS NOT NULL THEN (zf.data->>'carbs')::numeric * COALESCE((z.ing->>'amount')::numeric, 100) / 100
      ELSE (z.ing->>'carbs')::numeric END * b.faktor AS carbs,
    CASE WHEN zf.id IS NOT NULL THEN (zf.data->>'fat')::numeric * COALESCE((z.ing->>'amount')::numeric, 100) / 100
      ELSE (z.ing->>'fat')::numeric END * b.faktor AS fat
  FROM b
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.rezept_data->'ingredients', '[]'::jsonb))
    WITH ORDINALITY AS z(ing, ord)
  LEFT JOIN raw.foods zf ON zf.id = z.ing->>'foodId' AND zf.deleted_at IS NULL
  WHERE b.faktor IS NOT NULL
),
bs AS (
  SELECT
    b.*,
    zs.summe_kcal,
    zs.n_da,
    zs.n_fehlt,
    CASE WHEN zs.summe_kcal > 0 THEN b.kcal / zs.summe_kcal END AS s,
    CASE WHEN zs.summe_p > 0 THEN b.protein / zs.summe_p ELSE 0 END AS s_p,
    CASE WHEN zs.summe_c > 0 THEN b.carbs / zs.summe_c ELSE 0 END AS s_c,
    CASE WHEN zs.summe_f > 0 THEN b.fat / zs.summe_f ELSE 0 END AS s_f
  FROM b
  LEFT JOIN (
    SELECT block_id, sum(kcal) AS summe_kcal, sum(protein) AS summe_p, sum(carbs) AS summe_c, sum(fat) AS summe_f,
      count(*) FILTER (WHERE food_da) AS n_da, count(*) FILTER (WHERE NOT food_da) AS n_fehlt
    FROM z GROUP BY block_id
  ) zs ON zs.block_id = b.id
),
-- zerlegbar: Faktor, Vergleichssumme > 0, mind. eine Zutat mit Lebensmittel
zr AS (
  SELECT
    bs.id AS block_id,
    z.ord,
    z.name,
    z.menge,
    z.kategorie,
    z.alkohol,
    round(z.kcal * bs.s, 2) AS kcal,
    round(z.protein * bs.s_p, 2) AS protein,
    round(z.carbs * bs.s_c, 2) AS carbs,
    round(z.fat * bs.s_f, 2) AS fat
  FROM bs JOIN z ON z.block_id = bs.id AND z.food_da
  WHERE bs.s IS NOT NULL AND bs.n_da > 0
),
rest AS (
  SELECT
    bs.id AS block_id,
    bs.kcal - COALESCE(sum(zr.kcal), 0) AS kcal,
    bs.protein - COALESCE(sum(zr.protein), 0) AS protein,
    bs.carbs - COALESCE(sum(zr.carbs), 0) AS carbs,
    bs.fat - COALESCE(sum(zr.fat), 0) AS fat
  FROM bs JOIN zr ON zr.block_id = bs.id
  GROUP BY bs.id, bs.kcal, bs.protein, bs.carbs, bs.fat
  HAVING greatest(abs(bs.kcal - COALESCE(sum(zr.kcal), 0)), abs(bs.protein - COALESCE(sum(zr.protein), 0)),
                  abs(bs.carbs - COALESCE(sum(zr.carbs), 0)), abs(bs.fat - COALESCE(sum(zr.fat), 0))) >= 0.05
)
-- 1) direkt + rezept_expandiert (wie food_log_entries)
SELECT
  lj.day, lj.uhrzeit, lj.lebensmittel, lj.menge,
  CASE lj.unit_raw WHEN 'grams' THEN 'g' WHEN 'portions' THEN 'portion' ELSE 'g' END AS einheit,
  lj.kcal, lj.protein, lj.carbs, lj.fat,
  COALESCE(lj.food->>'kategorie', 'unbekannt') AS kategorie,
  lj.from_recipe AS aus_rezept,
  lj.food->>'alkohol' AS alkohol,
  lj.entry_id_kurz AS entry_id,
  CASE WHEN lj.from_recipe IS NOT NULL THEN 'rezept_expandiert' ELSE 'direkt' END AS herkunft,
  lj.from_recipe AS rezept,
  NULL::numeric AS skalierung,
  NULL::numeric AS abweichung_pct
FROM lj
WHERE NOT lj.ist_block
UNION ALL
-- 2) rezept_zerlegt
SELECT
  bs.day, bs.uhrzeit, zr.name, round(zr.menge, 1), 'g',
  zr.kcal, zr.protein, zr.carbs, zr.fat,
  COALESCE(zr.kategorie, 'unbekannt'),
  bs.rezept_name,
  zr.alkohol,
  bs.entry_id_kurz,
  'rezept_zerlegt',
  bs.rezept_name,
  round(bs.faktor, 4),
  round((bs.summe_kcal - bs.kcal) / NULLIF(bs.kcal, 0) * 100, 1)
FROM bs JOIN zr ON zr.block_id = bs.id
UNION ALL
-- 3a) Rest eines zerlegten Blocks (fehlende Zutaten-Lebensmittel, Makro ohne Zutatenwert, Rundung)
SELECT
  bs.day, bs.uhrzeit,
  'Rest ' || COALESCE(bs.rezept_name, bs.lebensmittel, 'Rezept') || COALESCE(
    ' (Zutat ohne Lebensmittel: ' ||
      (SELECT string_agg(z.name, ', ' ORDER BY z.ord) FROM z WHERE z.block_id = bs.id AND NOT z.food_da) || ')',
    ' (Rundung/Makro ohne Zutatenwert)'),
  NULL::numeric, 'g',
  rest.kcal, rest.protein, rest.carbs, rest.fat,
  'gerichte',
  bs.rezept_name,
  NULL,
  bs.entry_id_kurz,
  'rezept_nicht_zerlegbar',
  bs.rezept_name,
  round(bs.faktor, 4),
  round((bs.summe_kcal - bs.kcal) / NULLIF(bs.kcal, 0) * 100, 1)
FROM bs JOIN rest ON rest.block_id = bs.id
UNION ALL
-- 3b) Block gar nicht zerlegbar (kein Rezept, keine Zutaten, kein Faktor, nur fehlende Lebensmittel)
SELECT
  bs.day, bs.uhrzeit, bs.lebensmittel, bs.menge,
  CASE bs.unit_raw WHEN 'grams' THEN 'g' WHEN 'portions' THEN 'portion' ELSE 'g' END,
  bs.kcal, bs.protein, bs.carbs, bs.fat,
  'gerichte',
  bs.rezept_name,
  NULL,
  bs.entry_id_kurz,
  'rezept_nicht_zerlegbar',
  bs.rezept_name,
  round(bs.faktor, 4),
  round((bs.summe_kcal - bs.kcal) / NULLIF(bs.kcal, 0) * 100, 1)
FROM bs
WHERE NOT (bs.s IS NOT NULL AND COALESCE(bs.n_da, 0) > 0);

GRANT SELECT ON views.food_log_zutaten TO fuelofit_ro;

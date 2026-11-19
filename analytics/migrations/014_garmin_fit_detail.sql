-- Migration 014: FIT-Detaildaten der Garmin-Aktivitaeten (Aufgabe 022 Teil B).
--
-- Neuer, eigener Schreibpfad NEBEN dem bestehenden Firestore-Sync: der Garmin-VPS-Client
-- (User `fuelofit`, Repo fuelofit-functions vps/garmin/) laedt pro Aktivitaet zusaetzlich die
-- FIT-Datei (bereits im Client vorhanden, `garmin_official.py: download_activity`, bisher nicht
-- genutzt), parst sie (fitparse 1.2.0 -- identische Version wie in den Berichten 007a/007a2
-- validiert) und schreibt das Ergebnis DIREKT in diese drei Tabellen -- NICHT ueber
-- exportAnalytics/sync.py (das bleibt ausschliesslich Firestore -> Postgres) und NICHT nach
-- Firestore (Begruendung Konzept-Zwischenstand Aufgabe 022: ~4.000 Sekunden-Records je Lauf,
-- die App braucht sie nie). Deshalb hier KEIN `day`/`deleted_at`/`synced_at`-Dreiklang wie bei
-- den raw.*-Tabellen aus Phase 1a (kein Soft-Delete-Fenster-Sync, einmaliges Schreiben je
-- Aktivitaet) -- `day` ist eine generierte Spalte aus `start_time`, Zeitzone Europe/Berlin
-- (vermeidet den UTC-Off-by-one aus den bekannten Fallstricken).
--
-- GPS (Positionen) steht NUR hier in raw (Session-Start/-Ende fuer die Strecken-Erkennung) --
-- niemals in Schema views (Auftragsvorgabe Punkt 7/8). Die Record-Tabelle speichert bewusst
-- KEINE Positionen (nicht gebraucht; reduziert Zeilenbreite bei ~4.000 Zeilen/Lauf).
--
-- Feldnamen gegen eine reale FIT-Datei (heutiger Lauf, activityId 25129351274) mit fitparse
-- 1.2.0 geprueft (session/lap/record/device_info-Nachrichten) -- siehe Bericht 022.
--
-- Idempotent (CREATE TABLE/ROLE IF NOT EXISTS). Ausfuehrung auf dem VPS als Rolle `postgres`:
--   psql -d fuelofit_analytics -f 014_garmin_fit_detail.sql
-- Passwort fuer die neue Rolle NICHT hier (dieses File wird committet) -- separat per
-- `ALTER ROLE fuelofit_fit_write PASSWORD '...'` direkt auf dem VPS setzen und in
-- /home/fuelofit/.pgpass (600, Owner fuelofit) ablegen -- analog fuelofit_sync/fuelofit_ro.

-- ===== Neue Rolle: nur Schreibrecht auf die 3 neuen Tabellen, NICHT auf das uebrige raw.* =====
-- Bewusst getrennt von fuelofit_sync (das ist exportAnalytics/sync.py, User fuelofit-analytics,
-- eine andere Maschine/Rolle als der Garmin-Sync unter User fuelofit).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fuelofit_fit_write') THEN
    CREATE ROLE fuelofit_fit_write LOGIN;
  END IF;
END
$$;
ALTER ROLE fuelofit_fit_write LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE fuelofit_fit_write SET statement_timeout = '30s';

GRANT USAGE ON SCHEMA raw TO fuelofit_fit_write;

-- ===== Strecken-Erkennung (Lookup, GPS NUR hier) =====
-- Methode (angewendet vom Python-Parser, nicht in SQL): neue Aktivitaet vs. jede vorhandene Zeile
-- hier -- Start- UND Endpunkt (Haversine) je <= 200 m UND Gesamtdistanz-Differenz <= 5 % relativ
-- zu ref_distance_m => bestehende strecke_id wiederverwenden; sonst neue Zeile anlegen. Nur
-- Aktivitaeten mit gueltigen Start-/Endkoordinaten bekommen eine strecke_id (sonst NULL).
CREATE TABLE IF NOT EXISTS raw.garmin_fit_strecken (
  strecke_id            serial PRIMARY KEY,
  ref_start_lat          double precision NOT NULL,
  ref_start_lon          double precision NOT NULL,
  ref_end_lat            double precision NOT NULL,
  ref_end_lon            double precision NOT NULL,
  ref_distance_m         numeric NOT NULL,
  first_seen_activity_id bigint NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ===== Session (eine Zeile je Aktivitaet) =====
CREATE TABLE IF NOT EXISTS raw.garmin_fit_session (
  activity_id                  bigint PRIMARY KEY,
  fit_sport                    text,
  fit_sub_sport                text,
  start_time                   timestamptz NOT NULL,
  day                          date GENERATED ALWAYS AS ((start_time AT TIME ZONE 'Europe/Berlin')::date) STORED,
  total_elapsed_time_sec       numeric,
  total_timer_time_sec         numeric,
  total_distance_m             numeric,
  total_ascent_m                integer,
  total_descent_m               integer,
  avg_heart_rate                integer,
  max_heart_rate                integer,
  avg_speed_ms                  numeric,
  max_speed_ms                  numeric,
  avg_cadence_spm                numeric,
  max_cadence_spm                numeric,
  avg_power_w                    integer,
  max_power_w                    integer,
  normalized_power_w             integer,
  avg_ground_contact_ms          numeric,
  avg_vertical_oscillation_cm    numeric,
  avg_vertical_ratio_pct         numeric,
  avg_stance_balance_pct         numeric,
  avg_step_length_m              numeric,
  total_calories                 integer,
  training_effect_aerobic        numeric,
  training_effect_anaerobic      numeric,
  hr_source                      text,        -- 'brustgurt' | 'handgelenk' | 'unbekannt' (aus device_info antplus_device_type)
  hr_device_manufacturer         text,
  num_laps                       integer,
  start_lat_deg                  double precision,   -- GPS, bleibt in raw
  start_lon_deg                  double precision,
  end_lat_deg                    double precision,
  end_lon_deg                    double precision,
  strecke_id                     integer REFERENCES raw.garmin_fit_strecken(strecke_id),
  fit_file_path                  text NOT NULL,       -- Archiv-Pfad auf dem VPS, siehe Konzept
  fit_file_sha256                text NOT NULL,
  parsed_at                      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS garmin_fit_session_day_idx ON raw.garmin_fit_session (day);

-- ===== Laps (Runden wie von der Uhr aufgezeichnet, eine Zeile je Lap) =====
CREATE TABLE IF NOT EXISTS raw.garmin_fit_laps (
  activity_id             bigint NOT NULL REFERENCES raw.garmin_fit_session(activity_id) ON DELETE CASCADE,
  lap_index               integer NOT NULL,       -- FIT message_index, 0-basiert
  start_time              timestamptz,
  lap_trigger             text,                   -- u. a. 'distance' (Auto-Lap), 'manual'
  total_elapsed_time_sec  numeric,
  total_timer_time_sec    numeric,
  total_distance_m        numeric,
  total_ascent_m          integer,
  total_descent_m         integer,
  avg_heart_rate          integer,
  max_heart_rate          integer,
  avg_speed_ms            numeric,
  avg_cadence_spm         numeric,
  max_cadence_spm         numeric,
  avg_power_w             integer,
  max_power_w             integer,
  normalized_power_w      integer,
  avg_ground_contact_ms   numeric,
  avg_vertical_oscillation_cm numeric,
  avg_vertical_ratio_pct  numeric,
  avg_stance_balance_pct  numeric,
  total_calories          integer,
  PRIMARY KEY (activity_id, lap_index)
);

-- ===== Records (1-Sekunden-Raster je Aktivitaet) =====
CREATE TABLE IF NOT EXISTS raw.garmin_fit_records (
  activity_id         bigint NOT NULL REFERENCES raw.garmin_fit_session(activity_id) ON DELETE CASCADE,
  elapsed_sec         integer NOT NULL,     -- Sekunden seit start_time (timestamp - start_time)
  record_time         timestamptz NOT NULL,
  distance_m          numeric,
  speed_ms            numeric,
  heart_rate          integer,
  cadence_spm         numeric,
  altitude_m          numeric,
  power_w             integer,
  ground_contact_ms   numeric,
  vertical_oscillation_cm numeric,
  vertical_ratio_pct  numeric,
  PRIMARY KEY (activity_id, elapsed_sec)
);

-- ===== Rechte: fuelofit_fit_write NUR auf diese 4 Tabellen, sonst nichts in raw =====
GRANT SELECT, INSERT, UPDATE ON raw.garmin_fit_strecken TO fuelofit_fit_write;
GRANT SELECT, INSERT, UPDATE ON raw.garmin_fit_session TO fuelofit_fit_write;
GRANT SELECT, INSERT, UPDATE ON raw.garmin_fit_laps TO fuelofit_fit_write;
GRANT SELECT, INSERT, UPDATE ON raw.garmin_fit_records TO fuelofit_fit_write;
GRANT USAGE, SELECT ON SEQUENCE raw.garmin_fit_strecken_strecke_id_seq TO fuelofit_fit_write;

-- fuelofit_ro bekommt KEINEN Zugriff auf raw (gleiches Prinzip wie der Rest von raw, s. schema.sql) --
-- Zugriff nur ueber die views.* unten (ALTER DEFAULT PRIVILEGES aus schema.sql deckt neue Views
-- im Schema views automatisch ab, solange sie vom selben Akteur (postgres) angelegt werden).

-- ===== views.lauf_kilometer: je Aktivitaet x vollem km =====
-- Methode identisch zu den Berichten 007a/007a2: km-Aufteilung = Auto-Lap des Geraets
-- (lap_trigger = 'distance'; Daniels Uhr ist auf 1-km-Auto-Lap eingestellt, siehe Probelauf
-- gegen 007a/007a2 im Bericht 022). km_nr = lap_index + 1. DER LETZTE LAP EINER AKTIVITAET HAT
-- lap_trigger = 'session_end' (Geraet beendet den letzten, unvollstaendigen km-Lap nicht per
-- Distanz, sondern beim Stop) -- das ist genau der in den Berichten als "12,5 (0,497 km)" /
-- "13,01 (11 m, 3 s)" gefuehrte Rest-km und MUSS mit rein (ist_rest_km=true), sonst fehlt die
-- letzte Zeile (im ersten Probelauf-Versuch so aufgefallen, Bericht 022 Teil B Punkt 10).
-- dauer_sek = total_timer_time_sec (Timerzeit OHNE Pausen, wie in den Berichten: "Pace =
-- Timerzeit/Lap-Distanz"). Aktivitaeten ohne 1-km-Auto-Lap (z. B. nur manuelle Laps) liefern
-- hier keine Zeilen -- sie erscheinen vollstaendig in aktivitaet_runden.
CREATE OR REPLACE VIEW views.lauf_kilometer AS
SELECT
  'garmin_' || l.activity_id                     AS entry_id,
  l.activity_id,
  s.day,
  (l.lap_index + 1)::int                          AS km_nr,
  (l.lap_trigger <> 'distance' OR l.total_distance_m < 950) AS ist_rest_km,
  l.total_distance_m                              AS distanz_m,
  l.total_timer_time_sec                          AS dauer_sek,
  CASE WHEN l.total_distance_m > 0
       THEN round((l.total_timer_time_sec / 60) / (l.total_distance_m / 1000), 2)
  END                                              AS pace_min_km,
  l.avg_heart_rate                                AS hf_avg,
  l.max_heart_rate                                 AS hf_max,
  l.total_ascent_m                                 AS hoehenmeter_auf,
  l.total_descent_m                                AS hoehenmeter_ab,
  l.avg_cadence_spm                                AS kadenz_avg,
  l.avg_power_w                                    AS leistung_avg,
  l.avg_ground_contact_ms                          AS bodenkontaktzeit_avg_ms,
  s.strecke_id
FROM raw.garmin_fit_laps l
JOIN raw.garmin_fit_session s ON s.activity_id = l.activity_id
WHERE l.lap_trigger = 'distance'
   OR (l.lap_trigger = 'session_end' AND l.lap_index = s.num_laps - 1)
ORDER BY l.activity_id, l.lap_index;

GRANT SELECT ON views.lauf_kilometer TO fuelofit_ro;

-- ===== views.aktivitaet_runden: Laps wie von der Uhr aufgezeichnet (ALLE Trigger-Arten) =====
CREATE OR REPLACE VIEW views.aktivitaet_runden AS
SELECT
  'garmin_' || l.activity_id    AS entry_id,
  l.activity_id,
  s.day,
  l.lap_index,
  l.lap_trigger,
  l.total_distance_m             AS distanz_m,
  l.total_timer_time_sec         AS dauer_sek,
  l.total_elapsed_time_sec       AS dauer_gesamt_sek,
  l.avg_heart_rate                AS hf_avg,
  l.max_heart_rate                 AS hf_max,
  l.total_ascent_m                 AS hoehenmeter_auf,
  l.total_descent_m                AS hoehenmeter_ab,
  l.avg_cadence_spm                AS kadenz_avg,
  l.max_cadence_spm                AS kadenz_max,
  l.avg_power_w                     AS leistung_avg,
  l.max_power_w                     AS leistung_max,
  l.normalized_power_w              AS leistung_np,
  l.avg_ground_contact_ms            AS bodenkontaktzeit_avg_ms,
  l.avg_vertical_oscillation_cm      AS vert_oszillation_avg_cm,
  l.avg_vertical_ratio_pct           AS vert_verhaeltnis_avg_pct,
  l.avg_stance_balance_pct           AS bodenkontakt_balance_pct,
  l.total_calories                   AS kcal,
  s.strecke_id
FROM raw.garmin_fit_laps l
JOIN raw.garmin_fit_session s ON s.activity_id = l.activity_id
ORDER BY l.activity_id, l.lap_index;

GRANT SELECT ON views.aktivitaet_runden TO fuelofit_ro;

-- ===== views.aktivitaet_verlauf: Records auf 10-Sekunden-Raster verdichtet =====
-- fuer HF-Drift/Effizienz im Chat (ohne GPS, ohne 1-s-Rohdaten).
CREATE OR REPLACE VIEW views.aktivitaet_verlauf AS
SELECT
  'garmin_' || r.activity_id          AS entry_id,
  r.activity_id,
  s.day,
  (r.elapsed_sec / 10) * 10            AS bucket_sek,
  round(avg(r.distance_m), 1)          AS distanz_m_avg,
  round(avg(r.speed_ms)::numeric, 3)   AS speed_ms_avg,
  CASE WHEN avg(r.speed_ms) > 0
       THEN round((1.0 / avg(r.speed_ms) / 60 * 1000)::numeric, 2)
  END                                   AS pace_min_km_avg,
  round(avg(r.heart_rate)::numeric, 1)  AS hf_avg,
  round(avg(r.cadence_spm)::numeric, 1) AS kadenz_avg,
  round(avg(r.altitude_m)::numeric, 1)  AS hoehe_m_avg,
  round(avg(r.power_w)::numeric, 1)     AS leistung_avg
FROM raw.garmin_fit_records r
JOIN raw.garmin_fit_session s ON s.activity_id = r.activity_id
GROUP BY r.activity_id, s.day, (r.elapsed_sec / 10) * 10
ORDER BY r.activity_id, bucket_sek;

GRANT SELECT ON views.aktivitaet_verlauf TO fuelofit_ro;

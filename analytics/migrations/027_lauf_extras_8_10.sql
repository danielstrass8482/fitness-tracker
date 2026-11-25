-- Migration 027: Lauf-Zusatzwerte 8-10 aus dem FIT-Archiv (Aufgabe 049, Bericht 043 Kandidaten 8-10).
--
-- Geschrieben von fit_sync.parse_run_extras/store_run_extras (EXTRAS_VERSION 2, fuelofit-functions vps/garmin,
-- Rolle fuelofit_fit_write), nur Laeufe; Altbestand per backfill_lauf_extras_046.py aus fit_archive (kein Download).
-- Quellen (FIT-Nachricht/Feld; Konfidenz SDK = offizielles FIT-SDK-Profil 21.222, inferred/community = undokumentiert):
--   atemfrequenz_avg/max/min  session f169/f170/f180, lap f136/f137, record f108 (SDK enhanced_*_respiration_rate,
--        /100 Atemzuege/min). NUR MIT BRUSTGURT (ab 03/2026; ohne Gurt NULL). Werte ausserhalb 5..90 -> NULL.
--   bodenkontakt_pct  session f90 / lap f78 (SDK avg_stance_time_percent). NUR MIT POD (ab 05/2026; sonst NULL).
--   schrittlaenge_m (lap)  lap f120 (SDK avg_step_length, mm -> m); Session-Wert steht schon in avg_step_length_m.
--        Ohne Pod/Gurt Uhr-Schaetzung (Schrittlaenge = Distanz/Schritte, Kadenz vom Handgelenk).
--   leistung_avg/np, vert_oszillation, vert_verhaeltnis: vorhandene Spalten avg_power_w, normalized_power_w,
--        avg_vertical_oscillation_cm, avg_vertical_ratio_pct (seit 2024 in jedem Lauf; ohne Pod/Gurt Uhr-Schaetzung,
--        Flag laufdynamik_verwertbar aus 042).
--   ausdauer_start/ende/min_pct  session f205/f206/f207 (inferred: = record f137/f138 Anfangs-/Endwert, 0..100 %).
--   schweissverlust_ml  session f178 (inferred, Garmin-Schaetzung).
--   gefuehl_roh  session f192 (SDK workout_feel 0/25/50/75/100 = sehr schwach..sehr stark, community-Zuordnung).
--   rpe_roh      session f193 (SDK workout_rpe, roh 10..100; RPE = roh/10, community). Eigene Eingabe nach dem
--        Lauf, ab 2026.
--   workout_schritte, ziel_speed_low/high_ms  workout_step custom_target_speed_low/high (SDK, m/s), nur
--        target_type speed. Session-Wert nur, wenn alle Haupt-Schritte (intensity active/interval) dasselbe Fenster
--        haben, sonst NULL -> je Runde ueber lap f71 wkt_step_index (raw.garmin_fit_laps.ziel_*).
--   raw.garmin_fit_record_extras.atemfrequenz  record f108 (/100).
-- Nicht uebernommen: Ausdauer je Record (f137/f138), lap f145/f152 (undekodiert), HF-Zielbereiche von Workouts,
-- Workout-Name (Freitext mit Ortsnamen).
-- Views: Spalten ANGEHAENGT an views.lauf_details, views.aktivitaet_runden, views.aktivitaet_verlauf (bisherige
-- Spalten/Reihenfolge unveraendert, Definitionen sonst wie 024). Keine GPS-Spalten.
-- Idempotent. Ausfuehrung als postgres: psql -d fuelofit_analytics -v ON_ERROR_STOP=1 -1 -f 027_lauf_extras_8_10.sql

ALTER TABLE raw.garmin_fit_session
  ADD COLUMN IF NOT EXISTS atemfrequenz_avg    numeric(5,2),
  ADD COLUMN IF NOT EXISTS atemfrequenz_max    numeric(5,2),
  ADD COLUMN IF NOT EXISTS atemfrequenz_min    numeric(5,2),
  ADD COLUMN IF NOT EXISTS bodenkontakt_pct    numeric(5,2),
  ADD COLUMN IF NOT EXISTS ausdauer_start_pct  smallint,
  ADD COLUMN IF NOT EXISTS ausdauer_ende_pct   smallint,
  ADD COLUMN IF NOT EXISTS ausdauer_min_pct    smallint,
  ADD COLUMN IF NOT EXISTS schweissverlust_ml  integer,
  ADD COLUMN IF NOT EXISTS gefuehl_roh         smallint,
  ADD COLUMN IF NOT EXISTS rpe_roh             smallint,
  ADD COLUMN IF NOT EXISTS workout_schritte    smallint,
  ADD COLUMN IF NOT EXISTS ziel_speed_low_ms   numeric(6,3),
  ADD COLUMN IF NOT EXISTS ziel_speed_high_ms  numeric(6,3);

ALTER TABLE raw.garmin_fit_laps
  ADD COLUMN IF NOT EXISTS atemfrequenz_avg    numeric(5,2),
  ADD COLUMN IF NOT EXISTS atemfrequenz_max    numeric(5,2),
  ADD COLUMN IF NOT EXISTS schrittlaenge_m     numeric(6,4),
  ADD COLUMN IF NOT EXISTS bodenkontakt_pct    numeric(5,2),
  ADD COLUMN IF NOT EXISTS wkt_step_index      smallint,
  ADD COLUMN IF NOT EXISTS ziel_speed_low_ms   numeric(6,3),
  ADD COLUMN IF NOT EXISTS ziel_speed_high_ms  numeric(6,3),
  ADD COLUMN IF NOT EXISTS ziel_intensitaet    text;

ALTER TABLE raw.garmin_fit_record_extras ADD COLUMN IF NOT EXISTS atemfrequenz numeric(5,2);

-- ===== views.lauf_details: Definition aus 024 + Kandidaten 8-10 angehaengt =====
CREATE OR REPLACE VIEW views.lauf_details AS
SELECT
  'garmin_' || s.activity_id AS entry_id,
  s.activity_id,
  s.day,
  s.start_time AT TIME ZONE 'Europe/Berlin' AS start_lokal,
  s.uhr_temp_c_mittel     AS uhr_luft_temp_c_mittel,
  s.uhr_temp_c_min        AS uhr_luft_temp_c_min,
  s.uhr_temp_c_max        AS uhr_luft_temp_c_max,
  s.uhr_luftfeuchte_pct_mittel,
  s.vo2max_vorher,
  s.vo2max_nachher,
  s.trainingslast,
  round(s.erholungszeit_min / 60.0, 1) AS erholungszeit_h,
  CASE s.trainingsnutzen_code
    WHEN 0 THEN 'kein' WHEN 1 THEN 'erholung' WHEN 2 THEN 'grundlage' WHEN 3 THEN 'tempo'
    WHEN 4 THEN 'schwelle' WHEN 5 THEN 'vo2max' WHEN 6 THEN 'anaerob' WHEN 7 THEN 'sprint'
  END AS trainingsnutzen,
  s.leistungszustand_ende,
  z.hf_zone_sek[2] AS zeit_zone_1_sek,
  z.hf_zone_sek[3] AS zeit_zone_2_sek,
  z.hf_zone_sek[4] AS zeit_zone_3_sek,
  z.hf_zone_sek[5] AS zeit_zone_4_sek,
  z.hf_zone_sek[6] AS zeit_zone_5_sek,
  CASE WHEN s.gap_speed_ms > 0 THEN round(1000 / s.gap_speed_ms / 60, 2) END AS gap_pace_min_km,
  s.zeit_laufen_sek,
  s.zeit_gehen_sek,
  s.zeit_stehen_sek,
  s.hf_handgelenk_avg,
  s.hf_gurt_avg,
  s.hf_diff_avg,
  sx.hf_quelle,
  sx.laufdynamik_quelle,
  sx.hf_verwertbar,
  sx.laufdynamik_verwertbar,
  sx.notiz,
  w.temp_c_mittel,
  w.gefuehlt_c_mittel,
  w.luftfeuchte_pct_mittel,
  CASE WHEN w.quelle IN ('brightsky_dwd', 'open_meteo') THEN w.quelle END AS wetter_quelle,
  -- Zusatz: Zeit unter Zone 1 / ueber Max-HF (damit Summe = Timer-Zeit), Zonengrenzen der Uhr, Tempo, Timer-Zeit
  z.hf_zone_sek[1] AS zeit_unter_zone_1_sek,
  z.hf_zone_sek[7] AS zeit_ueber_zone_5_sek,
  array_to_string(z.hf_zone_grenzen, '/') AS hf_zonen_grenzen,
  CASE WHEN s.avg_speed_ms > 0 THEN round(1000 / s.avg_speed_ms / 60, 2) END AS pace_min_km,
  s.total_timer_time_sec AS timer_sek,
  s.uhr_temp_c_start AS uhr_luft_temp_c_start,
  s.uhr_wetter_werte,
  -- Migration 027 (Aufgabe 049): Kandidaten 8-10 aus Bericht 043
  s.atemfrequenz_avg,                                    -- nur mit Gurt (sonst NULL)
  s.atemfrequenz_max,
  s.avg_power_w           AS leistung_avg,               -- Garmin-Laufleistung (Uhr/Pod)
  s.normalized_power_w    AS leistung_np,
  s.avg_step_length_m     AS schrittlaenge_m_avg,
  s.avg_vertical_oscillation_cm AS vert_oszillation_cm,  -- ohne Pod/Gurt: Uhr-Schaetzung (laufdynamik_verwertbar)
  s.avg_vertical_ratio_pct AS vert_verhaeltnis_pct,
  s.bodenkontakt_pct,                                    -- nur mit Pod (sonst NULL)
  s.ausdauer_start_pct,
  s.ausdauer_ende_pct,
  s.schweissverlust_ml,
  CASE s.gefuehl_roh WHEN 0 THEN 'sehr_schwach' WHEN 25 THEN 'schwach' WHEN 50 THEN 'normal'
       WHEN 75 THEN 'stark' WHEN 100 THEN 'sehr_stark' END AS gefuehl,
  round(s.rpe_roh / 10.0, 1) AS rpe,
  CASE WHEN s.ziel_speed_high_ms > 0 THEN round(1000 / s.ziel_speed_high_ms / 60, 2) END AS ziel_pace_min,
  CASE WHEN s.ziel_speed_low_ms > 0 THEN round(1000 / s.ziel_speed_low_ms / 60, 2) END AS ziel_pace_max,
  s.atemfrequenz_min,
  s.ausdauer_min_pct,
  s.workout_schritte
FROM raw.garmin_fit_session s
LEFT JOIN raw.garmin_fit_zeit_in_zone z ON z.activity_id = s.activity_id AND z.ref_mesg = 18 AND z.ref_index = 0
LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
LEFT JOIN raw.aktivitaet_wetter w ON w.activity_id = s.activity_id
WHERE s.fit_sport = 'running';
GRANT SELECT ON views.lauf_details TO fuelofit_ro;

-- ===== views.aktivitaet_runden: Definition aus 024 + Atemfrequenz/Schrittlaenge/Bodenkontakt %/Zieltempo je Runde =====
CREATE OR REPLACE VIEW views.aktivitaet_runden AS
SELECT 'garmin_'::text || l.activity_id AS entry_id,
    l.activity_id,
    s.day,
    l.lap_index,
    l.lap_trigger,
    l.total_distance_m AS distanz_m,
    l.total_timer_time_sec AS dauer_sek,
    l.total_elapsed_time_sec AS dauer_gesamt_sek,
    l.avg_heart_rate AS hf_avg,
    l.max_heart_rate AS hf_max,
    l.total_ascent_m AS hoehenmeter_auf,
    l.total_descent_m AS hoehenmeter_ab,
    l.avg_cadence_spm AS kadenz_avg,
    l.max_cadence_spm AS kadenz_max,
    l.avg_power_w AS leistung_avg,
    l.max_power_w AS leistung_max,
    l.normalized_power_w AS leistung_np,
    l.avg_ground_contact_ms AS bodenkontaktzeit_avg_ms,
    l.avg_vertical_oscillation_cm AS vert_oszillation_avg_cm,
    l.avg_vertical_ratio_pct AS vert_verhaeltnis_avg_pct,
    l.avg_stance_balance_pct AS bodenkontakt_balance_pct,
    l.total_calories AS kcal,
    s.strecke_id,
    (s.start_time AT TIME ZONE 'Europe/Berlin'::text) AS start_lokal,
    sx.hf_quelle,
    sx.laufdynamik_quelle,
    sx.hf_verwertbar,
    sx.laufdynamik_verwertbar,
    sx.notiz,
    z.hf_zone_sek[2] AS zeit_zone_1_sek,
    z.hf_zone_sek[3] AS zeit_zone_2_sek,
    z.hf_zone_sek[4] AS zeit_zone_3_sek,
    z.hf_zone_sek[5] AS zeit_zone_4_sek,
    z.hf_zone_sek[6] AS zeit_zone_5_sek,
    CASE WHEN l.gap_speed_ms > 0 THEN round(1000 / l.gap_speed_ms / 60, 2) END AS gap_pace_min_km,
    z.hf_zone_sek[1] AS zeit_unter_zone_1_sek,
    z.hf_zone_sek[7] AS zeit_ueber_zone_5_sek,
    -- Migration 027 (Aufgabe 049)
    l.atemfrequenz_avg,
    l.atemfrequenz_max,
    l.schrittlaenge_m,
    l.bodenkontakt_pct,
    CASE WHEN l.ziel_speed_high_ms > 0 THEN round(1000 / l.ziel_speed_high_ms / 60, 2) END AS ziel_pace_min,
    CASE WHEN l.ziel_speed_low_ms > 0 THEN round(1000 / l.ziel_speed_low_ms / 60, 2) END AS ziel_pace_max,
    CASE l.ziel_intensitaet WHEN 'active' THEN 'aktiv' WHEN 'warmup' THEN 'aufwaermen' WHEN 'cooldown' THEN 'auslaufen'
         WHEN 'rest' THEN 'pause' WHEN '4' THEN 'erholung' WHEN '5' THEN 'intervall' ELSE l.ziel_intensitaet END
      AS ziel_intensitaet,
    l.wkt_step_index AS workout_schritt
   FROM raw.garmin_fit_laps l
     JOIN raw.garmin_fit_session s ON s.activity_id = l.activity_id
     LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
     LEFT JOIN raw.garmin_fit_zeit_in_zone z ON z.activity_id = l.activity_id AND z.ref_mesg = 19 AND z.ref_index = l.lap_index
  ORDER BY l.activity_id, l.lap_index;
GRANT SELECT ON views.aktivitaet_runden TO fuelofit_ro;

-- ===== views.aktivitaet_verlauf: Definition aus 024 + Atemfrequenz je 10-s-Bucket =====
CREATE OR REPLACE VIEW views.aktivitaet_verlauf AS
SELECT 'garmin_'::text || r.activity_id AS entry_id,
    r.activity_id,
    s.day,
    r.elapsed_sec / 10 * 10 AS bucket_sek,
    round(avg(r.distance_m), 1) AS distanz_m_avg,
    round(avg(r.speed_ms), 3) AS speed_ms_avg,
        CASE
            WHEN avg(r.speed_ms) > 0::numeric THEN round(1.0 / avg(r.speed_ms) / 60::numeric * 1000::numeric, 2)
            ELSE NULL::numeric
        END AS pace_min_km_avg,
    round(avg(r.heart_rate), 1) AS hf_avg,
    round(avg(r.cadence_spm), 1) AS kadenz_avg,
    round(avg(r.altitude_m), 1) AS hoehe_m_avg,
    round(avg(r.power_w), 1) AS leistung_avg,
    sx.hf_quelle,
    sx.laufdynamik_quelle,
    sx.hf_verwertbar,
    sx.laufdynamik_verwertbar,
    sx.notiz,
    round(avg(x.hf_handgelenk), 1) AS hf_handgelenk_avg,
    round(avg(x.leistungszustand), 1) AS leistungszustand,
    round(avg(x.atemfrequenz), 1) AS atemfrequenz_avg  -- Migration 027 (049), nur mit Gurt
   FROM raw.garmin_fit_records r
     JOIN raw.garmin_fit_session s ON s.activity_id = r.activity_id
     LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
     LEFT JOIN raw.garmin_fit_record_extras x ON x.activity_id = r.activity_id AND x.elapsed_sec = r.elapsed_sec
  GROUP BY r.activity_id, s.day, (r.elapsed_sec / 10 * 10), sx.hf_quelle, sx.laufdynamik_quelle, sx.hf_verwertbar, sx.laufdynamik_verwertbar, sx.notiz
  ORDER BY r.activity_id, (r.elapsed_sec / 10 * 10);
GRANT SELECT ON views.aktivitaet_verlauf TO fuelofit_ro;

-- Migration 024: Lauf-Zusatzwerte aus dem FIT-Archiv (Aufgabe 046, Bericht 043 Kandidaten 1-7).
--
-- Geschrieben von fit_sync.parse_run_extras/store_run_extras (fuelofit-functions vps/garmin, Rolle fuelofit_fit_write),
-- nur Laeufe (fit_sport 'running'); Altbestand einmalig per backfill_lauf_extras_046.py aus fit_archive (kein Download).
-- Quellen (FIT-Nachricht/Feld; Konfidenz SDK = offizielles FIT-SDK-Profil, inferred/community = undokumentiert):
--   uhr_temp_c_*/uhr_luftfeuchte_pct_mittel  msg 288 f0/f1 (inferred): Handy-Wetter, ganze Grad C, ca. alle 30 min.
--        Werte <= -100 = keine Daten. Folgt einem Wert binnen 120 s ein neuer, gilt nur der neue (erster Wert oft
--        veraltet, Bericht 043/046). Nur Werte im Fenster Start-120 s .. Ende (total_elapsed_time). mittel = Mittel der Werte.
--   vo2max_vorher  msg 79 (user_metrics) f17 x 3,5/65536 (community); = vo2max_nachher des vorigen Laufs (Kette geprueft).
--   vo2max_nachher msg 140 (activity_metrics) f27 x 3,5/65536 (community). Garmin-Schaetzung, dekodiert.
--   trainingslast  session f168 / 65536 (SDK-Name training_load_peak). erholungszeit_min msg 140 f9 (inferred, max 5760).
--   trainingsnutzen_code session f188, Fallback msg 140 f41 (inferred; 1 Erholung, 2 Grundlage, 3 Tempo, 4 Schwelle,
--        5 VO2max, 6 anaerob, 7 Sprint - Zuordnung 2/3/5 gegen Zonenverteilung plausibilisiert, Rest community).
--   leistungszustand_ende msg 140 f17 (sint8, inferred), Fallback letzter Record-Wert f90.
--   gap_speed_ms  session f211 / lap f161 (SDK avg_grade_adjusted_speed, /1000 m/s).
--   zeit_laufen/gehen/stehen_sek  msg 312 split_type 17/18/22 (SDK rwd_run/walk/stand), Summe total_timer_time
--        (Splits nach dem Timer-Stopp haben Timer-Zeit 0 und zaehlen nicht).
--   hf_handgelenk_avg/hf_gurt_avg/hf_diff_avg  record f136 (optische HF, inferred) / record f144 (Kopie der Gurt-HF,
--        nur mit Gurt, inferred); diff = Mittel(Handgelenk - Gurt) ueber Records mit beiden Werten.
--   raw.garmin_fit_zeit_in_zone  msg 216 (SDK time_in_zone), ref_mesg 18 = Session, 19 = Lap (ref_index = lap_index).
--        hf_zone_sek[1..7] = Bins 0..6: Bin 0 unter Zone 1, Bin 1..5 = Garmin-Zone 1..5, Bin 6 ueber Max-HF;
--        Grenzen hf_zone_grenzen[1..6] = Obergrenzen Bin 0..5 (Uhr-Einstellung zum Laufzeitpunkt).
--        Leistungszonen nur raw (Bin-Zuordnung zu Garmin-Zonen nicht belegt).
--   raw.garmin_fit_record_extras  je Record (elapsed_sec wie raw.garmin_fit_records): hf_handgelenk (f136),
--        hf_gurt (f144), leistungszustand (f90, -20..+20, erst ab ca. Minute 6).
-- Views: neu views.lauf_details (eine Zeile je Lauf); Spalten ANGEHAENGT an training_sessions, aktivitaet_runden,
-- aktivitaet_verlauf (bisherige Spalten/Reihenfolge unveraendert). Keine GPS-Spalten.
-- Idempotent. Ausfuehrung als postgres: psql -d fuelofit_analytics -v ON_ERROR_STOP=1 -1 -f 024_lauf_details.sql

ALTER TABLE raw.garmin_fit_session
  ADD COLUMN IF NOT EXISTS uhr_temp_c_start           smallint,
  ADD COLUMN IF NOT EXISTS uhr_temp_c_mittel          numeric(4,1),
  ADD COLUMN IF NOT EXISTS uhr_temp_c_min             smallint,
  ADD COLUMN IF NOT EXISTS uhr_temp_c_max             smallint,
  ADD COLUMN IF NOT EXISTS uhr_luftfeuchte_pct_mittel numeric(4,1),
  ADD COLUMN IF NOT EXISTS uhr_wetter_werte           smallint,
  ADD COLUMN IF NOT EXISTS vo2max_vorher              numeric(5,2),
  ADD COLUMN IF NOT EXISTS vo2max_nachher             numeric(5,2),
  ADD COLUMN IF NOT EXISTS trainingslast              numeric(6,1),
  ADD COLUMN IF NOT EXISTS erholungszeit_min          integer,
  ADD COLUMN IF NOT EXISTS trainingsnutzen_code       smallint,
  ADD COLUMN IF NOT EXISTS leistungszustand_ende      smallint,
  ADD COLUMN IF NOT EXISTS gap_speed_ms               numeric(6,3),
  ADD COLUMN IF NOT EXISTS zeit_laufen_sek            numeric(8,1),
  ADD COLUMN IF NOT EXISTS zeit_gehen_sek             numeric(8,1),
  ADD COLUMN IF NOT EXISTS zeit_stehen_sek            numeric(8,1),
  ADD COLUMN IF NOT EXISTS hf_handgelenk_avg          numeric(5,1),
  ADD COLUMN IF NOT EXISTS hf_gurt_avg                numeric(5,1),
  ADD COLUMN IF NOT EXISTS hf_diff_avg                numeric(5,1),
  ADD COLUMN IF NOT EXISTS extras_version             smallint,
  ADD COLUMN IF NOT EXISTS extras_parsed_at           timestamptz;

ALTER TABLE raw.garmin_fit_laps ADD COLUMN IF NOT EXISTS gap_speed_ms numeric(6,3);

CREATE TABLE IF NOT EXISTS raw.garmin_fit_zeit_in_zone (
  activity_id            bigint NOT NULL REFERENCES raw.garmin_fit_session(activity_id) ON DELETE CASCADE,
  ref_mesg               smallint NOT NULL,      -- 18 session, 19 lap
  ref_index              integer NOT NULL,       -- lap_index bei 19, 0 bei 18
  hf_zone_sek            numeric[],              -- Bins 0..6 (s)
  hf_zone_grenzen        integer[],              -- Obergrenzen Bin 0..5 (bpm)
  leistung_zone_sek      numeric[],              -- Bins (s), nur raw
  leistung_zone_grenzen  integer[],              -- (W), nur raw
  hf_max                 integer,
  hf_schwelle            integer,
  ftp_w                  integer,
  PRIMARY KEY (activity_id, ref_mesg, ref_index)
);

CREATE TABLE IF NOT EXISTS raw.garmin_fit_record_extras (
  activity_id       bigint NOT NULL REFERENCES raw.garmin_fit_session(activity_id) ON DELETE CASCADE,
  elapsed_sec       integer NOT NULL,
  hf_handgelenk     smallint,
  hf_gurt           smallint,
  leistungszustand  smallint,
  PRIMARY KEY (activity_id, elapsed_sec)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON raw.garmin_fit_zeit_in_zone, raw.garmin_fit_record_extras TO fuelofit_fit_write;

-- ===== views.lauf_details (neu): eine Zeile je Lauf (FIT-Session fit_sport 'running') =====
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
  s.uhr_wetter_werte
FROM raw.garmin_fit_session s
LEFT JOIN raw.garmin_fit_zeit_in_zone z ON z.activity_id = s.activity_id AND z.ref_mesg = 18 AND z.ref_index = 0
LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
LEFT JOIN raw.aktivitaet_wetter w ON w.activity_id = s.activity_id
WHERE s.fit_sport = 'running';
GRANT SELECT ON views.lauf_details TO fuelofit_ro;

-- ===== views.training_sessions: Definition aus 022 + Lauf-Zusatzwerte (046) angehaengt =====
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
  startzeit_quelle,
  -- Migration 021 (Aufgabe 042): Sensor-Flags + Notiz. Garmin-Zeilen ueber entry_id; Google-Fit-Zeilen
  -- (startzeit_quelle 'entry_field') ueber die FIT-Session desselben Tages mit Start <= 60 s Abstand (041).
  sx.hf_quelle,
  sx.laufdynamik_quelle,
  sx.hf_verwertbar,
  sx.laufdynamik_verwertbar,
  sx.notiz,
  -- Migration 022 (Aufgabe 044): Wetterdienst-Werte ueber dieselbe FIT-Zuordnung (sx.activity_id).
  w.temp_c_start,
  w.temp_c_mittel,
  w.gefuehlt_c_mittel,
  w.luftfeuchte_pct_mittel,
  w.taupunkt_c_mittel,
  w.wind_kmh_mittel,
  w.boeen_kmh_max,
  w.niederschlag_mm,
  w.bewoelkung_pct_mittel,
  CASE WHEN w.quelle IN ('brightsky_dwd', 'open_meteo') THEN w.quelle END AS wetter_quelle,
  -- Migration 024 (Aufgabe 046): Lauf-Zusatzwerte aus der FIT-Datei (nur Laeufe, sonst NULL), ueber sx.activity_id.
  ld.uhr_luft_temp_c_mittel,
  ld.uhr_luftfeuchte_pct_mittel,
  ld.vo2max_vorher,
  ld.vo2max_nachher,
  ld.trainingslast,
  ld.erholungszeit_h,
  ld.trainingsnutzen,
  ld.leistungszustand_ende,
  ld.zeit_zone_1_sek,
  ld.zeit_zone_2_sek,
  ld.zeit_zone_3_sek,
  ld.zeit_zone_4_sek,
  ld.zeit_zone_5_sek,
  ld.gap_pace_min_km,
  ld.zeit_laufen_sek,
  ld.zeit_gehen_sek,
  ld.zeit_stehen_sek,
  ld.hf_handgelenk_avg,
  ld.hf_gurt_avg,
  ld.hf_diff_avg
FROM calc
LEFT JOIN LATERAL (
  SELECT x.activity_id, x.hf_quelle, x.laufdynamik_quelle, x.hf_verwertbar, x.laufdynamik_verwertbar, x.notiz
  FROM views.aktivitaet_sensoren x
  WHERE x.entry_id = calc.entry_id
     OR (calc.startzeit_quelle = 'entry_field' AND x.day = calc.day
         AND abs(extract(epoch FROM (x.start_lokal - calc.start_lokal))) <= 60)
  ORDER BY (x.entry_id = calc.entry_id) DESC,
           abs(extract(epoch FROM (x.start_lokal - calc.start_lokal))) NULLS LAST
  LIMIT 1
) sx ON true
LEFT JOIN raw.aktivitaet_wetter w ON w.activity_id = sx.activity_id
LEFT JOIN LATERAL (
  SELECT s.uhr_temp_c_mittel AS uhr_luft_temp_c_mittel, s.uhr_luftfeuchte_pct_mittel, s.vo2max_vorher, s.vo2max_nachher,
         s.trainingslast, round(s.erholungszeit_min / 60.0, 1) AS erholungszeit_h,
         CASE s.trainingsnutzen_code
           WHEN 0 THEN 'kein' WHEN 1 THEN 'erholung' WHEN 2 THEN 'grundlage' WHEN 3 THEN 'tempo'
           WHEN 4 THEN 'schwelle' WHEN 5 THEN 'vo2max' WHEN 6 THEN 'anaerob' WHEN 7 THEN 'sprint'
         END AS trainingsnutzen,
         s.leistungszustand_ende,
         z.hf_zone_sek[2] AS zeit_zone_1_sek, z.hf_zone_sek[3] AS zeit_zone_2_sek, z.hf_zone_sek[4] AS zeit_zone_3_sek,
         z.hf_zone_sek[5] AS zeit_zone_4_sek, z.hf_zone_sek[6] AS zeit_zone_5_sek,
         CASE WHEN s.gap_speed_ms > 0 THEN round(1000 / s.gap_speed_ms / 60, 2) END AS gap_pace_min_km,
         s.zeit_laufen_sek, s.zeit_gehen_sek, s.zeit_stehen_sek, s.hf_handgelenk_avg, s.hf_gurt_avg, s.hf_diff_avg
  FROM raw.garmin_fit_session s
  LEFT JOIN raw.garmin_fit_zeit_in_zone z ON z.activity_id = s.activity_id AND z.ref_mesg = 18 AND z.ref_index = 0
  WHERE s.activity_id = sx.activity_id AND s.fit_sport = 'running'
) ld ON true;

GRANT SELECT ON views.training_sessions TO fuelofit_ro;

-- ===== views.aktivitaet_runden: Definition aus 021 + Zonen je Runde und GAP-Tempo (046) =====
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
    z.hf_zone_sek[7] AS zeit_ueber_zone_5_sek
   FROM raw.garmin_fit_laps l
     JOIN raw.garmin_fit_session s ON s.activity_id = l.activity_id
     LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
     LEFT JOIN raw.garmin_fit_zeit_in_zone z ON z.activity_id = l.activity_id AND z.ref_mesg = 19 AND z.ref_index = l.lap_index
  ORDER BY l.activity_id, l.lap_index;
GRANT SELECT ON views.aktivitaet_runden TO fuelofit_ro;

-- ===== views.aktivitaet_verlauf: Definition aus 021 + Handgelenk-HF und Leistungszustand je 10-s-Bucket (046) =====
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
    round(avg(x.leistungszustand), 1) AS leistungszustand
   FROM raw.garmin_fit_records r
     JOIN raw.garmin_fit_session s ON s.activity_id = r.activity_id
     LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
     LEFT JOIN raw.garmin_fit_record_extras x ON x.activity_id = r.activity_id AND x.elapsed_sec = r.elapsed_sec
  GROUP BY r.activity_id, s.day, (r.elapsed_sec / 10 * 10), sx.hf_quelle, sx.laufdynamik_quelle, sx.hf_verwertbar, sx.laufdynamik_verwertbar, sx.notiz
  ORDER BY r.activity_id, (r.elapsed_sec / 10 * 10);
GRANT SELECT ON views.aktivitaet_verlauf TO fuelofit_ro;

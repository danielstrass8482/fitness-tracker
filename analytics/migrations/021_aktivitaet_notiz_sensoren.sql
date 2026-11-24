-- Migration 021: Notiz + Sensor-Flags je Aktivitaet (Aufgabe 042, 24.11.2026).
--
-- Firestore (neu, additiv, nur von der App geschrieben, siehe docs/datenmodell.md):
--   users/{uid}/activityNotes/{activityId}  {text, ohneBrustgurt, ohnePod, updatedAt (ISO)}
--   activityId = Garmin-activityId (wie garminHidden/garminLinks/gearAssignments).
-- exportAnalytics: activityNotes nur mode=full (kein Datumsfeld); sync.py holt sie in jedem Lauf komplett
-- (ALWAYS_FULL, wenige Dokumente) -> raw.activity_notes.
--
-- Automatische Erkennung (fit_sync.py, FIT device_info, Bericht 042):
--   raw.garmin_fit_session.hr_source (seit 014): 'brustgurt' = ANT+-Geraet antplus_device_type 'heart_rate',
--     'handgelenk' = kein externer HF-Sensor, aber HF in der Session, 'unbekannt' = keine HF.
--   raw.garmin_fit_session.rd_source (NEU, nur fit_sport 'running', sonst NULL):
--     'pod'       = ANT+-Geraet antplus_device_type 30 / garmin_product 'running_dynamics_pod'
--     'brustgurt' = Garmin-HF-Gurt (manufacturer garmin, antplus 'heart_rate') ohne Pod (HRM-Pro/-Run liefern Laufdynamik)
--     'keine'     = weder Pod noch Garmin-Gurt. ACHTUNG: die Uhr schreibt trotzdem Laufdynamik-Werte
--                   (Schaetzung am Handgelenk, z. B. 24.11.2026) -> nicht auswerten.
--
-- views.aktivitaet_sensoren (neu): je FIT-Session und/oder Notiz eine Zeile:
--   hf_quelle            'brustgurt' | 'handgelenk' | NULL (keine HF)
--   laufdynamik_quelle   'pod' | 'brustgurt' | 'keine' | NULL (kein Lauf)
--   hf_verwertbar        false bei Notiz ohneBrustgurt ODER Lauf mit hf_quelle 'handgelenk'; true bei sonstiger HF;
--                        NULL ohne HF und ohne Notiz
--   laufdynamik_verwertbar false bei Notiz ohnePod ODER Lauf mit laufdynamik_quelle 'keine'; true bei pod/brustgurt;
--                        NULL bei Nicht-Laeufen ohne Notiz
--   notiz                Notiztext (NULL wenn leer)
-- Die 5 Spalten werden an training_sessions, lauf_kilometer, aktivitaet_runden, aktivitaet_verlauf ANGEHAENGT
-- (Reihenfolge/Namen der bisherigen Spalten unveraendert). Kalorien-/Zielberechnung ignoriert die Flags.
-- Keine GPS-Spalten. Idempotent. Ausfuehrung als postgres:
--   psql -d fuelofit_analytics -v ON_ERROR_STOP=1 -1 -f 021_aktivitaet_notiz_sensoren.sql

CREATE TABLE IF NOT EXISTS raw.activity_notes (
  id text PRIMARY KEY,            -- Garmin-activityId
  day date,                       -- immer NULL (mode=full)
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON raw.activity_notes TO fuelofit_sync;

ALTER TABLE raw.garmin_fit_session ADD COLUMN IF NOT EXISTS rd_source text;  -- 'pod' | 'brustgurt' | 'keine' | NULL

CREATE OR REPLACE VIEW views.aktivitaet_sensoren AS
WITH n AS (
  SELECT id,
         NULLIF(btrim(data->>'text'), '')                     AS notiz,
         COALESCE((data->>'ohneBrustgurt')::boolean, false)  AS ohne_brustgurt,
         COALESCE((data->>'ohnePod')::boolean, false)        AS ohne_pod
  FROM raw.activity_notes
  WHERE deleted_at IS NULL
), j AS (
  SELECT COALESCE(s.activity_id, CASE WHEN n.id ~ '^[0-9]+$' THEN n.id::bigint END) AS activity_id,
         COALESCE(s.day, g.day)                               AS day,
         (s.start_time AT TIME ZONE 'Europe/Berlin')          AS start_lokal,
         s.fit_sport,
         CASE s.hr_source WHEN 'brustgurt' THEN 'brustgurt' WHEN 'handgelenk' THEN 'handgelenk' END AS hf_quelle,
         CASE WHEN s.fit_sport = 'running' THEN s.rd_source END AS laufdynamik_quelle,
         n.notiz, COALESCE(n.ohne_brustgurt, false) AS ohne_brustgurt, COALESCE(n.ohne_pod, false) AS ohne_pod,
         n.id IS NOT NULL AS hat_notiz
  FROM raw.garmin_fit_session s
  FULL JOIN n ON n.id = s.activity_id::text
  LEFT JOIN raw.garmin_activities g ON g.id = n.id AND g.deleted_at IS NULL
  WHERE s.activity_id IS NOT NULL OR n.id ~ '^[0-9]+$'
)
SELECT
  'garmin_' || activity_id AS entry_id,
  activity_id,
  day,
  start_lokal,
  fit_sport,
  hf_quelle,
  laufdynamik_quelle,
  CASE WHEN ohne_brustgurt THEN false
       WHEN fit_sport = 'running' AND hf_quelle = 'handgelenk' THEN false
       WHEN hf_quelle IS NOT NULL THEN true
  END AS hf_verwertbar,
  CASE WHEN ohne_pod THEN false
       WHEN fit_sport = 'running' AND laufdynamik_quelle IN ('pod', 'brustgurt') THEN true
       WHEN fit_sport = 'running' AND laufdynamik_quelle = 'keine' THEN false
  END AS laufdynamik_verwertbar,
  notiz,
  ohne_brustgurt AS notiz_ohne_brustgurt,
  ohne_pod AS notiz_ohne_pod
FROM j;

GRANT SELECT ON views.aktivitaet_sensoren TO fuelofit_ro;

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
  sx.notiz
FROM calc
LEFT JOIN LATERAL (
  SELECT x.hf_quelle, x.laufdynamik_quelle, x.hf_verwertbar, x.laufdynamik_verwertbar, x.notiz
  FROM views.aktivitaet_sensoren x
  WHERE x.entry_id = calc.entry_id
     OR (calc.startzeit_quelle = 'entry_field' AND x.day = calc.day
         AND abs(extract(epoch FROM (x.start_lokal - calc.start_lokal))) <= 60)
  ORDER BY (x.entry_id = calc.entry_id) DESC,
           abs(extract(epoch FROM (x.start_lokal - calc.start_lokal))) NULLS LAST
  LIMIT 1
) sx ON true;

GRANT SELECT ON views.training_sessions TO fuelofit_ro;

CREATE OR REPLACE VIEW views.lauf_kilometer AS
SELECT 'garmin_'::text || l.activity_id AS entry_id,
    l.activity_id,
    s.day,
    l.lap_index + 1 AS km_nr,
    l.lap_trigger <> 'distance'::text OR l.total_distance_m < 950::numeric AS ist_rest_km,
    l.total_distance_m AS distanz_m,
    l.total_timer_time_sec AS dauer_sek,
        CASE
            WHEN l.total_distance_m > 0::numeric THEN round(l.total_timer_time_sec / 60::numeric / (l.total_distance_m / 1000::numeric), 2)
            ELSE NULL::numeric
        END AS pace_min_km,
    l.avg_heart_rate AS hf_avg,
    l.max_heart_rate AS hf_max,
    l.total_ascent_m AS hoehenmeter_auf,
    l.total_descent_m AS hoehenmeter_ab,
    l.avg_cadence_spm AS kadenz_avg,
    l.avg_power_w AS leistung_avg,
    l.avg_ground_contact_ms AS bodenkontaktzeit_avg_ms,
    s.strecke_id,
    s.start_time AT TIME ZONE 'Europe/Berlin' AS start_lokal,
    sx.hf_quelle,
    sx.laufdynamik_quelle,
    sx.hf_verwertbar,
    sx.laufdynamik_verwertbar,
    sx.notiz
   FROM raw.garmin_fit_laps l
     JOIN raw.garmin_fit_session s ON s.activity_id = l.activity_id
     LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
  WHERE l.lap_trigger = 'distance'::text OR l.lap_trigger = 'session_end'::text AND l.lap_index = (s.num_laps - 1)
  ORDER BY l.activity_id, l.lap_index;
GRANT SELECT ON views.lauf_kilometer TO fuelofit_ro;

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
    s.start_time AT TIME ZONE 'Europe/Berlin' AS start_lokal,
    sx.hf_quelle,
    sx.laufdynamik_quelle,
    sx.hf_verwertbar,
    sx.laufdynamik_verwertbar,
    sx.notiz
   FROM raw.garmin_fit_laps l
     JOIN raw.garmin_fit_session s ON s.activity_id = l.activity_id
     LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
  ORDER BY l.activity_id, l.lap_index;
GRANT SELECT ON views.aktivitaet_runden TO fuelofit_ro;

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
  round(avg(r.power_w)::numeric, 1)     AS leistung_avg,
  sx.hf_quelle,
  sx.laufdynamik_quelle,
  sx.hf_verwertbar,
  sx.laufdynamik_verwertbar,
  sx.notiz
FROM raw.garmin_fit_records r
JOIN raw.garmin_fit_session s ON s.activity_id = r.activity_id
LEFT JOIN views.aktivitaet_sensoren sx ON sx.activity_id = s.activity_id
GROUP BY r.activity_id, s.day, (r.elapsed_sec / 10) * 10,
         sx.hf_quelle, sx.laufdynamik_quelle, sx.hf_verwertbar, sx.laufdynamik_verwertbar, sx.notiz
ORDER BY r.activity_id, bucket_sek;
GRANT SELECT ON views.aktivitaet_verlauf TO fuelofit_ro;

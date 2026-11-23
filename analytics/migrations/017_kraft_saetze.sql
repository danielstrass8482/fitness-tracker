-- Migration 017: Kraft-Saetze aus Garmin-FIT (Aufgabe 037).
--
-- Quelle: set-Nachrichten der Garmin-Krafttraining-FITs (typeKey strength_training, ab
-- 01.09.2026), geschrieben vom Garmin-VPS-Client fit_sync.py (Repo fuelofit-functions
-- vps/garmin/, Rolle fuelofit_fit_write) -- gleicher Schreibpfad wie Migration 014. Befund zu den
-- Feldern: Bericht 036 (set_type active/rest, start_time UTC, duration s, repetitions =
-- Uhr-Zaehlung, weight immer leer -> nicht gespeichert, category = 3 gereihte Schaetzungen der
-- Uhr-Erkennung, kein exercise_title/workout_step). Kraft-FITs haben KEINE lap-Nachrichten
-- (geprueft an 3 Dateien 11-16/11-18/11-23) -> views.lauf_kilometer/aktivitaet_runden bleiben
-- unberuehrt; Session und Records landen wie bisher in raw.garmin_fit_session/_records.
--
-- avg_hr/max_hr je Satz berechnet der Parser aus den Records mit timestamp in
-- [start_time, start_time + duration] (Handgelenk-Puls, 1-s-Raster; Puls hinkt nach -- kurze
-- Wechselpausen von ~12 s zeigen deshalb oft gleich hohen Puls wie der Satz davor).
--
-- Zuordnung zum Zirkel (views.kraft_saetze, NIE geraten):
--   * nur Tage mit genau EINER Kraft-Aktivitaet (mit Saetzen) UND genau EINEM Zirkel-Eintrag mit
--     datenbasis='details', (runde, slot) eindeutig und dauer_sek ueberall gesetzt;
--   * aktive Saetze in Reihenfolge (aktiv_nr) gegen Zirkel-Slots in Reihenfolge (runde, slot);
--   * Anzahl n (Saetze) vs. m (Slots): n = m -> 1:1; n = m + 1 -> genau ein Slot hat zwei
--     aufeinanderfolgende Saetze (Uhr hat geteilt, Bericht 036: 11-23 Runde 4); n = m - 1 -> genau
--     ein Slot ohne Satz; sonst keine Zuordnung;
--   * je Kandidat zaehlt ein Slot als bestaetigt, wenn |Ist - dauer_sek| <= 10 s, Ist = Spanne
--     vom Start des ersten bis Ende des letzten Satzes dieses Slots (bei einem Satz = dessen Dauer);
--   * Kandidat mit den meisten bestaetigten Slots gewinnt, nur wenn er EINDEUTIG ist und
--     mindestens 90 % der Slots bestaetigt (20 Slots: >= 18, 15 Slots: >= 14); sonst fuer den Tag
--     keine Zuordnung (alle Zuordnungsspalten NULL);
--   * auch im gewonnenen Kandidaten bekommt ein Satz nur dann eine Zuordnung, wenn SEIN Slot
--     bestaetigt ist (Abweichung > 10 s -> NULL fuer diesen Satz). Belege: 11-16 Runde 1 Slot 2
--     (Uhr 25,6 s vs. App 47 s, Uhr hat die Pause davor auf 33 s verlaengert) und 11-18 Runde 1
--     Slot 3 (87,9 s vs. 103 s) -- die uebrigen 19 Slots je Tag passen auf 2-6 s.
--   * Pausen-Saetze bekommen nie eine Zuordnung.
--
-- Idempotent. Ausfuehrung auf dem VPS als Rolle postgres, eine Transaktion:
--   psql -d fuelofit_analytics -v ON_ERROR_STOP=1 -1 -f 017_kraft_saetze.sql

CREATE TABLE IF NOT EXISTS raw.garmin_fit_sets (
  activity_id  bigint NOT NULL REFERENCES raw.garmin_fit_session(activity_id) ON DELETE CASCADE,
  set_index    integer NOT NULL,      -- FIT message_index, 0-basiert, aktive und Pausen-Saetze gemischt
  set_type     text,                  -- 'active' | 'rest'
  start_time   timestamptz,           -- UTC
  duration_s   numeric,
  reps         integer,               -- Uhr-Zaehlung (Auto-Erkennung), bei Pausen NULL
  category1    text,                  -- FIT exercise_category, 1. Schaetzung (Name, z. B. push_up; 'unknown')
  category2    text,
  category3    text,
  subtype1     integer,               -- category_subtype der 1. Schaetzung (roh, Bedeutung je Kategorie)
  avg_hr       integer,               -- aus raw-Records im Satzfenster
  max_hr       integer,
  PRIMARY KEY (activity_id, set_index)
);

GRANT INSERT, UPDATE ON raw.garmin_fit_sets TO fuelofit_fit_write;
-- fuelofit_ro: kein Zugriff auf raw, nur ueber views.kraft_saetze.

CREATE OR REPLACE VIEW views.kraft_saetze AS
WITH s AS (
  SELECT
    fs.*,
    se.day,
    CASE WHEN fs.set_type = 'active'
         THEN row_number() OVER (PARTITION BY fs.activity_id, fs.set_type = 'active' ORDER BY fs.set_index)
    END AS aktiv_nr
  FROM raw.garmin_fit_sets fs
  JOIN raw.garmin_fit_session se ON se.activity_id = fs.activity_id
),
act AS (
  SELECT day, count(DISTINCT activity_id) AS n_act FROM s GROUP BY day
),
a AS (
  SELECT s.activity_id, s.set_index, s.aktiv_nr, s.start_time, s.duration_s, s.day,
         count(*) OVER (PARTITION BY s.activity_id) AS n
  FROM s JOIN act ON act.day = s.day AND act.n_act = 1
  WHERE s.set_type = 'active'
),
zu AS (
  SELECT z.day, z.zirkel_id, z.runde, z.slot, z.uebung, z.variante, z.wdh_soll, z.dauer_sek
  FROM views.zirkel_uebungen z
  WHERE z.datenbasis = 'details' AND z.day IN (SELECT day FROM act WHERE n_act = 1)
),
zday AS (
  SELECT day FROM zu GROUP BY day
  HAVING count(DISTINCT zirkel_id) = 1
     AND count(*) = count(DISTINCT (runde, slot))
     AND bool_and(dauer_sek IS NOT NULL AND runde IS NOT NULL AND slot IS NOT NULL)
),
z AS (
  SELECT zu.*,
         row_number() OVER (PARTITION BY zu.day ORDER BY zu.runde, zu.slot) AS z_nr,
         count(*) OVER (PARTITION BY zu.day) AS m
  FROM zu JOIN zday ON zday.day = zu.day
),
dm AS (
  SELECT a.day, max(a.n) AS n, max(z.m) AS m
  FROM a JOIN z ON z.day = a.day
  GROUP BY a.day
),
cand AS (
  SELECT day, 'gleich'::text AS art, 0 AS k FROM dm WHERE n = m
  UNION ALL
  SELECT dm.day, 'geteilt', g.k FROM dm CROSS JOIN LATERAL generate_series(1, dm.m::int) AS g(k) WHERE dm.n = dm.m + 1
  UNION ALL
  SELECT dm.day, 'luecke', g.k FROM dm CROSS JOIN LATERAL generate_series(1, dm.m::int) AS g(k) WHERE dm.n = dm.m - 1
),
ca AS (
  SELECT c.day, c.art, c.k, a.activity_id, a.set_index, a.start_time, a.duration_s,
    CASE c.art
      WHEN 'gleich'  THEN a.aktiv_nr
      WHEN 'geteilt' THEN CASE WHEN a.aktiv_nr <= c.k THEN a.aktiv_nr ELSE a.aktiv_nr - 1 END
      WHEN 'luecke'  THEN CASE WHEN a.aktiv_nr <  c.k THEN a.aktiv_nr ELSE a.aktiv_nr + 1 END
    END AS z_nr
  FROM cand c JOIN a ON a.day = c.day
),
cs AS (
  SELECT day, art, k, z_nr,
         EXTRACT(EPOCH FROM max(start_time + duration_s * interval '1 second') - min(start_time)) AS ist_s
  FROM ca GROUP BY day, art, k, z_nr
),
cv AS (
  SELECT cs.day, cs.art, cs.k,
         count(*) FILTER (WHERE abs(cs.ist_s - z.dauer_sek) <= 10) AS n_ok,
         max(z.m) AS m
  FROM cs JOIN z ON z.day = cs.day AND z.z_nr = cs.z_nr
  GROUP BY cs.day, cs.art, cs.k
),
best AS (
  SELECT cv.*, max(n_ok) OVER (PARTITION BY day) AS best_ok FROM cv
),
win AS (
  SELECT day, min(art) AS art, min(k) AS k
  FROM best
  WHERE n_ok = best_ok AND n_ok >= ceil(0.9 * m)
  GROUP BY day HAVING count(*) = 1
),
cam AS (
  SELECT ca.day, ca.art, ca.activity_id, ca.set_index, ca.z_nr
  FROM ca
  JOIN win ON win.day = ca.day AND win.art = ca.art AND win.k = ca.k
  JOIN cs  ON cs.day = ca.day AND cs.art = ca.art AND cs.k = ca.k AND cs.z_nr = ca.z_nr
  JOIN z   ON z.day = ca.day AND z.z_nr = ca.z_nr
  WHERE abs(cs.ist_s - z.dauer_sek) <= 10
)
SELECT
  s.day,
  'garmin_' || s.activity_id                                   AS entry_id,
  right(s.activity_id::text, 4)                                AS aktivitaet_kurz,
  s.set_index                                                  AS satz_index,
  s.aktiv_nr::int                                              AS aktiv_nr,
  CASE s.set_type WHEN 'active' THEN 'aktiv' WHEN 'rest' THEN 'pause' ELSE s.set_type END AS satz_typ,
  date_trunc('second', s.start_time AT TIME ZONE 'Europe/Berlin') AS start_lokal,
  round(s.duration_s, 1)                                       AS dauer_s,
  CASE WHEN s.set_type = 'active' THEN s.reps END              AS wdh_uhr,
  CASE WHEN s.set_type = 'active' THEN
    CASE s.category1
      WHEN 'push_up' THEN 'Liegestütze'
      WHEN 'squat' THEN 'Kniebeuge'
      WHEN 'deadlift' THEN 'Kreuzheben'
      WHEN 'lunge' THEN 'Ausfallschritt'
      WHEN 'row' THEN 'Rudern'
      WHEN 'curl' THEN 'Bizeps-Curl'
      WHEN 'bench_press' THEN 'Bankdrücken'
      WHEN 'lateral_raise' THEN 'Seitheben'
      WHEN 'shoulder_press' THEN 'Schulterdrücken'
      WHEN 'triceps_extension' THEN 'Trizepsstrecken'
      WHEN 'pull_up' THEN 'Klimmzug'
      WHEN 'plank' THEN 'Unterarmstütz'
      WHEN 'hip_raise' THEN 'Hüftheben'
      WHEN 'crunch' THEN 'Crunch'
      WHEN 'sit_up' THEN 'Sit-up'
      WHEN 'core' THEN 'Rumpf'
      WHEN 'flye' THEN 'Fliegende'
      WHEN 'calf_raise' THEN 'Wadenheben'
      WHEN 'leg_raise' THEN 'Beinheben'
      WHEN 'unknown' THEN NULL
      ELSE s.category1
    END
  END                                                          AS uebung_uhr,
  CASE WHEN s.set_type = 'active' THEN concat_ws('/', s.category1, s.category2, s.category3) END AS kategorien_uhr,
  s.avg_hr,
  s.max_hr,
  z.zirkel_id,
  z.runde,
  z.slot,
  CASE WHEN z.zirkel_id IS NOT NULL THEN
    z.uebung || CASE WHEN z.variante IS NOT NULL AND z.variante <> 'regulaer' THEN ' ' || z.variante ELSE '' END
  END                                                          AS uebung_plan,
  z.wdh_soll                                                   AS soll_wdh,
  z.dauer_sek                                                  AS dauer_app_s,
  cam.art                                                      AS zuordnung
FROM s
LEFT JOIN cam ON cam.activity_id = s.activity_id AND cam.set_index = s.set_index
LEFT JOIN z ON z.day = cam.day AND z.z_nr = cam.z_nr
ORDER BY s.day, s.activity_id, s.set_index;

GRANT SELECT ON views.kraft_saetze TO fuelofit_ro;

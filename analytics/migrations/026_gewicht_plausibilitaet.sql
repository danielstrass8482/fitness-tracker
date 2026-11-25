-- Migration 026: Plausibilitaetsfilter fuer Waagen-Wiegungen (Aufgabe 048, 25.11.2026).
--
-- Freigabe Daniel 25.11.2026: "ja, bitte" (Plausibilitaetsfilter mit 5 kg).
-- Regel (gleich wie App weightPlausibility/weightForDate, Konstanten WEIGHT_PLAUSIBLE_MAX_DIFF_KG = 5,
-- WEIGHT_PLAUSIBLE_WINDOW_DAYS = 14):
--   Tage chronologisch. Genutztes Gewicht eines Tages = plausible Waage, sonst Handeintrag.
--   Referenz fuer eine Wiegung am Tag D = Median der genutzten Gewichte der Tage D-14 .. D-1
--   (nur Tage mit eigenem genutztem Wert); keiner im Fenster -> letztes genutztes Gewicht vor D;
--   gar keins -> Wiegung gilt. |Waage - Referenz| > 5 kg -> verworfen. Handeintraege nie gefiltert.
--   Berechnung beim Lesen (Firestore/raw unveraendert); rekursiv, weil die Referenz von frueheren
--   Entscheidungen abhaengt.
--
-- views.body_weight (Spalte angehaengt):
--   weight_garmin_plausibel = true/false bei Tagen mit Wiegung, NULL bei Tagen nur mit Handeintrag.
--   quelle = 'waage_verworfen' an Tagen mit verworfener Wiegung.
--   weight_used_kg (= weight_kg) folgt der Regel: verworfen -> Handeintrag des Tages, sonst das zuletzt
--   genutzte Gewicht davor (wie weightForDate der App; so bleibt die Zeile nicht NULL).
--   weight_garmin_kg zeigt den verworfenen Waagenwert weiter an.
-- views.koerperzusammensetzung (Spalte angehaengt): plausibel (Koerperwerte verworfener Wiegungen
--   sind ebenfalls nicht vertrauenswuerdig).
--
-- Idempotent. Ausfuehrung auf dem VPS als postgres:
-- psql -1 -v ON_ERROR_STOP=1 -d fuelofit_analytics -f 026_gewicht_plausibilitaet.sql

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

GRANT SELECT ON views.body_weight TO fuelofit_ro;
GRANT SELECT ON views.koerperzusammensetzung TO fuelofit_ro;

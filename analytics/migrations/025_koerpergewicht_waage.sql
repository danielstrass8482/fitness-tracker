-- Migration 025: Garmin-Waage im Connector (Aufgabe 047, 25.11.2026).
--
-- Quelle: raw.entries, typ 'tageslog' (Doc log_YYYYMMDD). Seit 047 schreibt der VPS-Garmin-Sync
-- (sync_official.py -> ingestGarmin {weights}) je Tag mit Wiegung die Felder weightGarmin (kg,
-- LETZTE Wiegung des Tages), weightGarminTs (lokal, ISO mit Offset), weighInsGarmin (Anzahl),
-- bodyFatPct, muscleMassKg, boneMassKg, bodyWaterPct, bmiGarmin, weightSource='garmin_scale'.
-- Das manuelle Feld weight (Einstellungen/Tageslog) bleibt unveraendert.
--
-- views.body_weight (Spalten angehaengt, Reihenfolge day, weight_kg bleibt):
--   weight_garmin_kg = Waage (letzte Wiegung des Tages), weight_manual_kg = Handeintrag,
--   weight_used_kg   = Vorrangregel der App (Daniel 25.11.2026 "A"): Waage, sonst Handeintrag,
--   quelle           = 'waage' | 'manuell'.
--   weight_kg        = SEIT 025 = weight_used_kg (vorher nur Handeintrag). Gewaehlt, weil sonst Tage
--                      nur mit Waage (z. B. 20./24.11.2026) als Zeilen mit weight_kg NULL erschienen
--                      und Abfragen "letztes Gewicht"/Trends NULL liefern wuerden. Der alte Wert steht
--                      unveraendert in weight_manual_kg. daily_summary.weight_kg erbt das (LEFT JOIN).
--   Eine Zeile je Tag MIT Messung (Waage oder Hand); Tage ohne Messung haben keine Zeile (die App
--   nutzt dann den letzten Tag davor, weightForDate). 0/leer zaehlt wie in der App als "kein Wert".
--
-- views.koerperzusammensetzung: eine Zeile je Tag mit Wiegung. Werte der letzten Wiegung des Tages.
--   Waagen-Schaetzung (BIA): absolute Werte ungenau, nur fuer Trends (Daniel 25.11.2026: "in absoluten
--   Werten falsch, fuer Trends aber geeignet"). Wiegungen ohne Koerperwerte (nur Gewicht) -> NULL.
--
-- Idempotent. Ausfuehrung auf dem VPS als postgres:
-- psql -1 -v ON_ERROR_STOP=1 -d fuelofit_analytics -f 025_koerpergewicht_waage.sql

CREATE OR REPLACE VIEW views.body_weight AS
WITH t AS (
  SELECT
    day,
    NULLIF((data->>'weightGarmin')::numeric, 0) AS g,
    NULLIF((data->>'weight')::numeric, 0) AS m
  FROM raw.entries
  WHERE deleted_at IS NULL
    AND data->>'typ' = 'tageslog'
)
SELECT
  day,
  COALESCE(g, m) AS weight_kg,
  g AS weight_garmin_kg,
  m AS weight_manual_kg,
  COALESCE(g, m) AS weight_used_kg,
  CASE WHEN g IS NOT NULL THEN 'waage' ELSE 'manuell' END AS quelle
FROM t
WHERE g IS NOT NULL OR m IS NOT NULL;

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
  (e.data->>'weighInsGarmin')::int AS wiegungen
FROM raw.entries e
WHERE e.deleted_at IS NULL
  AND e.data->>'typ' = 'tageslog'
  AND NULLIF((e.data->>'weightGarmin')::numeric, 0) IS NOT NULL;

COMMENT ON VIEW views.koerperzusammensetzung IS
  'Waagen-Schaetzung (BIA), absolute Werte ungenau, nur fuer Trends. Letzte Wiegung je Tag (Garmin-Waage, Aufgabe 047).';

GRANT SELECT ON views.body_weight TO fuelofit_ro;
GRANT SELECT ON views.koerperzusammensetzung TO fuelofit_ro;

-- Migration 016: Ausruestung (Laufschuhe, Aufgabe 028b, 21.11.2026)
--
-- Firestore (neu, additiv, nur von der App geschrieben, siehe docs/datenmodell.md):
--   users/{uid}/gear/{gear_ms}              {name, typ:'laufschuh', start_km, wechsel_km, aktiv, standard,
--                                            standard_seit, angelegt_am, ausgemustert_am}
--   users/{uid}/gearAssignments/{activityId} {gearId|null, quelle:'auto'|'manuell'|'rueckwirkend', at}
-- exportAnalytics: gear nur mode=full (kein Datumsfeld), gearAssignments mit Fenster ueber 'at'.
-- sync.py: gear wird wegen der geringen Groesse auch in jedem window-Lauf komplett (full) geholt.
--
-- Views:
--   views.lauf_ausruestung  je Garmin-Lauf (mappedTyp 'laufen', nicht geloescht, nicht ausgeblendet) eine
--                           Zeile mit Schuh (gear_name NULL = kein Schuh zugeordnet)
--   views.ausruestung       je Schuh km_gesamt = start_km + Summe distanceM der zugeordneten Laeufe aus
--                           views.lauf_ausruestung - gleiche Regel wie die App (gearStats in index.html)
-- Bewusst EIGENE View statt Spalte gear_name in views.lauf_kilometer: lauf_kilometer ist je km-Lap aus den
-- FIT-Daten (fehlt fuer Laeufe ohne FIT/Auto-Lap) und waere per CREATE OR REPLACE nur am Ende erweiterbar -
-- die eigene View laesst die bestehende unveraendert (weniger Eingriff), Join ueber activity_id/entry_id.
-- Keine GPS-Daten. Idempotent. Ausfuehrung auf dem VPS als postgres:
--   psql -d fuelofit_analytics -f 016_ausruestung.sql

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

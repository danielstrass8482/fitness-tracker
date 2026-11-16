-- Migration 011: views.sync_status - last_success_days gehoert zum Lauf von last_success_at
-- (Nachpruefung 016b Teil C).
--
-- Fehler in Migration 010: last_success_days wurde als max(days) UEBER ALLE erfolgreichen Laeufe
-- je mode berechnet, last_success_at getrennt als max(finished_at) - beide Werte stammen damit
-- i. A. aus VERSCHIEDENEN Laeufen. Live-Beleg (16.11.2026, vor dieser Migration):
--   mode=window: last_success_at = 2026-11-16 14:20:06 UTC (ein Lauf mit days=1),
--                last_success_days = 14 (von einem AELTEREN Lauf um 12:13:19 UTC mit days=14) -
--   die 14 gehoert NICHT zum Lauf, dessen Zeitstempel angezeigt wird.
--
-- Fix: DISTINCT ON (mode) ... ORDER BY finished_at DESC liefert mode, finished_at UND days aus
-- demselben (dem jeweils neuesten erfolgreichen) Datensatz.
--
-- views.sync_health bleibt unveraendert (nicht Teil dieser Migration).
--
-- Ausfuehrung auf dem VPS: psql -d fuelofit_analytics -f 011_sync_status_days_fix.sql

CREATE OR REPLACE VIEW views.sync_status AS
WITH last_any AS (
  SELECT DISTINCT ON (mode) mode, finished_at AS last_run_at, ok AS last_run_ok
  FROM raw.sync_runs
  ORDER BY mode, finished_at DESC
),
last_success AS (
  SELECT DISTINCT ON (mode) mode, finished_at AS last_success_at, days AS last_success_days
  FROM raw.sync_runs
  WHERE ok
  ORDER BY mode, finished_at DESC
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

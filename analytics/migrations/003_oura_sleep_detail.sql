-- Migration 003: views.sleep_recovery um Oura-Schlafdetails erweitern (Aufgabe 004c Teil B.5).
--
-- Neue Felder kommen aus demselben /v2/usercollection/sleep-Endpunkt, der schon abgerufen wird
-- (kein neuer API-Call), seit Commit 697eb99 in fuelofit-functions (syncOuraForUser). Erst ab dem
-- naechsten Sync-Lauf nach diesem Deploy gefuellt; fuer bereits vorhandene Tage s. Bericht 004c
-- Teil B.4 zum rueckwirkenden Nachladen.
--
-- Idempotent (CREATE OR REPLACE VIEW). Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 003_oura_sleep_detail.sql

-- CREATE OR REPLACE VIEW kann Spalten nur anhaengen, nicht umsortieren -- bestehende Spalten
-- bleiben deshalb exakt in alter Reihenfolge, neue Felder kommen ans Ende.
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

GRANT SELECT ON views.sleep_recovery TO fuelofit_ro;

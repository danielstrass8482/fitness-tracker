-- Migration 028: raw.job_heartbeat + views.job_status (Aufgabe 052, Monitoring der neuen Abgleiche).
--
-- Jeder ueberwachte Job (VPS, sync_official.py alle 15 Min) schreibt am Ende seines Teillaufs
-- genau eine Zeile per Upsert: last_run_at = jetzt, last_run_ok = Erfolg dieses Laufs,
-- last_success_at nur bei Erfolg weitergesetzt. "Erfolg" definiert der Job selbst
-- (fuelofit-functions vps/garmin/heartbeat.py + Aufrufer):
--   garmin_weight : Waage-GET + POST ingestGarmin + Echo ok (Tage ohne Wiegung = Erfolg, 0 Tage)
--   fit_sync      : Suche ok, kein unerwarteter Fehler UND keine passende Aktivitaet (inkl. Kraft),
--                   deren Start > 6 h zurueckliegt, fehlt noch in raw.garmin_fit_session
--   wetter_sync   : kein Fehler/429/Lock UND keine Outdoor-FIT-Session (GPS, ab 2024-05-01),
--                   deren Ende > 6 h zurueckliegt, ohne Zeile in raw.aktivitaet_wetter
-- Tage ohne Lauf/Wiegung erzeugen so keinen Fehlalarm (Lauf ok, nichts zu tun).
--
-- Bewertung (Schwelle) NICHT im Job, sondern hier in der View + MCP-/status?job=<name> +
-- Cloud-Monitoring-Uptime-Check (Waechter faellt nicht mit dem Ueberwachten aus).
--
-- Idempotent. Ausfuehrung auf dem VPS als postgres:
--   psql -1 -v ON_ERROR_STOP=1 -d fuelofit_analytics -f 028_job_heartbeat.sql

CREATE TABLE IF NOT EXISTS raw.job_heartbeat (
  job             text PRIMARY KEY,
  last_run_at     timestamptz NOT NULL,
  last_run_ok     boolean NOT NULL,
  last_success_at timestamptz,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);

GRANT SELECT, INSERT, UPDATE ON raw.job_heartbeat TO fuelofit_fit_write;
GRANT SELECT, INSERT, UPDATE ON raw.job_heartbeat TO fuelofit_wetter_write;

-- Schwellen = 3x Takt (15 Min) -> 45 Min; wetter_sync 150 Min, weil wetter_sync.py nach HTTP 429
-- absichtlich 60 Min pausiert (PAUSE_429_MIN) - 2x (60 + 15) Min.
-- status: ok | stale (letzter Erfolg aelter als Schwelle) | fehlt (noch nie gelaufen).
CREATE OR REPLACE VIEW views.job_status AS
WITH jobs(job, takt_min, max_age_min, beschreibung) AS (
  VALUES
    ('garmin_weight', 15, 45,  'Garmin-Waage -> Firestore (ingestGarmin weights + Loeschabgleich), Aufgabe 047/050'),
    ('fit_sync',      15, 45,  'FIT-Dateien inkl. Kraft-Saetze -> raw.garmin_fit_* (inkrementell + Backfill), Aufgabe 022/037/046/049'),
    ('wetter_sync',   15, 150, 'Wetter je Outdoor-Aktivitaet (DWD/Bright Sky, Open-Meteo) -> raw.aktivitaet_wetter, Aufgabe 044')
)
SELECT
  j.job,
  j.beschreibung,
  j.takt_min,
  j.max_age_min,
  h.last_success_at,
  h.last_run_at,
  NOT h.last_run_ok AS last_run_failed,
  CASE
    WHEN h.job IS NULL OR h.last_success_at IS NULL THEN 'fehlt'
    WHEN h.last_success_at < now() - make_interval(mins => j.max_age_min) THEN 'stale'
    ELSE 'ok'
  END AS status,
  h.details
FROM jobs j
LEFT JOIN raw.job_heartbeat h ON h.job = j.job
ORDER BY j.job;

GRANT SELECT ON views.job_status TO fuelofit_ro;

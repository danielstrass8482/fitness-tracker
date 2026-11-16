-- Migration 010: raw.sync_runs (Lauf-Protokoll von sync.py) + views.sync_status
-- (Aufgabe 016 Teil C, S8: der bestehende 26h-Alarm auf exportAnalytics sieht nur 2xx-Antworten
-- der Cloud Function - seit dem 15-Minuten-Takt haelt jeder kleine Tages-Lauf ihn ruhig, ein
-- Ausfall des Nacht-/Sonntags-Syncs oder ein Postgres-Schreibfehler faellt so nicht auf).
-- Migration 009 ist fuer Aufgabe 012c reserviert (siehe Auftrag 016), deshalb hier 010.
--
-- raw.sync_runs bekommt JEDEN Lauf (erfolgreich UND fehlgeschlagen, ok-Flag) - nicht nur
-- erfolgreiche: Regel 3 unten ("letzter Lauf ueberhaupt aelter als 2h") braucht genau diese
-- Unterscheidung, sonst waere sie identisch mit Regel 1/2 (siehe sync.py record_sync_run:
-- eigene, von der Haupt-Transaktion unabhaengige Verbindung, damit ein fehlgeschlagener
-- Sync trotzdem noch eine Fehlerzeile schreiben kann).
--
-- Ausfuehrung auf dem VPS: psql -d fuelofit_analytics -f 010_sync_runs.sql

CREATE TABLE IF NOT EXISTS raw.sync_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('window', 'full')),
  days        integer,              -- nur mode='window', sonst NULL
  rows        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {tabelle: anzahl_docs}, auch bei ok=false (Teilstand)
  ok          boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_runs_mode_finished_idx ON raw.sync_runs (mode, finished_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_finished_idx ON raw.sync_runs (finished_at DESC);

GRANT SELECT, INSERT ON raw.sync_runs TO fuelofit_sync;
GRANT USAGE, SELECT ON SEQUENCE raw.sync_runs_id_seq TO fuelofit_sync;

-- Letzter erfolgreicher Lauf je mode + letzter Lauf ueberhaupt (egal ob ok) je mode. Die
-- konkreten Schwellen (26h/2h/days>=7) wertet der MCP-/status-Endpunkt aus (server.py), nicht
-- diese View - sie liefert nur die Rohzeitpunkte, keine fertige ok/stale-Entscheidung.
CREATE OR REPLACE VIEW views.sync_status AS
WITH last_any AS (
  SELECT DISTINCT ON (mode) mode, finished_at AS last_run_at, ok AS last_run_ok
  FROM raw.sync_runs
  ORDER BY mode, finished_at DESC
),
last_success AS (
  SELECT mode, max(finished_at) AS last_success_at, max(days) AS last_success_days
  FROM raw.sync_runs
  WHERE ok
  GROUP BY mode
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

-- views.sync_status gruppiert bewusst je mode (Auftrag) - die "big sync"-Schwelle (Fenster-Lauf
-- mit days>=7 ODER Voll-Lauf, aelter als 26h) braucht aber eine Kennzahl UEBER beide modes
-- hinweg, die der 15-Minuten-Takt (mode=window, days=1) nicht verdeckt. fuelofit_ro darf nur auf
-- Schema views lesen (siehe REVOKE ALL ... FROM fuelofit_ro in schema.sql), deshalb eine eigene
-- einzeilige View statt einer Direktabfrage auf raw.sync_runs im MCP-Server.
CREATE OR REPLACE VIEW views.sync_health AS
SELECT
  (SELECT max(finished_at) FROM raw.sync_runs
    WHERE ok AND (mode = 'full' OR (mode = 'window' AND days >= 7))) AS last_big_success_at,
  (SELECT max(finished_at) FROM raw.sync_runs) AS last_run_at;

GRANT SELECT ON views.sync_health TO fuelofit_ro;

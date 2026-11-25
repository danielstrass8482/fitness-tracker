# Monitoring (Stand Aufgabe 052, 25.11.2026)

Alle Alarme laufen über Google Cloud Monitoring (Projekt `fitness-tracker-c6f97`) und gehen per E-Mail an den
Kanal **„Fuelofit Monitoring“**. Policy-/Check-Definitionen liegen in `fuelofit-functions/monitoring/`
(dort auch Anlegen/Ändern per REST). Grundsatz: **der Wächter darf nicht mit dem Überwachten ausfallen** –
bewertet wird immer außerhalb des überwachten Jobs (Cloud-Run-Metrik bzw. Uptime-Check von Google aus).

## Übersicht

| Alarm (Policy) | Überwacht | Signal | Schwelle |
|---|---|---|---|
| Fuelofit: Garmin-Sync | VPS-Cron `sync_official.py` → `ingestGarmin` (Schritte, Aktivitäten) | 2xx-Requests `ingestgarmin` (PromQL) | 0 in 75 Min |
| Fuelofit: Uhr-Schritte | Uhr-App → `ingestCiqSteps` | 2xx-Requests (PromQL), 06–21 UTC | 0 in 3 h |
| Fuelofit: Analytics-Sync | `exportAnalytics` | 2xx-Requests (PromQL) | 0 in 26 h |
| Fuelofit: Analytics-Sync (Postgres) | `sync.py` (Firestore → Postgres) | Uptime-Check `/status` = `sync_ok` (`views.sync_health`) | großer Sync > 26 h oder tagsüber kein Lauf in 2 h |
| Fuelofit: Oura-Sync | `syncOura`/`syncOuraMorning` | 2xx-Requests (PromQL) | 0 in 4 h |
| Fuelofit: MCP-Server erreichbar | MCP-Server | Uptime-Check `/healthz` | fehlschlagend |
| **Fuelofit: Job Garmin-Waage** (052) | Waage-Abgleich + Löschabgleich (047/050) | Uptime-Check `/status?job=garmin_weight` = `job_ok` | kein Erfolg in 45 Min |
| **Fuelofit: Job FIT-Sync** (052) | FIT-Dateien inkl. Kraft-Sätze, Backfill (022/037/046/049) | Uptime-Check `/status?job=fit_sync` = `job_ok` | kein Erfolg in 45 Min |
| **Fuelofit: Job Wetter-Sync** (052) | Wetter je Outdoor-Aktivität (044) | Uptime-Check `/status?job=wetter_sync` = `job_ok` | kein Erfolg in 150 Min |

Uptime-Checks: alle 5 Min aus 3 Regionen; Alarm, wenn mehr als eine Region 10 Min lang fehlschlägt;
schließt automatisch, sobald der Check wieder besteht.

## Job-Heartbeat (Aufgabe 052)

- Tabelle `raw.job_heartbeat` (Migration 028), eine Zeile je Job, geschrieben vom Job selbst am Ende seines
  Teillaufs (`vps/garmin/heartbeat.py`, Upsert; wirft nie – scheitert das Schreiben, wird der Job stale und
  der Alarm meldet es).
- View `views.job_status` (auch im claude.ai-Connector): `job, beschreibung, takt_min, max_age_min,
  last_success_at, last_run_at, last_run_failed, status (ok/stale/fehlt), details` (nur Zähler).
- MCP-Server `/status?job=<name>` (öffentlich, ohne Login): nur `job_ok` oder `job_stale`, keine Zahlen/Zeiten.

### Was „Erfolg“ je Job heißt (keine Fehlalarme an Tagen ohne Daten)

| Job | Läuft in | Erfolg | Tag ohne Daten |
|---|---|---|---|
| `garmin_weight` | `sync_official.py` (`run_weight_sync`), alle 15 Min | Waage-GET + POST `ingestGarmin` + Echo ok | 0 Wiegungen = Erfolg |
| `fit_sync` | `fit_sync.run_fit_sync`, alle 15 Min | Suche (14 Tage) ok, kein unerwarteter Fehler **und** keine passende Aktivität (Lauf/Rad/Gehen/Wandern/Kraft) mit Start > 6 h ohne FIT-Daten (übersprungene ausgenommen) | keine Aktivität = Erfolg |
| `wetter_sync` | `wetter_sync.run_wetter_sync`, alle 15 Min | kein Fehler/429/Lock **und** keine Outdoor-Aktivität mit GPS (ab 01.05.2024) mit Ende > 6 h ohne Wetterzeile (übersprungene ausgenommen) | keine Aktivität = Erfolg |

Der einmalige FIT-Rückwärts-Backfill zählt nicht für `ok`; sein Stand steht in `details`
(`backfill_cursor_bis`, `backfill_fertig`). Einmal-Skripte (`backfill_lauf_extras_046.py`,
`backfill_rd_source_042.py`, `wetter_sync.py --budget …`, `sync_official.py --weight-backfill`) werden nicht überwacht.

### Nicht als eigener Job überwacht (bewusst)

- Startzeiten (041): kommen über `exportAnalytics`/`sync.py` → abgedeckt durch „Analytics-Sync (Postgres)“.
- Sensor-Flags `rd_source` (042): Teil von `fit_sync`.
- Rezept-Zerlegung (045): reine View, kein Job.
- Fällt der ganze Garmin-Cron aus (Key, 429, VPS), kommen gleichzeitig „Garmin-Sync“ und die drei Job-Alarme.

## Nachsehen bei Alarm (nur lesen)

- Connector: `select job, status, last_success_at, last_run_failed, details from views.job_status`
- VPS: `sudo tail -60 /home/fuelofit/fuelofit-garmin/logs/sync_official.log` (Zeilen `FEHLER`/`WARNUNG`)
- Garmin-Regeln: bei Login-/Auth-Fehlern oder 429 nicht wiederholen, kein Passwort-Login. Trading-Bot und Postgres nie neu starten.

## Kosten

Uptime-Checks: 3 neue × 3 Regionen × alle 5 Min ≈ 26.000 Ausführungen/Monat je Check (≈ 78.000 zusammen), innerhalb des
kostenlosen Kontingents laut Preisseite. Alerting laut Preisseite frühestens ab 01.09.2027 kostenpflichtig
(0,35 $/Monat je Policy-Metrik). Mit den 3 neuen Policies insgesamt 9 Policies ≈ 3,15 $/Monat ab dann.

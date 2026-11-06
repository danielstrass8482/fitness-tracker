# Fuelofit Analyse-DB (Phase 1a)

Rohdaten-Kopie der Firestore-Collections (Projekt `fitness-tracker-c6f97`) in einer eigenen
Postgres-Datenbank auf dem VPS, zum Auswerten ohne Firestore-Lesekosten. Grundlage:
`docs/datenmodell.md`, Abschnitt "Analytics-DB".

## Architektur

```
Firestore (fitness-tracker-c6f97)
    |  nur Whitelist-Collections, Secret-Felder serverseitig entfernt
    v
Cloud Function exportAnalytics (us-central1, Repo fuelofit-functions)
    |  HTTPS GET, Header X-Analytics-Secret (ANALYTICS_EXPORT_SECRET)
    v
sync.py  (User fuelofit-analytics, VPS 185.117.250.246)
    v
Postgres 18, DB fuelofit_analytics, Schema raw (Rohdaten) + views (typisierte Sichten)
```

Kein Service Account und keine Firestore-Credentials auf dem VPS. Der Sync-Job kennt nur ein
widerrufbares Secret (`.config/analytics-export-secret`) und ruft eine Cloud Function auf, die
serverseitig filtert -- dasselbe Muster wie `ingestGarmin`/`ingestCiqSteps`, nur in umgekehrter
Richtung (Pull statt Push).

## Rollen

| Rolle | Rechte | Verwendet von |
|---|---|---|
| `fuelofit_sync` | SELECT, INSERT, UPDATE auf Schema `raw` | `sync.py` (Cron, User `fuelofit-analytics`) |
| `fuelofit_ro` | SELECT auf Schema `raw` und `views` | spaeter: MCP-Server (noch nicht angebunden) |

Passwoerter liegen in `~/.pgpass` des Systemnutzers `fuelofit-analytics` (600), nicht im Repo und
nicht in `schema.sql`. `pg_hba.conf` auf dem VPS lässt ohnehin nur `localhost`/`127.0.0.1`/`::1`
zu (gilt fuer alle Rollen inkl. der trading_bot-Rolle) -- keine zusaetzliche Zeile noetig.

## Sync-Zeiten (Europe/Berlin, Crontab von `fuelofit-analytics`)

| Zeit | Modus | Was |
|---|---|---|
| taeglich 04:15 | `window` | Collections mit Datumsfeld, letzte 14 Tage (Upsert + Soft-Delete im Fenster) |
| sonntags 04:45 | `full` | alle Whitelist-Collections komplett (inkl. Collections ohne Datumsfeld: `foods`, `recipes`, `weeklyStats`, `trainingTypes`, `intervalTemplates`, `garminLinks`, `garminHidden`) |

`sync.py` hat eine eigene Lock-Datei (`flock`, `app/sync.lock`) gegen Parallellaeufe -- die
Crontab ruft das Skript deshalb *ohne* zusaetzlichen `flock`-Wrapper auf (anders als beim
Garmin-Sync unter User `fuelofit`): ein externer `flock` auf dieselbe Datei wuerde sich mit dem
internen Lock selbst blockieren.

Log: `app/sync.log` (Secret wird nie geloggt). Exit-Code `!= 0` bei Fehler.

## Wiederaufbau aus Firestore

Die Analyse-DB hat **kein eigenes Backup** -- sie ist aus Firestore vollstaendig ableitbar:

1. `CREATE DATABASE fuelofit_analytics;` (als Postgres-Superuser)
2. `psql -d fuelofit_analytics -f schema.sql` (idempotent, legt Rollen/Schemas/Tabellen/Views an)
3. Passwoerter fuer `fuelofit_sync`/`fuelofit_ro` neu setzen (`ALTER ROLE ... PASSWORD ...`),
   in `~/.pgpass` des Systemnutzers ablegen
4. `sync.py --mode full` einmal manuell laufen lassen -- fuellt alle Tabellen komplett

Das eigentliche Sicherheitsnetz ist der Firestore-Backup-Schedule (taeglich, 14 Wochen
Aufbewahrung, siehe `docs/datenmodell.md`), nicht ein Backup dieser Postgres-DB.

Fuer eine bereits laufende Instanz (Schema existiert schon) genuegt statt Schritt 2 das
passende Skript aus `migrations/` (idempotent, nur ADD/CREATE IF NOT EXISTS) - `schema.sql`
bleibt die vollstaendige Referenz fuer einen Neuaufbau von Null.

## Rotation des Secrets (`ANALYTICS_EXPORT_SECRET`)

1. Neuen Wert erzeugen: `openssl rand -hex 32 | tr -d '\n' > /tmp/analytics-export-secret.txt`
2. Setzen: `firebase functions:secrets:set ANALYTICS_EXPORT_SECRET --data-file=/tmp/analytics-export-secret.txt` (im Repo `fuelofit-functions`, Wert nie ausgeben)
3. Neu deployen: `firebase deploy --only functions:exportAnalytics`
4. Neue Datei per `scp` nach `/home/fuelofit-analytics/.config/analytics-export-secret` (600,
   Owner `fuelofit-analytics`) uebertragen, alte Datei auf dem Weg per `shred -u` loeschen, nie
   nur `rm`
5. Naechster Cron-Lauf nutzt automatisch den neuen Wert (liest die Datei bei jedem Start neu)

**Offen:** `GARMIN_INGEST_SECRET` (anderes Secret, nicht Teil dieses Sync-Jobs) wurde am
2026-11-05 versehentlich per `firebase functions:secrets:access` im Klartext in eine
Claude-Code-Session ausgegeben und sollte nach demselben Verfahren (fuer das Garmin-Ingest statt
Analytics-Secret, inkl. Update auf dem Garmin-Sync-Job unter User `fuelofit`) rotiert werden.

## Collections, die bewusst NICHT in der Analyse-DB liegen

Siehe `docs/datenmodell.md` Abschnitt 7c: alle Secret-Felder, `settings/*`, `integrations/*`,
`oura_tokens`, `oura_oauth_state`, Altbestaende ohne Code-Bezug (`users/{uid}/foods`,
`oura_step_log`, `stravaAthletes`), `ciqSteps/*/samples` (Rohsamples, nur Tageswert uebernommen),
die Darts-Collections. Freitextfelder mit Gesundheitsbezug (`dailyCheck.reason/actions`,
`settings/subjectiveStatus.history` -- letzteres ohnehin durch den `settings`-Ausschluss nicht
erreichbar) sind ueber die Whitelist der Cloud Function gar nicht exportierbar.

Live berechnete Werte (BMR, Kalorienziel, Zirkel-/Puls-Mischung-kcal, Schrittquelle je Tag) werden
hier **nicht** nachgebaut -- die Formeln liegen nur in `index.html`. Seit Phase 1b (Aufgabe
003c, 2026-11-06) legt die App selbst taeglich einen Snapshot der mit ihrer eigenen Logik
berechneten Werte ab (`users/{uid}/dailySnapshots/{date}`), der ueber `exportAnalytics` und
`sync.py` nach `raw.daily_snapshots` / `views.daily_summary` repliziert wird (eine
Formelquelle: dieselben Funktionen wie Anzeige/Kalorienziel, siehe `docs/datenmodell.md`
Abschnitt 8).

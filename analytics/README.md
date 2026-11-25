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
sync.py  (User fuelofit-analytics, VPS)
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
| `fuelofit_ro` | SELECT auf Schema `raw` und `views` | MCP-Server (`fuelofit-mcp.service`, Systemnutzer `fuelofit-mcp`, angebunden seit 11.11.2026) |

Passwoerter liegen in `~/.pgpass` des Systemnutzers `fuelofit-analytics` (600), nicht im Repo und
nicht in `schema.sql`. `pg_hba.conf` auf dem VPS lässt ohnehin nur `localhost`/`127.0.0.1`/`::1`
zu (gilt fuer alle Rollen inkl. der trading_bot-Rolle) -- keine zusaetzliche Zeile noetig.

**Update 022c (19.11.2026):** Der MCP-Server verwendet fuer `fuelofit_ro` ein **eigenes** Secret
unter dem Systemnutzer `fuelofit-mcp` (Datei `secrets/db_password`, 600, Pfad aus
`FUELOFIT_MCP_SECRETS` in der systemd-Unit), nicht die `.pgpass`-Zeile unter
`fuelofit-analytics`. Die `fuelofit_ro`-Zeile(n) in `~/.pgpass` des Systemnutzers
`fuelofit-analytics` werden von keinem Dienst mehr gelesen (`fuelofit_sync`/`sync.py` bleibt
unveraendert in derselben Datei). Rotation von `fuelofit_ro` betrifft deshalb nur das Secret
unter `fuelofit-mcp`, nicht `fuelofit-analytics`.

## Sync-Zeiten (Crontab von `fuelofit-analytics`)

Der installierte Debian-`cron` (3.0pl1) kennt `CRON_TZ` nicht; die VPS-Systemzeit ist UTC. Die
Zeiten der beiden alten Jobs sind deshalb **UTC** (008c belegt, bewusst so belassen). Die
wirkungslose `CRON_TZ=Europe/Berlin`-Zeile selbst wurde am 16.11.2026 aus der Crontab entfernt
(Aufgabe 016 Teil D, reine Aufräumarbeit ohne Zeitänderung - Backup unter
`/home/fuelofit-analytics/app/crontab.bak-20261116`).

| Zeit | Modus | Was |
|---|---|---|
| taeglich 04:15 UTC (05:15 Berlin Winter / 06:15 Sommer) | `window` | Collections mit Datumsfeld, letzte 14 Tage (Upsert + Soft-Delete im Fenster) |
| sonntags 04:45 UTC | `full` | alle Whitelist-Collections komplett (inkl. Collections ohne Datumsfeld: `foods`, `recipes`, `weeklyStats`, `trainingTypes`, `intervalTemplates`, `garminLinks`, `garminHidden`) |
| (028b) in JEDEM `window`-Lauf | `full` nur fuer `gear` | Laufschuhe (wenige Dokumente, `ALWAYS_FULL` in `sync.py`), damit `views.ausruestung` zeitnah ist; `gearAssignments` laeuft normal im Fenster ueber `at` |
| alle 15 Min (:05/:20/:35/:50), 05:05-22:50 Europe/Berlin (008c) | `window --days 1` | nur gestern + heute (Datumsfilter in exportAnalytics), ca. 57 Reads je Lauf |

Der 15-Min-Job steht als `3-21` UTC in der Crontab; ein Guard
`h=$(TZ=Europe/Berlin date +\%-H); [ "$h" -ge 5 ] && [ "$h" -le 22 ]` laesst nur Berliner Stunden
05-22 durch (sommer- und winterzeitfest, 72 Laeufe/Tag). Die Minuten sind gegen die alten Jobs
(:15/:45) versetzt, damit sich die Laeufe nicht am Lock stoeren.

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

## Garmin-FIT-Detaildaten (Migration 014, 017, 021, 022, 024)

Zweiter Schreibpfad neben `sync.py`: der Garmin-Sync (`fit_sync.py`, User `fuelofit`, Repo
fuelofit-functions `vps/garmin/`, Rolle `fuelofit_fit_write`) laedt FIT-Dateien und schreibt direkt
nach `raw.garmin_fit_*`. Nicht in `schema.sql` (dort nur Firestore-Rohdaten), sondern in den
Migrationen 014 und 017.

- **014**: `raw.garmin_fit_session/_laps/_records/_strecken` fuer laufen/rad/rad_ebike/gehen/wandern
  → Views `lauf_kilometer`, `aktivitaet_runden`, `aktivitaet_verlauf`.
- **017 (Aufgabe 037, 23.11.2026)**: Garmin-Krafttraining (`strength_training`, ab 01.09.2026):
  `raw.garmin_fit_sets` (ein Satz je FIT-`set`-Nachricht, aktiv/Pause, Dauer, Uhr-Wdh., 3
  Kategorie-Schaetzungen, Puls je Satz aus den Records im Satzfenster) → View `kraft_saetze` mit
  Zirkel-Zuordnung (Regel im Kopf von `migrations/017_kraft_saetze.sql`: Reihenfolge aktive Saetze
  vs. Slots, Anzahl ±1, Dauer ≤ 10 s je Slot, ≥ 90 % bestaetigt und eindeutig, sonst NULL).
  Kraft-FITs haben keine Laps; Session/Records landen wie bei 014. Rechte: `fuelofit_fit_write`
  INSERT/UPDATE auf `raw.garmin_fit_sets`, `fuelofit_ro` nur SELECT auf `views.kraft_saetze`.
  Kraft-Aktivitaeten vor dem 01.09.2026 holt der einmalige Kraft-Backfill (State-Feld
  `kraft_backfill_fertig` in `fit_backfill_state.json`) bewusst nicht.

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

**021 (Aufgabe 042, 24.11.2026)**: `raw.garmin_fit_session.rd_source` (Laufdynamik-Quelle aus FIT `device_info`,
nur Laeufe: pod/brustgurt/keine; `fit_sync.detect_rd_source`, Altbestand einmalig per
`backfill_rd_source_042.py` aus `fit_archive`), `raw.activity_notes` (Firestore `activityNotes`, sync.py,
ALWAYS_FULL) und `views.aktivitaet_sensoren`; die Spalten `hf_quelle`, `laufdynamik_quelle`, `hf_verwertbar`,
`laufdynamik_verwertbar`, `notiz` sind an training_sessions, lauf_kilometer, aktivitaet_runden und
aktivitaet_verlauf angehaengt (Regeln im Kopf von `migrations/021_aktivitaet_notiz_sensoren.sql`).

**022 (Aufgabe 044, 24.11.2026)**: `raw.aktivitaet_wetter` = Wetterdienst-Werte je Outdoor-Aktivitaet
(FIT-Session mit Start-GPS, nicht indoor), geschrieben von `vps/garmin/wetter_sync.py` (fuelofit-functions,
Rolle `fuelofit_wetter_write`: Schreibrecht nur auf diese Tabelle, Lesen nur der noetigen Session-Spalten).
Quelle Bright Sky (DWD-Stationsmessungen, Station <= 30 km), Fallback Open-Meteo Archive (Modell). An die
Dienste gehen nur auf 0,1 Grad gerundete Startkoordinaten; gerundete Werte nur in raw. Aufruf nach jedem
Garmin-Sync (`sync_official.py`, max. 20 Requests/Lauf, Aktivitaet >= 2 h beendet), Backfill ab 05.2024 per
`wetter_sync.py --budget N`. Spalten `temp_c_start`, `temp_c_mittel`, `gefuehlt_c_mittel`,
`luftfeuchte_pct_mittel`, `taupunkt_c_mittel`, `wind_kmh_mittel`, `boeen_kmh_max`, `niederschlag_mm`,
`bewoelkung_pct_mittel`, `wetter_quelle` an training_sessions und lauf_kilometer angehaengt (Rechenweg im
Kopf von `migrations/022_aktivitaet_wetter.sql`).

**023 (Aufgabe 045, 25.11.2026)**: `views.food_log_zutaten` = wie `food_log_entries`, aber jeder kollabierte
Rezept-Block (recipeId oder foodId = aktives Rezept) durch seine Zutaten ersetzt (Faktor aus unit portions/grams,
sonst kcal-Verhaeltnis; Zutat = foods je 100 g x Menge x Faktor, auf geloggte Block-kcal skaliert, Makros je Makro
eigenes Verhaeltnis). Zusatzspalten `herkunft` (direkt/rezept_expandiert/rezept_zerlegt/rezept_nicht_zerlegbar),
`rezept`, `skalierung`, `abweichung_pct`. Rest-Zeilen (fehlende Zutaten-Lebensmittel, Rundung) halten die
Tagessummen exakt = `daily_nutrition`. Nur Analyse-View; Alkohol-Regel zaehlt Rezeptzutaten nie (Regeln im Kopf
von `migrations/023_food_log_zutaten.sql`).

**024 (Aufgabe 046, 25.11.2026)**: Lauf-Zusatzwerte aus der FIT-Datei (`fit_sync.parse_run_extras`/`store_run_extras`, nur
Laeufe, eigener Savepoint -- ein Fehler dort verhindert die Basisdaten nicht): Handy-Wetter (msg 288), VO2max vorher/nachher,
Trainingslast, Erholungszeit, Trainingsnutzen, Leistungszustand, Zeit in Pulszonen (msg 216, Session + Laps), bergbereinigtes
Tempo, Lauf-/Geh-/Stehzeit (msg 312), Handgelenk- vs. Gurt-HF (record f136/f144). Neu `raw.garmin_fit_zeit_in_zone`,
`raw.garmin_fit_record_extras` (Rolle `fuelofit_fit_write` SELECT/INSERT/UPDATE/DELETE), Spalten in `raw.garmin_fit_session`/
`raw.garmin_fit_laps`, View `views.lauf_details`; Spalten an training_sessions, aktivitaet_runden, aktivitaet_verlauf angehaengt.
Altbestand einmalig per `backfill_lauf_extras_046.py` (fortsetzbar ueber `extras_version`, `nice`, Pause je Datei). Feldquellen
im Kopf von `migrations/024_lauf_details.sql`.

**025 (Aufgabe 047, 25.11.2026)**: Garmin-Waage. `views.body_weight` + Spalten `weight_garmin_kg` (letzte Wiegung des Tages),
`weight_manual_kg` (Handeintrag), `weight_used_kg` (Vorrang Waage, sonst Hand, wie App `weightForDate`), `quelle`
('waage'/'manuell'); `weight_kg` = `weight_used_kg` (vorher nur Handeintrag; gewaehlt, damit Tage nur mit Waage nicht
als NULL-Zeilen erscheinen). Neu `views.koerperzusammensetzung` (Koerperfett, Muskel-, Knochenmasse, Wasser, BMI,
Anzahl Wiegungen) - Waagen-Schaetzung (BIA), nur fuer Trends. Quelle: tageslog-Felder aus `ingestGarmin {weights}`
(VPS `sync_official.py`). Regeln im Kopf von `migrations/025_koerpergewicht_waage.sql`.

# Fuelofit – Datenmodell-Bestandsaufnahme (Firestore)

Stand: 2026-11-03. Projekt `fitness-tracker-c6f97`, Datenbank `(default)`. Nur-Lese-Bestandsaufnahme
als Grundlage für eine externe Analyse-Datenbank (Postgres) und einen MCP-Server. Alle Angaben per
echter Firestore-REST-Calls (`gcloud auth print-access-token` + `firestore.googleapis.com/v1`) belegt;
nicht ausführbare Punkte sind als solche markiert. Diese Datei enthält **keine Feldwerte**, **keine
Secrets**, **keine uid im Klartext** (immer `{uid}`) – vor dem Commit per grep geprüft (siehe Abschnitt
„Prüfprotokoll“ am Ende).

Single-User-App: unter `users/` existiert genau ein aktiver Nutzerpfad (`users/{uid}/...`, bestätigt
über eine `collectionGroup`-Abfrage auf `settings` – alle 5 gefundenen Settings-Dokumente liegen unter
derselben `{uid}`).

## 0. Out of scope

Dieselbe Firestore-Instanz enthält 9 weitere Top-Level-Collections einer unabhängigen Darts-App
(`dart_coach_analyses`, `dart_config`, `dart_games`, `dart_players`, `dart_scan_feedback`,
`dart_scan_sessions`, `dart_usage`, `dart_users`, `dart_video_sessions`, zusammen ~182 Dokumente).
Auf Rückfrage ausdrücklich **ausgeschlossen** – nicht Teil dieser Bestandsaufnahme.

## 1. Inventar

### 1a/b. Collections, Dokumentanzahl, Zeitraum

**Top-Level (außerhalb von `users/`):**

| Collection | Doc-Typ/Key | Anzahl | Zeitraum | Kategorie |
|---|---|---|---|---|
| `foods` | `food_{ts}_{rand}` | 2263 | kein Datumsfeld (Katalog) | Ernährung |
| `oura_tokens` | `{uid}` | 1 | – | **Secrets** |
| `stravaAthletes` | `{stravaAthleteId}` | 1 | – | Konfiguration/Referenz |
| `trainingTypes` | `custom_{name}` | 11 | kein Datumsfeld (Katalog) | Konfiguration |

**Unter `users/{uid}/` (17 Subcollections, alle über `listCollectionIds` ermittelt):**

| Subcollection | Doc-Key | Anzahl | Zeitraum (ältestes–neuestes) | Kategorie |
|---|---|---|---|---|
| `entries` | gemischt (s. 1d) | 1247 | 2025-09-12 – 2026-11-03 | Bewegung |
| `logEntries` | `{ts}_{rand}` | 31336 | 2024-04-17 – 2026-11-03 | Ernährung |
| `foods` (user-eigen) | `food_{ts}_{rand}` | 2263 | kein Datumsfeld | Ernährung |
| `recipes` | `recipe_{ts}_{rand}` | 186 | kein Datumsfeld | Ernährung |
| `garminActivities` | `{activityId}` | 6 | 2026-10-29 – (laufend) | Bewegung/Gesundheit (Puls) |
| `garminDaily` | `{YYYY-MM-DD}` | 6 | 2026-10-29 – (laufend) | Bewegung |
| `ciqSteps` | `{YYYY-MM-DD}` | 3 | 2026-11-01 – 2026-11-03 | Bewegung (sehr neu) |
| `ciqSteps/{date}/samples` | auto-ID | 222 (nur 11-03 geprüft) | Samples über den Tag verteilt | Bewegung |
| `oura_daily` | `{YYYY-MM-DD}` | 33 | 2026-10-02 – (laufend) | Gesundheit (Schlaf/Erholung) |
| `oura_step_log` | `{YYYY-MM-DD}` | 2 | 2026-10-02 – 2026-10-03 | Bewegung |
| `oura_workouts` | UUID | 16 | – | Bewegung |
| `weeklyStats` | `{YYYY}-W{WW}` | 177 | **2018-W35** – (laufend) | Bewegung/Ernährung (Aggregat) |
| `dailyCheck` | `{YYYY-MM-DD}` | 17 | 2026-10-18 – (laufend) | Gesundheit/KI (s. Finding 1) |
| `dailyCheckCallLog` | `{date}_{ts}` | 6 | 2026-10-30 – (laufend) | Konfiguration (Debug/Log) |
| `trainingplans` | `{YYYY-MM-DD}` (Montag) | 4 | 2026-09-28 – (laufend) | Bewegung (Plan) |
| `intervalTemplates` | `iv_{ts}_{rand}` | 1 | – | Konfiguration |
| `settings` | `main`/`favorites`/`backup`/`exercises`/`subjectiveStatus` | 5 | – | Konfiguration/**Secrets** (main) |
| `integrations` | 7 feste Docs (s. 2) | 7 | – | **Secrets** (4 von 7) |
| `garminLinks` | `{activityId}` | **0** (aktuell leer) | – | Bewegung (Zuordnung) |
| `garminHidden` | `{activityId}` | **0** (aktuell leer) | – | Bewegung |
| `data` | – | **0, toter Code** | – | – |

`garminLinks`/`garminHidden` erscheinen nicht in `listCollectionIds` (Firestore listet nur
Collections mit ≥1 Dokument), existieren aber im Code (`userGarminLinksCol`/`userGarminHiddenCol`) und
werden bei Bedarf neu angelegt – im Schema-Entwurf trotzdem berücksichtigen. `users/{uid}/data`
(`userCol()` in `index.html:2446`) ist definiert, aber nirgends mehr aufgerufen und hat 0 Dokumente –
**toter Code**, kein aktiver Collection-Pfad.

**Größe:** nicht pauschal abfragbar (Firestore liefert keine Collection-Größe über die REST-API ohne
volles Auslesen). Grobe Schätzung aus Dokumentanzahl × typischer Feldzahl: `logEntries` (31336 Docs ×
~12 flache Felder) ist mit Abstand die größte Collection, gefolgt von `foods` (2263 × 6 Felder) und
`entries` (1247 Docs, aber mit verschachtelten Arrays bei `typ=zirkel` deutlich größer pro Dokument).

### 1c. Feldschema (Stichproben, alt/neu/Mitte, nur Feldnamen+Typ, keine Werte)

#### `entries` (Training, Tageslog, Einzelübungen – **nicht** Ernährung, siehe Finding 2)

Gemeinsame Basis bei allen `typ`-Werten: `id` (string), `datum` (string `YYYY-MM-DD`), `typ` (string,
Enum s.u.), `source` (string, Enum: `manual` | `googlefit` | `plan`), `timestamp` (meist vorhanden,
fehlt bei sehr alten Docs).

| `typ`-Wert (Enum) | Anzahl | Zusätzliche Felder | Bedeutung |
|---|---|---|---|
| `zirkel` | 19 | `runden` (int), `pauseSec`/`pauseMin` (Drift, s. 1d), `prepSec`, `sideSwitchSec`, `uebungen` (array<map>: `typ`,`variant`,`mode`,`holdSec`,`wdh`,`pauseSec`,`perSide`,`metClass`), `details` (array<map>, optional, s. 1d), `planUnitId`, `zeit`, `distanz`, `notiz`, `act_kcal_calc` | Zirkeltraining |
| `laufen` | 103 | `distanz` (double), `zeit` (string), `hf` (int\|null), `schritte` (int), `garminTime` (string), `kalorien` (int), `sets` (string, meist leer – Formularrest), `notiz`, `act_kcal_calc` | Laufen |
| `rad` | 13 | wie `laufen` | Rad |
| `rad_ebike` | 211 | wie `laufen` | E-Bike |
| `gehen` | 205 | wie `laufen` | Gehen |
| `wandern` | 7 | wie `laufen` | Wandern |
| `kraft` | 9 | wie `laufen` (ohne `distanz`-Nutzung) | Krafttraining (generisch) |
| `tageslog` | 384 | `steps` (int), `source_steps` (string, Enum: `googlefit`, teils fehlend bei alten Docs) | Tagesschritte-Fallback (Google-Fit-Pfad) |
| `phonesteps` | 67 | `steps`, `source_steps` (immer `samsung_sensor`), `updatedAt` | **Ausgebaut** (CLAUDE.md: Sensor seit 30.09.2026 entfernt), letzte Docs 30.09.2026 |
| `cardio` | 9 | wie `laufen` | Cardio (MET-Tabelle) |
| `crosstraining` | 0 | – | MET-Tabelle vorhanden, aber **nie genutzt** |
| `pullups`, `pushups`, `lunges`, `terraband_knie`, `custom_*` (10 Werte) | insges. ~225 | `sets` (string/json?), `total_reps`, `pr` (bool?), `first_set`, `variant`, `variantLabel` | **Finding 3**: Einzelübungs-Set-Tracking, komplett undokumentiert in CLAUDE.md |

Schema-Drift-Altfeld: `type` (string, Werte `pull`/`push`) statt `typ` – nur in sehr alten Docs (vor
2025-09, Stichprobe zeigte 2 von 300 mit `type` statt `typ`).

#### `logEntries` (Ernährungstagebuch – food UND recipe, **kein** `typ`-Feld)

Alle 500 jüngsten + 10 ältesten Docs geprüft: durchgängig `id`, `datum`, `date` (Dopplung seit
2024-04-17, nicht erst später eingeführt), `time`, `meal`, `name`, `foodId`, `amount` (double),
`kcal`/`protein`/`carbs`/`fat` (double). `recipeId` zusätzlich bei Rezept-Block-Einträgen (`foodId` ==
`recipeId` in dem Fall). `unit` (string: `grams`|`portions`) **erst seit 2026-11-03** (Teil dieser
Session, siehe vorheriger Commit) – vor Einführung des Felds ist die Einheit aus dem `amount`/`kcal`-
Verhältnis rückrechenbar (`recipeEntryAmountUnit()` in `index.html`), nicht gespeichert. Kein
`_fromRecipe`-Tag in den 500 jüngsten Einträgen gefunden → der „Zutaten einzeln speichern“-Pfad
(`recipeDisplay: 'expanded'`) wird aktuell nicht genutzt (Beobachtung aus Diary-Daten, keine
Settings-Wertabfrage).

#### `foods` (Lebensmittel-Katalog)

`id`, `name` (string), `kcal`/`protein`/`carbs`/`fat` (double, je 100g). Keine Zeitstempel-Felder, nur
ID-Präfix `food_{epoch-ms}_{rand}` gibt grobe Anlagezeit.

#### `recipes`

`id`, `name`, `ingredients` (array<map>, je Zutat vermutlich `foodId`+`amount`, nicht im Detail
aufgelöst), `kcal`/`protein`/`carbs`/`fat`/`portions`/`totalWeight`.

#### `garminActivities` (von Cloud Function `ingestGarmin` befüllt, nur gelesen)

`avgHr`, `maxHr` (int), `distanceM` (double), `durationSec` (double), `garminKcal` (int – **nur ein
Gesamtwert, kein brutto/netto-Split**, siehe vorheriger Bericht zu Teil A), `garminType` (string, Enum
z. B. `treadmill_running`/`running`/`strength_training`), `mappedTyp` (string, Enum: `laufen` oder
`unmapped`), `startLocal` (string ISO), `steps` (int), `updatedAt`.

#### `garminDaily`

`steps` (int), `source` (string), `garminLastSync` (Zeitstempel-String), `fetchedAt`, `updatedAt`.

#### `ciqSteps/{date}`

`ts`, `v`, `steps`, `receivedAt` – plus Subcollection `samples/{autoId}` mit `ts`/`steps`/`receivedAt`
(222 Samples an einem einzigen Tag beobachtet → hochfrequente Live-Schritt-Updates, siehe Lesekosten
Abschnitt 4).

#### `oura_daily`

Ältestes Dokument (2026-10-02) hat weniger Felder (`activeCalories`,`activityScore`,`date`,`steps`,
`totalCalories`) als bereits das zweitälteste (2026-10-03, zusätzlich `deepSleepSec`,`hrvAvg`,
`ouraComplete`,`readinessScore`,`restingHr`,`sleepDurationSec`,`sleepScore`,`tempDeviation`) – Schlaf-
/Erholungsfelder kamen einen Tag nach Sync-Start dazu (vermutlich erste Nacht noch ohne vollständige
Oura-Daten).

#### `oura_workouts`

`activity`, `calories`, `day`, `distance`, `endDatetime`, `id`, `intensity`, `source`, `startDatetime`.

#### `oura_step_log/{date}`

`lastChangeAt`, `lastFetchAt`, `samples` (vermutlich array, Struktur nicht im Detail aufgelöst – nur 2
Dokumente vorhanden, 02./03.10.2026, danach nicht fortgeführt: möglicherweise durch `ciqSteps`
abgelöst).

#### `weeklyStats` (Aggregat, reicht bis **2018-W35** zurück – mit Abstand älteste Daten im System)

`week`, `days`, `kcal`, `kcal_goal`, `carbs`, `protein`, `fat`, `weight`, `run_km`, `act_kcal_calc`,
`act_kcal_garmin`, `trainings`. Durchgehend gleiches Schema von 2018 bis heute (keine Drift
festgestellt) – wirkt wie ein von Anfang an stabiler wöchentlicher Snapshot.

#### `dailyCheck` – **Finding 1, komplett undokumentiert**

`actions`, `confidence`, `createdAtMs`, `date`, `flags`, `headline`, `model`, `planSuggestion`,
`reason`, `status`, `suggestionStatus` (optional, fehlt im ältesten Sample 2026-10-18, ab 2026-10-20
vorhanden). Laut `index.html` (Zeilen ~8661ff., `dailyCheckShiftDate`/`dailyCheckEvalNight`/
`dailyCheckPlanUnitsForDay`) eine **bereits produktive KI-Tagescoaching-Funktion**, die denselben
Anthropic-Call wie der Analyse-Tab nutzt (`settings.anthropicApiKey`), täglich einmal läuft und
Schlaf/Erholung (Oura) mit dem Trainingsplan abgleicht. CLAUDE.md erwähnt nur die *geplante*
Foto-Kalorienschätzung als künftiges KI-Feature – dieses bereits laufende Feature fehlt dort komplett.

#### `dailyCheckCallLog`

`atMs`, `date`, `trigger` – reines Debug-/Audit-Log für `dailyCheck`-Aufrufe.

#### `trainingplans/{Montag}`

`datum`, `mo`…`so` (vermutlich je ein geplanter Trainingstyp pro Wochentag), `updatedAt`.

#### `intervalTemplates`

`id`, `name`, `prepSec`, `roundPauseSec`, `rounds`, `steps` (array), `updatedAt` – nur 1 Dokument
aktuell angelegt.

### 1d. Schema-Drift (zusammengefasst, mit Datum wo feststellbar)

| Feld/Wechsel | Collection | Alt → Neu | Zeitpunkt |
|---|---|---|---|
| `type` → `typ` | `entries` | `type: pull/push` → `typ: <enum>` | vor 2025-09 (genauer Zeitpunkt aus Stichprobe nicht eingrenzbar) |
| `pauseMin` → `pauseSec` | `entries` (zirkel) | Minuten → Sekunden | exakt zwischen 2026-09-28 und 2026-09-30 |
| `details` (neu) | `entries` (zirkel) | fehlt → vorhanden | exakt ab 2026-10-11 |
| `prepSec` (neu) | `entries` (zirkel) | fehlt → vorhanden | exakt ab 2026-10-11 (gleicher Tag wie `details`) |
| `sideSwitchSec` (neu) | `entries` (zirkel) | fehlt → vorhanden | exakt ab 2026-10-12 (einen Tag nach `prepSec`) |
| `linkedGarmin` | – | **kein Firestore-Feld** | wird clientseitig in `getEffectiveTrainingEntries()` berechnet, nie gespeichert |
| `unit` (neu) | `logEntries` | fehlt → `grams`/`portions` | ab 2026-11-03 (diese Session, voriger Bericht Teil B) |
| Schlaf-/Erholungsfelder (neu) | `oura_daily` | fehlen am ersten Tag → ab 2. Tag vorhanden | 2026-10-02 → 2026-10-03 |
| `suggestionStatus` (neu) | `dailyCheck` | fehlt → vorhanden | zwischen 2026-10-18 und 2026-10-20 |

`exIdx` (im Auftrag als Beispiel genannt) wurde **nicht gefunden** – in keinem gelesenen `uebungen`-
Eintrag vorhanden, vermutlich ein hypothetisches Beispiel im Auftrag, kein reales Feld.

## 2. Sensible Bereiche

### `settings/` (nur Feldnamen, keine Werte)

| Dokument | Felder | Secrets? |
|---|---|---|
| `main` | `activityLevel`,`age`,`anthropicApiKey`,`assumedDailySteps`,`carbsGoal`,`detailDays`,`fatGoal`,`gender`,`height`,`proteinGoal`,`recipeDisplay`,`tdee`,`weight` | **`anthropicApiKey` ist ein Secret** |
| `favorites` | `ids` | – |
| `backup` | `lastDriveBackup`,`lastDriveFileId`,`lastDriveFileName` | – (Referenzen, keine Tokens) |
| `exercises` | 11 `custom_*`/Standard-Übungsschlüssel | – (Konfiguration) |
| `subjectiveStatus` | `history` | – (vermutlich Freitext/Verlauf, Gesundheitsbezug – Inhalt nicht geprüft) |

### `integrations/` (nur Feldnamen, keine Werte)

| Dokument | Felder | Secrets? |
|---|---|---|
| `googlefit` | `accessToken`,`refreshToken`,`expiresAt`,`connectedAt`,`lastSyncActivities`,`lastSyncAt`,`lastSyncSteps` | **ja** (`accessToken`,`refreshToken`) |
| `googledrive` | `accessToken`,`refreshToken`,`expiresAt`,`connectedAt` | **ja** |
| `strava` | `accessToken`,`refreshToken`,`expiresAt`,`athleteId`,`athleteName`,`connectedAt`,`lastSyncAt`,`lastSyncCount` | **ja** |
| `oura` | `connected`,`connectedAt`,`lastStepSyncAt`,`lastSyncAt`,`lastSyncDays`,`lastSyncError` | nein – Token liegt stattdessen in Top-Level `oura_tokens/{uid}` (**Finding 4**: inkonsistente Architektur ggü. den anderen drei Integrationen) |
| `garminHealth` | `checkedAt`,`ok`,`reason`,`staleSince` | nein (Status, kein Secret) |
| `garminParity` | `computedAt`,`days` | nein |
| `garminStatus` | `lastDate`,`lastGarminSync`,`lastIngestAt`,`lastSteps` | nein |

### Top-Level-Secrets außerhalb von `users/`

- `oura_tokens/{uid}`: `accessToken`,`refreshToken`,`expiresAt`,`connectedAt` – **Secret**, Doc-ID ist
  direkt die `{uid}` (kein `users/`-Präfix).
- `stravaAthletes/{athleteId}`: `updatedAt`,`userId` – keine Tokens, aber `userId` referenziert die
  Fuelofit-`{uid}` (personenbeziehbare Verknüpfung, kein Geheimnis im engeren Sinn).

### Kategorisierung aller Collections

| Kategorie | Collections |
|---|---|
| **Secrets** | `settings/main` (nur `anthropicApiKey`), `integrations/{googlefit,googledrive,strava}`, `oura_tokens` |
| **Gesundheit** (Gewicht, Puls, Schlaf, Befinden) | `garminActivities` (Puls), `oura_daily` (Schlaf/Erholung), `settings/subjectiveStatus`, `dailyCheck` (KI-Bewertung auf Basis obiger Daten), `weeklyStats.weight` |
| **Ernährung** | `logEntries`, `foods`, `recipes`, `settings/favorites` |
| **Bewegung** | `entries`, `garminDaily`, `ciqSteps` (+`samples`), `oura_workouts`, `oura_step_log`, `trainingplans`, `intervalTemplates`, `weeklyStats` (teilweise) |
| **Konfiguration** | `settings/{main-nicht-Secret-Felder,backup,exercises}`, `integrations/{garminHealth,garminParity,garminStatus,oura-nicht-Secret-Felder}`, `trainingTypes`, `dailyCheckCallLog`, `stravaAthletes` |

## 3. Beziehungen

**Gespeicherte Referenzen:**
- `logEntries.foodId` → `foods.id` (immer), zusätzlich `logEntries.recipeId` → `recipes.id` bei
  Rezept-Block-Einträgen (dann `foodId == recipeId`).
- `recipes.ingredients[].foodId` → `foods.id`.
- `garminActivities` ↔ `entries` (zirkel): **keine gespeicherte Referenz** – die Verknüpfung
  `garminLinks/{activityId}: {unlinked: true, at}` speichert nur *gelöste* Zuordnungen; die aktive
  Zuordnung selbst wird nicht persistiert, sondern bei jedem Laden neu berechnet (s. u.).
- `garminHidden/{activityId}: {hiddenAt}` markiert eine Garmin-Aktivität als ausgeblendet (vom Nutzer
  „Löschen“ auf eine reine Garmin-Aktivität ohne Zirkel-Bezug).
- `stravaAthletes/{athleteId}.userId` → Fuelofit-`{uid}`.

**Live berechnet (nicht gespeichert), mit Funktionsname in `index.html`:**

| Wert | Funktion | Quelle(n) |
|---|---|---|
| Zirkel ↔ Garmin-Aktivität-Zuordnung | `computeZirkelGarminLinksForDate()` / `getEffectiveTrainingEntries()` | zeitliche Nähe zwischen `entries.typ=zirkel` und `garminActivities` (abzüglich `garminLinks`-Ausschlüssen) |
| Tagesschritte | `getRawStepsForDate()` → `getStepsSourceForDate()` | `max(garminDaily.steps, ciqSteps.steps)`, Fallback `oura_daily.steps` (nur vergangene Tage), sonst `entries.typ=tageslog.steps` |
| Aktivitäts-Schritte (Abzug) | `getActivityStepsForDate()` | je nach `getStepsSourceForDate()`: sichtbare Garmin-Aktivitäten oder `entries` mit `schritte>0` |
| Kalorienziel gesamt | `calcHistoricalKcalGoal()` | BMR (Mifflin-St.-Jeor, `mifflinStJeorBmr()`) × Aktivitätsfaktor + Aktivitätskalorien + Schrittkalorien |
| Aktivitätskalorien je Eintrag | `calcActivityKcal()` → `calcPlanActivityKcal()`/MET-Formeln/`zirkelPulseBreakdown()` | `entries`-Felder + `garminActivities` (bei verknüpftem Zirkel, Puls-Mischung) |
| Zirkel-Formel-Kalorien | `calcZirkelEntryKcal()` | `entries.uebungen`/`entries.details` |
| Grundumsatz (BMR) | `mifflinStJeorBmr()`/`calcBmrForDate()` | `settings/main` (Gewicht/Größe/Alter/Geschlecht) |
| Garmin-Sync-Warnbanner | `garminStaleBannerInfo()` | `integrations/garminHealth`, `garminDaily` |

## 4. Lesekosten

**Diese Bestandsaufnahme** (geloggte Calls, grob zusammengefasst): ca. 90 Aggregations-Queries (je
minimal 1 Lese-Einheit, bei größeren Collections mit `where`-Filter etwas mehr), ca. 150
Einzeldokument-/`listDocuments`-Abrufe, plus drei größere Stichproben (`entries` 300 Docs,
`logEntries` 500+20 Docs, `source_steps`-Scan 400+67 Docs). **Grobschätzung: ca. 1.500–1.800
Lesevorgänge** – exakte Firestore-Abrechnung für Aggregationsabfragen ist nicht 1:1 aus der REST-
Antwort ablesbar (Billing-Einheiten ≠ Dokumentenzahl bei `runAggregationQuery`), daher nur eine
Näherung, keine exakte Monatsrechnung.

**Vollständiger Erst-Export** (alle Dokumente aller Fuelofit-Collections unter `users/{uid}` + die 4
Top-Level-Collections): grob **~37.500 Dokumente** (`logEntries` 31336 + `foods` 2263+2263 + `entries`
1247 + `recipes` 186 + `weeklyStats` 177 + `oura_daily` 33 + `garminActivities`/`garminDaily` je 6 +
`ciqSteps` 3 + `samples` ca. 200/Tag× Alter + Rest) → **ca. 38.000–40.000 Firestore-Reads einmalig**.
`ciqSteps/samples` ist der große Unbekannte: bei 222 Samples/Tag seit erst drei Tagen Laufzeit aktuell
klein, wächst aber potenziell auf tausende Dokumente/Monat, falls das Feature dauerhaft läuft – vor
einem produktiven Sync unbedingt eine Aggregationsbremse (z. B. nur Tagesdokument syncen, `samples`
auslassen) einplanen.

**Täglicher inkrementeller Sync** (nur neue/geänderte Dokumente seit letztem Lauf, Datum-basiert
gefiltert): `logEntries` + `entries` zusammen typischerweise niedrige zweistellige Anzahl neuer
Dokumente/Tag (Ernährungstagebuch dominiert), plus je 1 neues Tagesdokument in `garminDaily`,
`ciqSteps`, `oura_daily`, `weeklyStats` (wöchentlich), `dailyCheck`. **Grobschätzung: 50–150
Reads/Tag**, ohne `ciqSteps/samples` (siehe oben – falls samplegenau gesynct wird, zusätzlich bis zu
~250 Reads/Tag allein dafür).

## 5. Ergebnisdatei

Diese Datei: `~/fitness-tracker/docs/datenmodell.md`. Geprüft auf Werte aus `settings`/`integrations`,
E-Mail-Adressen, Tokens und Klartext-uid vor dem Commit (siehe Prüfprotokoll unten).

## 6. Vorschläge (NICHT umgesetzt)

### 6a. Relationales Schema (Entwurf, Postgres)

```
-- Stammdaten
foods(food_id PK, name, kcal_per100, protein_per100, carbs_per100, fat_per100)
recipes(recipe_id PK, name, kcal_total, protein_total, carbs_total, fat_total, portions, total_weight_g)
recipe_ingredients(recipe_id FK, food_id FK, amount_g, PRIMARY KEY(recipe_id, food_id))

-- Ernährungstagebuch (aus logEntries)
diary_entries(
  entry_id PK, entry_date DATE, entry_time TIME, meal TEXT,
  food_id FK NULL, recipe_id FK NULL, name TEXT,
  amount NUMERIC, unit TEXT CHECK (unit IN ('grams','portions')),  -- vor 2026-11-03: NULL, per Heuristik nachträglich befüllbar
  kcal NUMERIC, protein NUMERIC, carbs NUMERIC, fat NUMERIC
)
INDEX ON diary_entries(entry_date)

-- Training/Bewegung (aus entries, typ-Diskriminator als eigene Spalte + JSONB für variable Felder)
training_entries(
  entry_id PK, entry_date DATE, typ TEXT, source TEXT,
  distanz_km NUMERIC NULL, zeit_sec INT NULL, hf_avg INT NULL, hf_max INT NULL,
  schritte INT NULL, kalorien_formel NUMERIC NULL,
  -- Zirkel-spezifisch, NULL bei anderen Typen:
  runden INT NULL, pause_sec INT NULL, prep_sec INT NULL, side_switch_sec INT NULL,
  uebungen JSONB NULL, details JSONB NULL,
  -- Einzelübungs-Sets (Finding 3), NULL bei Cardio/Zirkel:
  sets JSONB NULL, total_reps INT NULL, pr BOOLEAN NULL,
  raw JSONB  -- Fallback für alles Nicht-Modellierte, Schema-Drift-Toleranz
)
INDEX ON training_entries(entry_date, typ)

-- Garmin
garmin_activities(activity_id PK, start_local TIMESTAMPTZ, duration_sec NUMERIC,
  garmin_type TEXT, mapped_typ TEXT, avg_hr INT, max_hr INT, distance_m NUMERIC,
  garmin_kcal INT, steps INT)
garmin_daily(day DATE PK, steps INT, garmin_last_sync TIMESTAMPTZ)
garmin_zirkel_links(activity_id FK, entry_id FK, unlinked BOOLEAN, linked_at TIMESTAMPTZ)
  -- Hinweis: aktive Zuordnung wird in Fuelofit live berechnet, nicht gespeichert;
  -- für die Analyse-DB müsste der Sync den berechneten Stand snapshotten oder die
  -- Zuordnungslogik (computeZirkelGarminLinksForDate) in Postgres nachbilden.

-- Schlaf/Erholung (Oura)
oura_daily(day DATE PK, steps INT, active_calories NUMERIC, total_calories NUMERIC,
  sleep_duration_sec INT NULL, deep_sleep_sec INT NULL, hrv_avg NUMERIC NULL,
  resting_hr INT NULL, sleep_score INT NULL, readiness_score INT NULL, activity_score INT NULL)
oura_workouts(workout_id PK, day DATE, activity TEXT, calories NUMERIC, distance NUMERIC,
  start_ts TIMESTAMPTZ, end_ts TIMESTAMPTZ, intensity TEXT, source TEXT)

-- Gewicht/Kalorienbilanz (abgeleitet, täglich materialisiert statt live berechnet)
daily_summary(
  day DATE PK, weight NUMERIC NULL,
  bmr NUMERIC, kcal_goal_base NUMERIC, kcal_goal_activity NUMERIC, kcal_goal_daily_steps NUMERIC,
  kcal_goal_total NUMERIC, kcal_eaten NUMERIC, protein_eaten NUMERIC, carbs_eaten NUMERIC, fat_eaten NUMERIC,
  steps INT, steps_source TEXT
)
-- entspricht calcHistoricalKcalGoal() + Tagesaggregat aus diary_entries; müsste beim Sync oder
-- per Postgres-View nachgebildet werden, da in Firestore nicht gespeichert.

weekly_stats(week TEXT PK, kcal NUMERIC, kcal_goal NUMERIC, carbs NUMERIC, protein NUMERIC, fat NUMERIC,
  weight NUMERIC, run_km NUMERIC, act_kcal_calc NUMERIC, act_kcal_garmin NUMERIC, trainings INT)
```

Wichtigste Indizes: `diary_entries(entry_date)`, `training_entries(entry_date, typ)`,
`garmin_activities(start_local)`, `oura_daily(day)` – alle zeitreihenbasierten Auswertungen filtern
zuerst auf Datum.

### 6b. Sync-Varianten (Pro/Contra)

**(i) VPS holt Daten über eine Export-Cloud-Function mit Secret** (analog zu `ingestGarmin`, nur
umgekehrte Richtung – VPS ruft eine `exportForAnalytics`-Function mit Secret-Header auf, Function
liest Firestore mit Service-Account-Rechten und liefert JSON zurück):
- Pro: kein Firestore-Service-Account-Schlüssel auf dem VPS nötig (passt zum bestehenden
  Sicherheitsmodell, in dem der VPS nur ein Secret hält, keine IAM-Credentials); zentrale Stelle für
  Filterung/Maskierung (Secrets bleiben serverseitig in der Function, nie im Response).
- Contra: zusätzliche Cloud-Function-Wartung und -Kosten (Blaze-Plan sowieso aktiv); Function muss
  Pagination/inkrementelle Logik selbst abbilden; Kaltstart-Latenz bei seltenen Syncs.

**(ii) Cloud Function schreibt aktiv in eine Datenbank** (Firestore-Trigger `onWrite` → Postgres, z. B.
via Cloud SQL Proxy oder HTTP-Endpunkt der Analyse-DB):
- Pro: nahezu Echtzeit-Sync, kein Pull-Scheduling nötig; inkrementell „for free“ über Trigger.
- Contra: Cloud Function braucht Netzwerkzugriff auf die externe DB (VPC-Connector o. ä., mehr
  Infrastruktur als bisher); Trigger auf `ciqSteps/samples` würde bei 222 Writes/Tag sehr viele
  Function-Aufrufe erzeugen (Kosten/Rate-Limits) – müsste explizit ausgeschlossen werden; Fehlerfälle
  (DB down) brauchen eigene Retry-/Dead-Letter-Logik, die bei Variante (i) durch den VPS-seitigen Pull
  einfacher zu beherrschen wäre.

**Alternative: MCP liest Firestore direkt, keine eigene DB:**
- Pro: keine Sync-Logik, keine Datendrift, keine zusätzliche Infrastruktur; immer aktueller Stand.
- Contra: keine SQL-Aggregationen/Joins (Firestore kennt keine Cross-Collection-Joins) – alles, was
  in Abschnitt 3 als „live berechnet“ markiert ist, müsste der MCP-Server selbst nachbilden oder bei
  jeder Anfrage viele Einzel-Reads machen; komplexe Zeitreihen-Analysen (z. B. 2-Jahres-Trend über
  `logEntries`, 31336 Docs) sind über Firestore-Queries langsam/teuer verglichen mit einem SQL-Index;
  kein Offline-Zugriff, wenn Firestore/Netz nicht erreichbar ist.

### 6c. Was NICHT in die Analyse-DB sollte

- **Alle in Abschnitt 2 als Secret markierten Felder** (`anthropicApiKey`, alle `accessToken`/
  `refreshToken`-Paare in `integrations/*` und `oura_tokens`) – niemals syncen, auch nicht verschlüsselt,
  wenn die Analyse-DB einen anderen Schutzkreis hat als Firestore/Secret Manager.
- `settings/backup` (`lastDriveFileId` etc.) – reine Betriebs-Metadaten ohne Analysewert.
- `dailyCheckCallLog` – Debug-Log, kein Analysewert.
- Freitext mit potenziell sensiblem Inhalt: `entries.notiz`, `settings/subjectiveStatus.history`,
  `dailyCheck.{headline,reason,planSuggestion}` – falls die Analyse-DB von einem MCP-Server bedient
  wird, der von einem LLM ausgelesen wird, sollten Freitextfelder bewusst entschieden werden (ja/nein),
  nicht automatisch mitgezogen werden, da sie z. B. gesundheitsbezogene Formulierungen in Prosa statt
  strukturierten Werten enthalten können.
- `ciqSteps/samples` roh – siehe 4, nur als aggregiertes Tagesdokument sinnvoll, nicht Sample-für-Sample.
- Top-Level `stravaAthletes.userId` sollte, falls gesynct, nicht ohne Zweck mit der Fuelofit-`uid`
  verknüpft dauerhaft gespeichert werden (minimieren, was nicht gebraucht wird).

---

## Prüfprotokoll (vor Commit)

Vor dem Commit per grep geprüft: kein Treffer für Secret-/Token-Werte (Muster `sk-ant-...`,
`accessToken`/`refreshToken` gefolgt von einem Wertliteral), kein Treffer für die reale Firebase-`uid`
(28-stelliges alphanumerisches Muster) außerhalb des Platzhalters `{uid}`, kein Treffer für
E-Mail-Adressen.

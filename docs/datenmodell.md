# Fuelofit – Datenmodell-Bestandsaufnahme (Firestore)

Stand: 2026-11-04 (ersetzt die Fassung vom 2026-11-03). Projekt `fitness-tracker-c6f97`, Datenbank
`(default)`. Nur lesend erhoben über die Firestore-REST-API (`runQuery`, `runAggregationQuery`,
`listCollectionIds`) mit `gcloud auth print-access-token`. Keine Schreibzugriffe, keine Deploys, keine
Index-Anlage, VPS nicht berührt.

Konventionen: keine Feldwerte, keine Secrets, uid nur als `{uid}`. Bei Kategorie-Feldern (z. B. `typ`)
sind die vorkommenden Werte genannt. Wo „n/N“ steht: n von N Stichproben-Dokumenten haben das Feld.
Zählungen sind Aggregations-Counts (`count()`), Zeiträume stammen aus `orderBy … limit 1`.

Single-User-App: `users/` enthält genau einen Dokumentpfad `users/{uid}`. Das Elterndokument
`users/{uid}` hat keine Felder, es trägt nur Subcollections.

---

## 1. Inventar

### 1a/1b. Collections, Anzahl, Zeitraum, Größe

Die Größe ist die mittlere REST-JSON-Größe der Stichproben × Anzahl. Die echte Firestore-Speichergröße
ist kleiner (ohne JSON-Overhead), dafür kommen Indizes hinzu. Als Größenordnung ist der Wert brauchbar.

**Top-Level**

| Collection | Doc-ID | Anzahl | Zeitraum | Größe ca. | Kategorie |
|---|---|---|---|---|---|
| `foods` | `food_{ms}_{rand}`, `off_{barcode}` | 2293 | `food_`-IDs 2026-04-13 – 2026-04-16 (Batch-Import), `off_` ohne Zeitbezug | 0,8 MB | Ernährung (Katalog) |
| `trainingTypes` | `custom_{name}` | 11 | kein Datumsfeld | 2 KB | Konfiguration |
| `stravaAthletes` | `{stravaAthleteId}` | 1 | `updatedAt` 2026-04-14 | <1 KB | Konfiguration (Altbestand, s. 1d) |
| `oura_tokens` | `{uid}` | 1 | – | <1 KB | **Secrets** |
| `oura_oauth_state` | `{state}` | 0 (transient, nur während OAuth) | – | – | Secrets (kurzlebig) |
| `dart_*` (9 Collections) | – | 181 zusammen | – | – | eigene Darts-App, nicht Teil dieser Aufnahme |

**Unter `users/{uid}/`** (17 Subcollections laut `listCollectionIds`, dazu 3 im Code genutzte, derzeit
leere Collections)

| Subcollection | Doc-ID | Anzahl | Zeitraum (ältestes – neuestes) | Größe ca. | Kategorie |
|---|---|---|---|---|---|
| `logEntries` | `{ms}_{rand}` | 31347 | 2024-04-17 – 2026-11-04 (`date`) | 17,5 MB | Ernährung |
| `entries` | `{ms}`, `gfit_HealthSync_exercise_{ms}`, `log_{YYYYMMDD}` u. a. | 1250 | 2025-09-12 – 2026-11-04 (`datum`) | 1,4 MB | Bewegung, Gesundheit (Gewicht, Puls) |
| `foods` (nutzereigen) | `food_{ms}_{rand}`, `off_{barcode}` | 2263 | `food_`-IDs 2026-04-13 – 2026-04-16 | 0,8 MB | Ernährung (**Altbestand**, s. 1d) |
| `recipes` | `recipe_{ms}_{rand}` | 186 | IDs 2026-05-01 – 2026-10-25 | 0,4 MB | Ernährung |
| `weeklyStats` | `{YYYY}-W{WW}` | 177 | 2018-W35 – **2026-W18** (seitdem nicht fortgeschrieben, s. 1d) | 0,1 MB | Aggregat (Ernährung/Bewegung) |
| `oura_daily` | `{YYYY-MM-DD}` | 34 | 2026-10-02 – 2026-11-04 | 20 KB | Gesundheit (Schlaf/Erholung), Bewegung |
| `oura_workouts` | UUID | 16 | `day` 2026-10-08 – 2026-11-01 | 9 KB | Bewegung |
| `oura_step_log` | `{YYYY-MM-DD}` | 2 | 2026-10-02 – 2026-10-03 | 1 KB | Bewegung (Altbestand) |
| `garminActivities` | `{activityId}` | 8 | `startLocal` 2026-10-29 – 2026-11-04 | 4 KB | Bewegung, Gesundheit (Puls) |
| `garminDaily` | `{YYYY-MM-DD}` | 7 | 2026-10-29 – 2026-11-04 | 2 KB | Bewegung |
| `ciqSteps` | `{YYYY-MM-DD}` | 4 | 2026-11-01 – 2026-11-04 | 1 KB | Bewegung |
| `ciqSteps/{date}/samples` | auto-ID | 796 (68 / 286 / 265 / 177 je Tag) | 2026-11-01 – 2026-11-04 | 0,2 MB | Bewegung |
| `dailyCheck` | `{YYYY-MM-DD}` | 18 | 2026-10-18 – 2026-11-04 | 29 KB | Gesundheit (KI-Tagesbewertung, Freitext) |
| `dailyCheckCallLog` | `{YYYY-MM-DD}_{ms}` | 7 | 2026-10-30 – 2026-11-04 | 2 KB | Konfiguration/Log |
| `trainingplans` | `{YYYY-MM-DD}` (Montag) | 5 | 2026-09-28 – 2026-11-02 | 43 KB | Bewegung (Plan) |
| `intervalTemplates` | `iv_{ms}_{rand}` | 1 | 2026-10-05 | 1 KB | Konfiguration |
| `settings` | `main`, `favorites`, `backup`, `exercises`, `subjectiveStatus` | 5 | – | – | Konfiguration, **Secrets** (`main`), Gesundheit (`subjectiveStatus`) |
| `integrations` | 7 feste Docs (s. 2) | 7 | – | – | Konfiguration, **Secrets** |
| `garminLinks` | `{activityId}` | 0 | – | – | Bewegung (Zuordnung) |
| `garminHidden` | `{activityId}` | 0 | – | – | Bewegung |
| `data` | – | 0 | – | – | toter Code (`userCol()`, kein Aufruf) |

Rekursive Suche nach Subcollections: `listCollectionIds` auf allen Dokumenten der kleinen Collections
(≤ 60 Docs) und auf je 20 verteilten Stichproben der großen (`entries`, `logEntries`, `foods`,
`recipes`, `weeklyStats`, `oura_daily`). Einzige Sub-Subcollection: `ciqSteps/{date}/samples`. Ein
`collectionGroup('samples')`-Count über die ganze Datenbank liefert ebenfalls nur diese 796 Docs.
Grenze: Subcollections unter nicht gezogenen Dokumenten großer Collections lassen sich so nicht
ausschließen. Laut Code (`index.html`, `~/functions`) gibt es dort aber keine.

Gesamtsumme ohne `dart_*`: **ca. 38.440 Dokumente, ca. 21 MB** (REST-JSON).

### 1c. Feldschema (≤ 20 Stichproben je Collection, über den Zeitraum verteilt)

Stichprobenwahl: datierte Collections über gleichmäßig verteilte Stützdaten (`datum >= X … limit 1`),
ID-datierte über ID-Bereiche. Collections mit ≤ 20 Docs sind vollständig gelesen.
Feldtypen: string, int, double, bool, null, timestamp, map, array. „int|double“ heißt, dass im selben
Feld beide numerischen Typen vorkommen.

#### `entries` (20 Stichproben; Präsenz zusätzlich per Count über alle 1250)

Diskriminator `typ` (1248 Docs) bzw. Altfeld `type` (2 Docs). Verteilung per Count (Summe 1248 ✓):

| `typ` | Anzahl | Zeitraum |
|---|---|---|
| `tageslog` | 384 | durchgehend |
| `rad_ebike` | 212 | durchgehend |
| `gehen` | 205 | durchgehend |
| `laufen` | 103 | durchgehend |
| `pushups` | 76 | ab 2026-04 |
| `pullups` | 74 | ab 2026-04 |
| `phonesteps` | 67 | 2026-05-20 – 2026-09-30 |
| `terraband_knie` | 39 | ab 2026-06 |
| `zirkel` | 20 | 2026-09-28 – 2026-11-04 |
| `rad` | 13 | – |
| `kraft` | 10 | – |
| `cardio` | 9 | – |
| `wandern` | 7 | – |
| `lunges` | 1 | – |
| `custom_*` (8 Werte) | 28 | 2026-08-12 – 2026-11-03 (`custom_bizep_curls` 8, `custom_hanging_knee_raises` 6, `custom_plank_to_push_up` 6, `custom_wall_sits` 3, `custom_split_squats` 2, `custom_clamshells` 1, `custom_gerade_planks` 1, `custom_seitliche_planks` 1) |

Felder (Präsenz = Count über alle 1250 Docs):

| Feld | Typ | Präsenz | Bei `typ` |
|---|---|---|---|
| `id` | string | immer | alle |
| `datum` | string `YYYY-MM-DD` | immer (1250) | alle |
| `date` | – | **0** | – (s. 1d) |
| `typ` / `type` | string | 1248 / 2 | – |
| `source` | string, Werte `googlefit` (559), `manual` (207), `plan` (33) | 799 | alle außer `tageslog`/`phonesteps` |
| `timestamp` | string | 803 | wie `source` |
| `notiz` | string | 799 | wie `source` |
| `act_kcal_calc` | int | 797 | wie `source` |
| `distanz` | int\|double | optional | Cardio-Typen, `zirkel` |
| `zeit` | string | 592 | Cardio-Typen, `zirkel` |
| `hf` | null (in allen Stichproben) | optional | Cardio-Typen |
| `schritte` | int\|null | optional | Cardio-Typen |
| `kalorien` | int | 559 | Cardio-Typen |
| `garminTime` | string | 759 | Cardio- und Satz-Typen |
| `sets` | string | 777 | Cardio-Typen (leer) und Satz-Typen |
| `variant`, `variantLabel` | string | 218 | Satz-Typen (`pullups`, `pushups`, `terraband_knie`, `custom_*`) |
| `total_reps`, `pr` | – | 2 | nur die 2 Alt-Docs mit `type` |
| `steps` | int | 451 | `tageslog`, `phonesteps` |
| `source_steps` | string, Werte `googlefit` (384), `samsung_sensor` (67) | 451 | `tageslog`, `phonesteps` |
| `updatedAt` | – | 67 | nur `phonesteps` |
| `weight` | (nicht gelesen) | 10 | nur `tageslog`, 2026-04-16 – 2026-11-03 |
| `planUnitId` | string | 32 | `zirkel` (19), `custom_bizep_curls` (7), `pullups` (6) |
| `runden` | int | – | `zirkel` |
| `pauseSec` / `pauseMin` | int | 32 / 1 | `zirkel` und Satz-Typen mit Plan |
| `prepSec` | int | 14 | `zirkel` |
| `sideSwitchSec` | int | 13 | `zirkel` |
| `uebungen` | array<map> | 20 | `zirkel` – Elemente: `typ`, `variant`, `mode` (`reps`/`time`), `wdh`, `holdSec`, `pauseSec`, `perSide` (bool), `metClass` (`leicht`/`mittel`/`intensiv`) |
| `details` | array<map> | 14 | `zirkel` – Elemente: `round`, `typ`, `variant`, `mode`, `wdh`, `sec`, `exIdx` (int, s. 1d) |
| `linkedGarmin`, `suggestionApplied`, `exIdx` (top-level) | – | 0 | nicht gespeichert |

#### `logEntries` (20 Stichproben; Präsenz per Count über alle 31347)

| Feld | Typ | Präsenz |
|---|---|---|
| `id`, `name`, `foodId`, `time` | string | immer |
| `date` | string | immer (31347) |
| `datum` | string | **29632** – 1715 Docs ohne `datum` (s. 1d) |
| `meal` | string, Werte `Morgens`, `Mittags`, `Nachmittags`, `Abends` | immer |
| `amount` | int (Stichproben) | immer |
| `kcal`, `protein`, `carbs`, `fat` | int\|double | immer |
| `recipeId` | string | 421 (2026-05-12 – 2026-11-04) |
| `_fromRecipe` | (nicht gelesen) | 44 (2026-04-25 – 2026-04-30) |
| `unit` | string, Werte `grams` (6), `portions` (2) | 8 (ab 2026-11-03) |

#### `foods` (Top-Level, 20 Stichproben) und `users/{uid}/foods` (20 Stichproben)

Beide haben: `id`, `name` (string), `kcal` (int), `protein`, `carbs`, `fat` (int\|double, je 100 g).
Top-Level zusätzlich `kategorie` (string, 2258 von 2293). Nutzereigen zusätzlich `source` (string,
Wert `openfoodfacts`, 2 Docs). Keine Zeitfelder.

#### `recipes` (12 Stichproben – nur 12 verschiedene IDs über die Bereichs-Probe gefunden)

`id`, `name` (string), `kcal`, `protein`, `carbs`, `fat` (int\|double), `portions`, `totalWeight` (int),
`ingredients` (array<map>, immer). Elemente: `foodId`, `name` (string), `amount` (int), `kcal`,
`protein`, `carbs`, `fat` (int\|double) – Nährwerte je Zutat sind **denormalisiert mitgespeichert**.

#### `weeklyStats` (13 Stichproben über 2018–2026)

`week` (string), `days`, `kcal`, `kcal_goal`, `carbs`, `protein`, `fat`, `act_kcal_calc`,
`act_kcal_garmin`, `trainings` (int), `run_km` (int\|double), `weight` (null in allen Stichproben;
per Count nur in 1 von 177 Docs nicht null, 2026-W16). `steps_total`, `steps_activity`, `steps_daily`
(int) in 111 Docs, 2024-W14 – 2026-W18.

#### `oura_daily` (19 Stichproben)

Immer: `date` (string), `steps`, `activeCalories`, `totalCalories`, `activityScore`, `sleepDurationSec`,
`deepSleepSec`, `hrvAvg`, `restingHr` (int). Optional: `sleepScore` (int, 32/34 per Count),
`readinessScore` (int), `tempDeviation` (int\|double), `ouraComplete` (bool, 24/34 per Count).
Seit 004c (07.11.2026, selber `/v2/usercollection/sleep`-Call wie `sleepDurationSec` o.ä., kein
neuer API-Request): `remSleepSec`, `lightSleepSec`, `awakeSec` (int, Sekunden), `sleepEfficiency`
(int, Prozent 0-100), `respiratoryRate` (double, Atemzüge/Minute), `sleepLatencySec` (int),
`bedtimeStart`, `bedtimeEnd` (string, ISO-Datetime mit Offset) - wie die uebrigen Nachtwerte nur
bei `type === 'long_sleep'` gesetzt.

#### `oura_workouts` (16, vollständig)

`id`, `day`, `startDatetime`, `endDatetime` (string), `activity` (Werte `cycling`, `running`,
`strengthTraining`, `walking`), `intensity` (`easy`), `source` (`confirmed`), `calories` (double),
`distance` (null).

#### `oura_step_log` (2, vollständig)

`lastChangeAt`, `lastFetchAt` (string), `samples` (array<map>: `t` string, `steps` int).

#### `garminActivities` (19, vollständig)

`startLocal` (string ISO mit Offset), `durationSec` (double), `distanceM` (int\|double), `avgHr`,
`maxHr`, `garminKcal` (int), `steps` (int\|null), `garminType` (Werte `running`, `treadmill_running`,
`strength_training`, `e_bike_fitness`), `mappedTyp` (Werte `laufen`, `rad_ebike`, `unmapped`),
`updatedAt` (timestamp). Seit 004c (07.11.2026, Quelle Garmin Personal API `search_activities`):
`aerobicTE`, `anaerobicTE` (double, 0-5, immer gesetzt), `elevationGainM` (double\|null, nur bei
GPS-Cardio, nicht bei `strength_training`), `avgSpeedMs` (double, m/s, Geraetewert = `distanceM`/
Bewegungszeit, kann leicht von `distanceM`/`durationSec` abweichen), `avgCadence`/`maxCadence`
(double\|null, nur bei `running`/`treadmill_running`, Schritte/Minute).

#### `garminDaily` (7, vollständig)

`steps` (int), `source` (Wert `garmin_direct`), `garminLastSync`, `fetchedAt` (string), `updatedAt`
(timestamp).

#### `ciqSteps/{date}` (4) und `ciqSteps/{date}/samples` (20 Stichproben, je 5 pro Tag)

Tagesdokument: `ts` (int, Epoch-Sekunden), `steps` (int), `v` (string), `receivedAt` (timestamp).
Sample: `ts`, `steps` (int), `receivedAt` (timestamp).

#### `dailyCheck` (18, vollständig)

`date` (string, immer). In 17/18: `status` (Werte `gruen`, `gelb`), `confidence`, `headline`, `reason`
(string, Freitext), `actions` (array<string>, Freitext), `flags` (map: `alcohol`, `illness` – bool),
`model` (string), `createdAtMs` (int), `planSuggestion` (map\|null; darin `originalUnitId`, `reason`,
`unit` = map wie eine Trainingsplan-Einheit). Optional: `suggestionStatus` (Werte `offen`, `verworfen`;
9), `incompleteOura` (bool; 12), `error`/`errorMessage`/`lastError` (map: `atMs`, `reason`,
`rawTextSnippet`; 1 Doc).

#### `dailyCheckCallLog` (7, vollständig)

`date` (string), `atMs` (int), `trigger` (Werte `status_set`, `status_changed`).

#### `trainingplans/{Montag}` (5, vollständig)

`datum`, `updatedAt` (string). `mo`, `di`, `mi`, `do`, `fr`, `sa`, `so`: jeweils array<map> mit
Einheiten. Einheit: `id`, `typ` (z. B. `zirkel`, `laufen`, `pullups`, `custom_*`), `typLabel`,
`variant`, `notiz` (string), `dauerMin`, `distanzKm`, `pauseSec` (int\|null), `sets` (string\|null);
bei `zirkel` zusätzlich `runden`, `prepSec`, `sideSwitchSec`, `uebungen` (wie `entries.uebungen`).

#### `intervalTemplates` (1)

`id`, `name`, `updatedAt` (string), `prepSec`, `roundPauseSec`, `rounds` (int), `steps` (array<map>:
`typ`, `typLabel`, `holdSec`, `pauseSec`).

#### `trainingTypes` (Top-Level, 11, vollständig)

`id`, `label`, `addedBy` (string), `kind` (optional, Wert `hold`, 3 Docs). `addedBy` ist ein Nutzerbezug.

#### `stravaAthletes` (1)

`userId` (string, verweist auf `{uid}`), `updatedAt` (timestamp).

### 1d. Schema-Drift

| Feld/Wechsel | Collection | Befund | Zeitpunkt (belegt) |
|---|---|---|---|
| `type` → `typ` | `entries` | 2 Alt-Docs mit `type` (`pull`/`push`) und `total_reps`/`pr` | 2026-04-15/16 |
| `date` fehlt | `entries` | **kein einziges `entries`-Doc hat `date`** (0/1250) | durchgehend |
| `datum` fehlt | `logEntries` | 1715 Docs nur mit `date`, ohne `datum` | 2024-04-17 – 2026-05 (ab 2026-06-01: 0 fehlend) |
| `_fromRecipe` | `logEntries` | 44 Docs | nur 2026-04-25 – 2026-04-30 |
| `recipeId` | `logEntries` | 421 Docs | ab 2026-05-12 |
| `unit` | `logEntries` | 8 Docs | ab 2026-11-03 |
| `pauseMin` → `pauseSec` | `entries` (`zirkel`) | 1 Doc mit `pauseMin` | Wechsel zwischen 2026-09-28 und 2026-09-30 |
| `uebungen`, `planUnitId` | `entries` | – | ab 2026-09-28 |
| `details` + `prepSec` | `entries` (`zirkel`) | – | ab 2026-10-11 |
| `sideSwitchSec` | `entries` (`zirkel`) | – | ab 2026-10-12 |
| `details[].exIdx` | `entries` (`zirkel`) | in allen Detailzeilen ab 2026-11-02, davor in keiner (alle 20 Zirkel-Docs geprüft) | ab 2026-11-02 |
| `variant`/`variantLabel` | `entries` | – | mit den Satz-Typen ab 2026-04 |
| `linkedGarmin` | – | nie gespeichert, entsteht in `getEffectiveTrainingEntries()` | – |
| `kategorie` vs. `source` | `foods` Top-Level vs. nutzereigen | unterschiedliche Felder, unterschiedliche Anzahl (2293 vs. 2263) | Import 2026-04-13/16 |
| `steps_*` | `weeklyStats` | 111 Docs | ab 2024-W14 |
| Fortschreibung endet | `weeklyStats` | letztes Doc 2026-W18; `updateWeeklyStats()` (`index.html:3450`) hat keine Aufrufstelle mehr | ab 2026-W19 |
| `sleepScore`/`readinessScore`/`tempDeviation` | `oura_daily` | fehlen am ersten Tag | ab 2026-10-03 |
| `ouraComplete` | `oura_daily` | 24/34 | ab 2026-10-03, nicht durchgehend |
| `suggestionStatus` | `dailyCheck` | 9/18 | ab 2026-10-18, nur bei Vorschlag |
| `incompleteOura` | `dailyCheck` | 12/18 | ab 2026-10-24 |

Altbestände ohne Code-Bezug (grep in `index.html` und `~/functions/*.js`): `users/{uid}/foods` (die App
liest nur Top-Level-`foods`, `index.html:2447`), `oura_step_log` (letzte Daten 2026-10-03),
`stravaAthletes` (es gibt keine deployte Strava-Function, s. 4). `integrations/strava` enthält
trotzdem noch Token-Felder.

### 1e. `typ == 'phonesteps'`

Count: **67**. Ältestes `datum` 2026-05-20, neuestes 2026-09-30. Alle mit `source_steps =
samsung_sensor` und `updatedAt`.

---

## 2. Sensible Bereiche

Methode für `settings/`, `integrations/` und `oura_tokens/`: Kein Dokument wurde gelesen. Feldnamen
sind nur per Existenz-Query (`IS_NOT_NULL` / `IS_NULL`, Projektion nur auf `__name__`) gegen 104
Kandidatennamen aus dem Code geprüft. Typen stammen aus typ-spezifischen Bereichs-Queries
(`>= ""`, `>= Zahl`, …), ebenfalls nur mit Projektion auf `__name__`. Es wurden keine Werte
übertragen.
**Grenze:** Felder, die im Code nicht vorkommen, sind so nicht auffindbar.

| Dokument | Felder (Typ) | Secret-Felder |
|---|---|---|
| `settings/main` | `activityLevel`, `age`, `assumedDailySteps`, `carbsGoal`, `detailDays`, `fatGoal`, `height`, `proteinGoal`, `tdee`, `weight` (number), `gender`, `recipeDisplay` (string), `anthropicApiKey` (string) | **`anthropicApiKey`** |
| `settings/favorites` | `ids` (array) | – |
| `settings/backup` | `lastDriveBackup`, `lastDriveFileId`, `lastDriveFileName`, `lastDriveBackupAttempt` (ISO-Zeitstempel, seit 04.11.2026), `lastDriveBackupError` (Kurztext oder null, seit 04.11.2026) (string) | – (Drive-Referenzen; Auto-Backup nur wenn letzter Versuch > 24 h) |
| `settings/exercises` | 11 Übungsschlüssel (`pullups`, `pushups`, `lunges`, `terraband_knie`, `custom_*`) je map | – |
| `settings/subjectiveStatus` | `history` (array) | – (Gesundheit/Befinden) |
| `integrations/googlefit` | `accessToken`, `refreshToken` (string), `expiresAt`, `lastSyncActivities`, `lastSyncSteps` (number), `connectedAt`, `lastSyncAt` (timestamp) | **`accessToken`, `refreshToken`** |
| `integrations/googledrive` | `accessToken`, `refreshToken` (string), `expiresAt` (number), `connectedAt` (timestamp) | **`accessToken`, `refreshToken`** |
| `integrations/strava` | `accessToken`, `refreshToken`, `athleteName` (string), `athleteId`, `expiresAt`, `lastSyncAt`, `lastSyncCount` (number), `connectedAt` (timestamp) | **`accessToken`, `refreshToken`** |
| `integrations/oura` | `connected` (bool), `lastSyncDays` (number), `connectedAt`, `lastSyncAt`, `lastStepSyncAt` (timestamp), `lastSyncError` (null) | – |
| `integrations/garminHealth` | `ok` (bool), `checkedAt` (timestamp), `reason`, `staleSince` (null) | – |
| `integrations/garminParity` | `days` (array), `computedAt` (timestamp) | – |
| `integrations/garminStatus` | `lastDate`, `lastGarminSync` (string), `lastSteps` (number), `lastIngestAt` (timestamp) | – |
| `oura_tokens/{uid}` (Top-Level) | `accessToken`, `refreshToken` (string), `expiresAt` (number), `connectedAt` (timestamp) | **`accessToken`, `refreshToken`** |

Hinweis: Die Existenz-Queries liefen über die automatischen Einzelfeld-Indizes. Diese Secret-Felder
sind also wie jedes Feld indiziert. Es gibt keine Index-Ausnahmen für sie.

**Einordnung aller Collections**

| Kategorie | Collections/Felder |
|---|---|
| Secrets | `settings/main.anthropicApiKey`, `integrations/{googlefit,googledrive,strava}` (Token-Felder), `oura_tokens`, `oura_oauth_state` |
| Gesundheit | `entries.weight` (`tageslog`), `entries.hf`, `garminActivities.avgHr/maxHr`, `oura_daily` (Schlaf, HRV, Ruhepuls, Temperatur), `settings/subjectiveStatus`, `dailyCheck` (inkl. `flags.alcohol/illness`), `settings/main` (Alter, Größe, Gewicht, Geschlecht) |
| Ernährung | `logEntries`, `foods` (beide), `recipes`, `settings/favorites` |
| Bewegung | `entries`, `garminActivities`, `garminDaily`, `ciqSteps` (+`samples`), `oura_workouts`, `oura_step_log`, `trainingplans`, `garminLinks`, `garminHidden` |
| Aggregat | `weeklyStats` |
| Konfiguration | `settings/{main ohne Secret, backup, exercises}`, `integrations/{oura, garminHealth, garminParity, garminStatus}` und Nicht-Token-Felder der übrigen, `trainingTypes`, `intervalTemplates`, `dailyCheckCallLog`, `stravaAthletes` |

---

## 3. Beziehungen

**Gespeicherte Referenzen**

- `logEntries.foodId` → `foods.id` (Top-Level). Bei Rezept-Einträgen zusätzlich `logEntries.recipeId` →
  `recipes.id`.
- `recipes.ingredients[].foodId` → `foods.id`. Die Nährwerte sind je Zutat kopiert, also keine reine
  Referenz.
- `logEntries.kcal/protein/carbs/fat` sind beim Speichern berechnet und gespeichert, nicht aus `foods`
  nachgeladen.
- `entries.planUnitId` → `trainingplans/{Montag}.{mo…so}[].id` (Plan-Einheit abgehakt bzw. aus Plan
  gestartet).
- `dailyCheck.planSuggestion.originalUnitId` → `trainingplans…[].id`.
- `entries.uebungen[].typ` / `details[].typ` → Übungsschlüssel in `settings/exercises` bzw.
  `trainingTypes` (`custom_*`). `details[].exIdx` → Index in `uebungen` desselben Docs.
- `garminLinks/{activityId}` = `{unlinked, at}`: speichert nur die **gelöste** Zirkel-Zuordnung
  (`index.html:8124`).
- `garminHidden/{activityId}` = `{hiddenAt}`: ausgeblendete Garmin-Aktivität (`index.html:8090`).
- `stravaAthletes/{id}.userId` → `{uid}`. `oura_tokens/{uid}` ↔ `users/{uid}`.
- Tagesschlüssel `YYYY-MM-DD` verbinden `garminDaily`, `ciqSteps`, `oura_daily`, `dailyCheck` mit
  `entries.datum`/`logEntries.date`. `garminActivities.startLocal` ordnet über das Datum zu.

**Live berechnet in `index.html` (nicht gespeichert)**

| Wert | Funktion (Zeile) | Quellen |
|---|---|---|
| Zirkel ↔ Garmin-Aktivität | `computeZirkelGarminLinksForDate()` (2663), `getEffectiveTrainingEntries()` (2727) setzt `linkedGarmin` | `entries` (`zirkel`) + `garminActivities` − `garminLinks` − `garminHidden` |
| Schritt-Quelle je Tag | `getStepsSourceForDate()` (2831) | vor `garminActivityCutoff` → `googlefit`, sonst `garmin`, falls `max(garminDaily, ciqSteps) > 0` |
| Tagesschritte roh | `getRawStepsForDate()` (2842) | Quelle `garmin`: `max(garminDaily.steps, ciqStepsForDate())`. **`ciqStepsForDate()` (2799) liefert nur für heute einen Wert**, für vergangene Tage also nur `garminDaily`. Quelle `googlefit`: `entries.tageslog.steps` |
| Aktivitätsschritte (Abzug) | `getActivityStepsForDate()` (3363) | je nach Quelle Garmin-Aktivitäten oder `entries.schritte` |
| BMR | `mifflinStJeorBmr()` (3292), `calcBmrForDate()` (3301) | `settings/main`, Gewicht aus `entries.tageslog.weight` |
| Kalorienziel `{base, activity, daily, total}` | `calcHistoricalKcalGoal()` (3400) | BMR, Aktivitätskalorien, Schrittkalorien |
| Aktivitätskalorien je Eintrag | `calcActivityKcal()` (5268), `calcPlanActivityKcal()` (5374) | `entries` + verknüpfte `garminActivities` |
| Zirkel-kcal inkl. Puls-Mischung | `zirkelPulseBreakdown()` (5225), `calcZirkelEntryKcal()` (5410) | `entries.uebungen`/`details`, `linkedGarmin` (`avgHr`, `garminKcal`) |
| Garmin-Netto für unverknüpfte Kraft-Einheit (004b, 07.11.2026) | `strengthGarminNettoBreakdown()` (5247) | `garminKcal` (brutto) minus BMR-Anteil der Dauer; fehlt `garminKcal`/BMR → Fallback MET 5,0 (unverändert) |
| "Abgedeckt" durch Plan-Einzelübung (004b, 07.11.2026) | `isPlanSingleExerciseDoneOnDate()` (5264), gesetzt in `getEffectiveTrainingEntries()` (`entry.covered`) | Gibt es am Tag einen `entries`-Eintrag `source:'plan'` + `planUnitId` + `typ≠zirkel`, zählt jede unverknüpfte Garmin-Kraft-Einheit dieses Tages 0 kcal (bleibt in der Liste, `covered:true`, keine eigene Zeile in der Trainingsliste) |
| Einheit alter Rezept-Einträge | `recipeEntryAmountUnit()` (6754) | `logEntries` ohne `unit` |
| Garmin-Warnbanner | `garminStaleBannerInfo()` (2869) | `integrations/garminHealth`, `garminDaily` |

Teilweise gespeichert: `entries.act_kcal_calc` (Kalorienwert zum Speicherzeitpunkt; die App rechnet
live neu) und `weeklyStats` (Wochen-Snapshot, seit 2026-W18 nicht fortgeschrieben).

---

## 4. Cloud Functions (`gcloud functions list`, 18 Functions)

| Function | Gen | Runtime | Region | Letztes Update | Typ | Quelle in `~/functions` |
|---|---|---|---|---|---|---|
| `createCustomToken` | 2 | nodejs22 | us-central1 | 2026-10-04 | callable | **nein** |
| `garminHealthCheck` | 2 | nodejs22 | us-central1 | 2026-10-30 | Schedule stündlich | ja |
| `googleDriveCallback` | 2 | nodejs22 | us-central1 | 2026-10-31 | HTTP | ja |
| `googleDriveRefresh` | 2 | nodejs22 | us-central1 | 2026-10-31 | callable | ja |
| `googleFitCallback` | 2 | nodejs22 | us-central1 | 2026-10-31 | HTTP | ja |
| `googleFitDailySync` | 2 | nodejs22 | us-central1 | 2026-10-31 | Schedule stündlich | ja |
| `googleFitDisconnect` | 2 | nodejs22 | us-central1 | 2026-10-23 | callable | ja |
| `googleFitSync` | 2 | nodejs22 | us-central1 | 2026-10-31 | callable | ja |
| `ingestCiqSteps` | 2 | nodejs22 | us-central1 | 2026-11-01 | HTTP | ja |
| `ingestGarmin` | 2 | nodejs22 | us-central1 | 2026-10-30 | HTTP | ja |
| `ouraAuthStart` | 2 | nodejs22 | **europe-west1** | 2026-10-23 | HTTP | ja |
| `ouraCallback` | **1** | nodejs22 | **europe-west1** | 2026-10-23 | HTTP (v1) | ja |
| `ouraDisconnect` | 2 | nodejs22 | **europe-west1** | 2026-10-23 | callable | ja |
| `syncOura` | 2 | nodejs22 | **europe-west1** | 2026-10-23 | Schedule alle 3 h | ja |
| `syncOuraManual` | 2 | nodejs22 | **europe-west1** | 2026-10-23 | callable | ja |
| `syncOuraMorning` | 2 | nodejs22 | **europe-west1** | 2026-10-23 | Schedule 05–10 Uhr halbstündlich | ja |
| `dartCoach` | 2 | nodejs22 | europe-west1 | 2026-10-23 | HTTP | ja (`dartCoach.js`) |
| `dartTTS` | 2 | nodejs22 | europe-west1 | 2026-06-17 | HTTP | **nein** |

Die Zeitpläne stammen aus `gcloud scheduler jobs list`, Zeitzone Europe/Berlin. CLAUDE.md nennt
us-central1 als Region; die Oura- und Dart-Functions liegen tatsächlich in europe-west1. Es gibt keine
Strava-Function.

**`createCustomToken` – Deploy-Quelle** (`gcloud functions describe … --region=us-central1`):
- `buildConfig.source.storageSource`: Bucket `gcf-v2-sources-187864668697-us-central1`, Objekt
  `createCustomToken/function-source.zip`, Generation `1791127777085431`.
  `sourceProvenance.resolvedStorageSource` ist identisch.
- Labels: `deployment-tool: cli-firebase`, `deployment-callable: true`. Deployt also per Firebase-CLI
  aus einem Quellstand, der nicht in `~/functions` liegt.
- Herunterladbar: **ja, technisch**. `gcloud storage objects describe` auf das Objekt funktioniert mit
  dem aktuellen Konto (58335 Bytes, application/zip, Stand 2026-10-04). Dafür ist dieselbe Berechtigung
  `storage.objects.get` nötig wie für den Download. **Nicht heruntergeladen.**
- Bucket-Lifecycle: nicht-aktuelle Versionen werden gelöscht, sobald 3 neuere existieren. Die aktuelle
  Version bleibt bis zum nächsten Deploy von `createCustomToken` erhalten.

---

## 5. Lesekosten

**Diese Bestandsaufnahme** (eigene Zählung je Call):

| Art | Anzahl | Abrechnung |
|---|---|---|
| Dokumente aus Queries (inkl. min. 1 Read je leerer Query) | ca. 3.400 | 1 Read je Doc |
| Aggregations-Counts | ca. 145 Queries über zusammen ca. 660.000 Indexeinträge | 1 Read je angefangene 1.000 Einträge → ca. 800 |
| `listCollectionIds` | ca. 250 | ca. 1 Read je Call |
| **Summe** | **ca. 4.500 Reads** | |

Gemessen per Cloud Monitoring (`firestore.googleapis.com/document/read_ops_count`, Summe
14:29–14:43 UTC, also der gesamte Lauf): **2.726 Reads**. Die eigene Zählung liegt mit ca. 4.500
darüber. Sie ist bewusst als Obergrenze gerechnet: Leere Queries sind mit je 1 Read angesetzt, und
Aggregationen sowie `listCollectionIds` tauchen in dieser Metrik vermutlich nicht vollständig auf.
Für die Abrechnung gilt der Billing-Report.

Beobachtung ohne Ursachenbeleg: Vor diesem Lauf, um 14:07–14:16 UTC, zeigt dieselbe Metrik ca. 151.000
QUERY-Reads in vier Minuten (57.707 / 56.471 / 6.225 / 31.355). Der letzte Wert entspricht etwa einem
vollständigen Lesen von `logEntries`. Diese Reads stammen nicht aus dieser Bestandsaufnahme; erster
Call hier war 14:30 UTC.

**Vollständiger Erst-Export** (alle Docs außer `dart_*`): **ca. 38.400 Reads**, davon `logEntries`
31.347. Ohne den Altbestand `users/{uid}/foods` sind es ca. 36.200.

**Täglicher inkrementeller Sync**, Basis Oktober 2026 (`logEntries` 787 Docs seit 2026-10-01, also ca.
23/Tag; `entries` ca. 3/Tag; `ciqSteps/samples` ca. 270/Tag):
- Nur neue Tage abfragen (`datum >= gestern`): ca. 30–40 Reads + je 1 Tagesdokument in `garminDaily`,
  `ciqSteps`, `oura_daily`, `dailyCheck` + `garminActivities`/`oura_workouts` des Tages → **ca. 50
  Reads/Tag**, mit Roh-Samples ca. 320.
- Robuster mit einem Fenster der letzten 7 Tage, weil `logEntries` kein Änderungszeitstempel hat und
  Einträge nachträglich bearbeitet werden: ca. 7 × 35 → **ca. 250 Reads/Tag** (ohne Samples).
- Löschungen erkennt ein Datumsfenster nicht. Dafür einmal pro Woche ein ID-Abgleich per Projektion
  auf `__name__` über das Fenster, zusätzlich ca. 30 Reads × Fenstertage.

Alle Werte liegen deutlich unter dem Gratiskontingent von 50.000 Reads/Tag.

---

## 6. Ergebnisdatei

Diese Datei (`docs/datenmodell.md`).

---

## 7. Vorschläge (NICHT umgesetzt)

### 7a. Relationales Schema (Postgres)

```sql
-- Stammdaten
foods(food_id TEXT PK, name TEXT, kategorie TEXT, kcal_100 NUMERIC, protein_100 NUMERIC,
      carbs_100 NUMERIC, fat_100 NUMERIC, source TEXT)
recipes(recipe_id TEXT PK, name TEXT, portions INT, total_weight_g INT,
        kcal NUMERIC, protein NUMERIC, carbs NUMERIC, fat NUMERIC)
recipe_ingredients(recipe_id TEXT FK, pos INT, food_id TEXT NULL, name TEXT, amount_g NUMERIC,
        kcal NUMERIC, protein NUMERIC, carbs NUMERIC, fat NUMERIC, PRIMARY KEY (recipe_id, pos))
exercise_types(type_key TEXT PK, label TEXT, kind TEXT, met_class TEXT)   -- trainingTypes + settings/exercises

-- Ernährung
diary_entries(entry_id TEXT PK, day DATE NOT NULL, time TIME, meal TEXT,
        food_id TEXT NULL, recipe_id TEXT NULL, name TEXT, amount NUMERIC, unit TEXT NULL,
        kcal NUMERIC, protein NUMERIC, carbs NUMERIC, fat NUMERIC, from_recipe BOOL)
  INDEX (day), INDEX (food_id), INDEX (recipe_id)
  -- day = COALESCE(datum, date) (1715 Docs haben nur date)

-- Training
training_entries(entry_id TEXT PK, day DATE NOT NULL, typ TEXT NOT NULL, source TEXT,
        distance_km NUMERIC, duration_sec INT, hr_avg INT, steps INT, kcal_device INT,
        kcal_calc_saved INT,            -- entries.act_kcal_calc (Wert zum Speicherzeitpunkt)
        variant TEXT, sets JSONB, plan_unit_id TEXT,
        rounds INT, pause_sec INT, prep_sec INT, side_switch_sec INT,
        notiz TEXT NULL,                -- s. 7c
        raw JSONB)                      -- unmodellierte Felder / Drift
  INDEX (day, typ), INDEX (plan_unit_id)
training_exercises(entry_id FK, ex_idx INT, typ TEXT, variant TEXT, mode TEXT, wdh INT,
        hold_sec INT, pause_sec INT, per_side BOOL, met_class TEXT, PRIMARY KEY (entry_id, ex_idx))
training_details(entry_id FK, round INT, ex_idx INT NULL, typ TEXT, mode TEXT, wdh INT, sec INT)
  INDEX (entry_id)

-- Gerätedaten
garmin_activities(activity_id BIGINT PK, start_local TIMESTAMPTZ, day DATE, garmin_type TEXT,
        mapped_typ TEXT, duration_sec NUMERIC, distance_m NUMERIC, avg_hr INT, max_hr INT,
        garmin_kcal INT, steps INT, hidden BOOL, unlinked BOOL)
  INDEX (day)
daily_steps_raw(day DATE, source TEXT, steps INT, fetched_at TIMESTAMPTZ, PRIMARY KEY (day, source))
        -- source: garmin_daily | ciq | googlefit_tageslog | phonesteps | oura
oura_daily(day DATE PK, steps INT, active_kcal INT, total_kcal INT, activity_score INT,
        sleep_sec INT, deep_sleep_sec INT, hrv_avg INT, resting_hr INT, sleep_score INT,
        readiness_score INT, temp_deviation NUMERIC, complete BOOL)
oura_workouts(workout_id UUID PK, day DATE, activity TEXT, intensity TEXT, kcal NUMERIC,
        start_ts TIMESTAMPTZ, end_ts TIMESTAMPTZ)
  INDEX (day)
body_weight(day DATE PK, weight_kg NUMERIC)        -- aus entries.tageslog.weight

-- Plan / Coaching (strukturierte Teile)
plan_units(plan_week DATE, weekday SMALLINT, unit_id TEXT, typ TEXT, dauer_min INT,
        distanz_km NUMERIC, PRIMARY KEY (plan_week, unit_id))
daily_check(day DATE PK, status TEXT, confidence TEXT, flag_alcohol BOOL, flag_illness BOOL,
        suggestion_status TEXT, model TEXT, created_at TIMESTAMPTZ)

-- Abgeleitet
daily_summary(day DATE PK, steps_total INT, steps_source TEXT, steps_activity INT,
        bmr NUMERIC, kcal_goal_base NUMERIC, kcal_goal_activity NUMERIC, kcal_goal_daily NUMERIC,
        kcal_goal_total NUMERIC, kcal_in NUMERIC, protein NUMERIC, carbs NUMERIC, fat NUMERIC,
        act_kcal NUMERIC, weight_kg NUMERIC, calc_version TEXT, computed_at TIMESTAMPTZ)
zirkel_kcal(entry_id PK, activity_id BIGINT NULL, kcal_formula NUMERIC, kcal_pulse NUMERIC,
        kcal_final NUMERIC, calc_version TEXT)
```

Wichtigste Indizes: `day` auf allen Zeitreihen-Tabellen (jede Auswertung filtert zuerst nach
Zeitraum), `(day, typ)` auf `training_entries`, Fremdschlüssel `food_id`/`recipe_id`/`plan_unit_id`.
`weekly_stats` lässt sich als View über `daily_summary` bilden. Der Firestore-Altbestand bis 2026-W18
kann als Import-Tabelle `weekly_stats_legacy` daneben stehen, weil er bis 2018 zurückreicht.

**Live berechnete Werte: Empfehlung Snapshot-Tabelle, befüllt mit der App-Logik selbst.**
Begründung:
- Die Formeln (BMR, Kalorienziel, Zirkel-/Puls-Mischung, Schrittquelle) liegen nur in `index.html`.
  Eine Neuimplementierung in SQL oder im Sync-Code wäre eine zweite Formelquelle, die auseinanderlaufen
  kann.
- Deshalb `daily_summary`/`zirkel_kcal` im Sync mit genau den App-Funktionen berechnen (z. B. die
  Funktionen headless in Node laden) und mit `calc_version` (= `APP_BUILD`) speichern. Bei
  Formeländerungen lassen sich so betroffene Tage gezielt neu rechnen und alte Stände vergleichen.
- Rohdaten bleiben daneben vollständig in den Basistabellen. Der Snapshot ist also jederzeit
  reproduzierbar.

### 7b. Sync-Varianten

**(i) VPS holt Daten über eine Export-Cloud-Function mit Secret** (kein Service Account auf dem VPS)
- Pro: Auf dem VPS liegt nur ein widerrufbares Secret, kein GCP-Credential. Das passt zum bestehenden
  Muster (`ingestGarmin`/`ingestCiqSteps` mit Secret, umgekehrte Richtung).
- Pro: Die Function filtert serverseitig. Secrets, Konfiguration und Freitext verlassen Firestore gar
  nicht erst (Allowlist der Felder).
- Pro: Pull-Modell. Der VPS bestimmt Zeitpunkt und Wiederholung. Ist die DB oder der VPS down, geht
  nichts verloren; der nächste Lauf holt nach.
- Contra: eine weitere Function (Name/Signatur stabil halten). Paginierung und Fenster-Logik sind
  selbst zu bauen.
- Contra: Ein geleaktes Secret ermöglicht das Lesen aller exportierten Gesundheitsdaten. Gegenmaßnahmen:
  Rate-Limit, IP-Bindung, Rotation.
- Contra: Läuft auf dem VPS mit dem LIVE-Trading-Bot. Der Sync-Job muss zeitlich und ressourcenseitig
  entkoppelt sein (Zeitfenster aus CLAUDE.md beachten).

**(ii) Cloud Function schreibt aktiv in die DB** (Firestore-Trigger oder Schedule → Postgres)
- Pro: nahezu Echtzeit, Änderungen und Löschungen kommen über `onWrite`/`onDelete` sauber mit. Das
  Problem „kein Änderungszeitstempel“ in `logEntries` entfällt.
- Contra: Postgres muss aus GCP erreichbar sein, also offener DB-Port auf dem VPS oder ein zusätzlicher
  Endpunkt/Tunnel. Größere Angriffsfläche als (i). DB-Credentials liegen in GCP.
- Contra: Retry/Dead-Letter bei DB-Ausfall selbst bauen. Ohne Ausschluss erzeugt `ciqSteps/samples`
  ca. 270 Function-Aufrufe pro Tag.
- Contra: Die App-Formeln aus 7a laufen nicht ohne Weiteres in einer Function. Snapshots entstehen
  dann eher separat.

**(iii) Keine eigene DB, MCP liest Firestore direkt**
- Pro: keine Sync-Logik, keine Doppelhaltung, immer aktuell, keine neue Infrastruktur.
- Contra: keine Joins/Aggregationen über Collections. Jede Zeitreihenfrage über 2 Jahre `logEntries`
  kostet ca. 20.000–30.000 Reads. Das Gratiskontingent wäre bei wenigen Anfragen pro Tag erreicht.
- Contra: Der MCP-Server braucht Firestore-Credentials. Ohne eigene Filterschicht hat er damit
  Zugriff auf `settings/main` und `integrations/*`, also auf Secrets.
- Contra: Live berechnete Werte (Abschnitt 3) müsste der MCP-Server selbst nachbauen. Das ist wieder
  eine zweite Formelquelle.

Einschätzung: (i) passt am besten zu den bestehenden Sicherheitsregeln (kein Service Account außerhalb
GCP, Secret-Muster schon etabliert) und zum Datenvolumen (ca. 250 Reads/Tag). (ii) lohnt sich erst,
wenn Echtzeit gebraucht wird. (iii) eignet sich nur für kleine Ad-hoc-Abfragen.

### 7c. Was NICHT in die Analyse-DB gehört

- Alle Secret-Felder aus Abschnitt 2: `anthropicApiKey`, alle `accessToken`/`refreshToken`/`expiresAt`,
  `oura_tokens`, `oura_oauth_state`.
- Reine Konfiguration und Betriebsdaten ohne Analysewert: `settings/backup`, `settings/favorites`,
  `integrations/*` (auch die Statusdokumente), `dailyCheckCallLog`, `stravaAthletes`, `garminParity`.
- Altbestände ohne Code-Bezug: `users/{uid}/foods`, `oura_step_log`. Höchstens einmalig archivieren.
- Freitext mit möglichem Gesundheitsbezug nur nach ausdrücklicher Entscheidung:
  `settings/subjectiveStatus.history`, `dailyCheck.headline/reason/actions/planSuggestion.reason`,
  `dailyCheck.lastError.rawTextSnippet`, `entries.notiz`, `trainingplans…notiz`. Für einen MCP-Server,
  den ein LLM ausliest, sind strukturierte Felder (`status`, `flags`, Scores) ausreichend.
- `ciqSteps/{date}/samples` als Rohdaten: als Tageswert reicht `ciqSteps/{date}`.
- Personenbezogene Stammdaten aus `settings/main` (Alter, Größe, Geschlecht) nur, soweit die
  Snapshot-Berechnung sie braucht. Dann nur im Sync verwenden, nicht als Tabelle ablegen.
- Die uid selbst: in der Analyse-DB ist sie überflüssig (Single-User).

---

## 8. Analytics-DB (Phase 1a, umgesetzt 2026-11-05; Phase 1b/dailySnapshots, umgesetzt 2026-11-06)

Umsetzung von Vorschlag 7b(i): Cloud Function `exportAnalytics` (us-central1, Repo
`fuelofit-functions`) exportiert eine serverseitige Whitelist an Collections per GET,
Secret-Auth (`X-Analytics-Secret` gegen `ANALYTICS_EXPORT_SECRET`), feste uid aus
`GARMIN_TARGET_UID` (nicht aus dem Request). Secret-Felder (Name enthaelt token/secret/apikey/
password/refresh, case-insensitive) werden zusaetzlich rekursiv aus jeder Antwort entfernt,
unabhaengig von der Whitelist. `sync.py` auf dem VPS (User `fuelofit-analytics`, kein Service
Account, kein Firestore-Zugriff direkt) holt darueber taeglich ein 14-Tage-Fenster und
sonntags den Vollbestand nach Postgres `fuelofit_analytics` (Schema `raw` = 1:1-Kopie je
Collection als JSONB, Schema `views` = 5 typisierte Sichten). Details, Rollen, Sync-Zeiten und
Wiederaufbau: `analytics/README.md`.

**Whitelist** (Cloud Function `~/functions/index.js`, Konstante `ANALYTICS_WHITELIST`):

| Collection | Scope | Datumsfeld (window) | mode=full |
|---|---|---|---|
| `logEntries` | `users/{uid}/` | `datum` (Fallback `date`) | ja |
| `entries` | `users/{uid}/` | `datum` | ja |
| `oura_daily` | `users/{uid}/` | `date` | ja |
| `oura_workouts` | `users/{uid}/` | `day` | ja |
| `garminActivities` | `users/{uid}/` | `startLocal` (Datumsteil) | ja |
| `garminDaily` | `users/{uid}/` | Dokument-ID (kein eigenes Feld) | ja |
| `ciqSteps` | `users/{uid}/` | Dokument-ID (kein eigenes Feld); **ohne** `samples` | ja |
| `dailyCheck` | `users/{uid}/` | `date` | ja |
| `dailyCheckCallLog` | `users/{uid}/` | `date` | ja |
| `trainingplans` | `users/{uid}/` | `datum` | ja |
| `dailySnapshots` | `users/{uid}/` | `date` | ja |
| `trainingTypes` | Top-Level | – (kein Datumsfeld) | nur full |
| `intervalTemplates` | `users/{uid}/` | – | nur full |
| `garminLinks` | `users/{uid}/` | – | nur full |
| `garminHidden` | `users/{uid}/` | – | nur full |
| `foods` | Top-Level | – | nur full |
| `recipes` | `users/{uid}/` | – | nur full |
| `weeklyStats` | `users/{uid}/` | – | nur full |

Hart ausgeschlossen (nicht in der Whitelist, Function liefert 400): `settings`, `integrations`,
`oura_tokens`, `oura_oauth_state`, `ciqSteps/*/samples`, alle `dart_*`-Collections,
`users/{uid}/foods`, `oura_step_log`, `stravaAthletes`.

**`dailySnapshots` (Phase 1b, 2026-11-06)**: `users/{uid}/dailySnapshots/{YYYY-MM-DD}`, von der
App selbst mit ihrer eigenen Berechnungslogik geschrieben (`buildDailySnapshotPayload` in
`index.html`) – ersetzt NICHT die Formeln in der Analyse-DB, liefert nur deren Ergebnis:
`date`, `appBuild`, `computedAt` (Server-Timestamp), `final`, `backfilled`,
`kcalGoal: {base, activity, daily, total}` (aus `calcHistoricalKcalGoal`),
`steps: {raw, activitySteps, display, source}`, `activities: [{id, typ, dauerMin,
kcalGezaehlt, formel?, garminNetto?, covered?}]` (je Trainingseintrag; `formel`/`garminNetto` nur bei
verknüpftem Zirkel, siehe `zirkelPulseBreakdown`; `covered:true` ab 004b/07.11.2026 bei einer durch
eine Plan-Einzelübung abgedeckten unverknüpften Garmin-Kraft-Einheit, `kcalGezaehlt` dann 0), `intake: {kcal, protein, carbs, fat}`
(aus `getDayIntakeTotals`). Ausloeser: nach vollständigem Laden, periodisch alle 30 Min
solange sichtbar, nach Speichern/Löschen eines Eintrags für heute (gedrosselt 1×/Min);
beim Tageswechsel wird der Vortag einmalig mit `final=true` nachgezogen. Postgres-Sicht
`views.daily_summary` (siehe `analytics/schema.sql`) macht daraus eine typisierte
Tageszusammenfassung inkl. Bilanz (Intake − Kalorienziel) und Gewicht des Tages
(`views.body_weight`-Join).

**Datenlücken-Ergänzung (004c, 07.11.2026)**: `views.training_sessions` um Garmin-Distanz/-Dauer,
Pace (`pace_min_km`, nur Lauf-/Gehtypen), Geschwindigkeit (`speed_kmh`) sowie Trittfrequenz,
Training Effect, Höhenmeter und Geräte-Geschwindigkeit erweitert (`analytics/migrations/002_*.sql`,
`004_*.sql`); `views.sleep_recovery` um REM-/Leicht-/Wachzeit, Schlafeffizienz, Atemfrequenz,
Einschlaflatenz, Bettzeiten erweitert (`003_*.sql`). Siehe die neuen Firestore-Felder oben bei
`oura_daily`/`garminActivities`.

**Firestore-Backup-Schedule**: taeglich, 14 Wochen Aufbewahrung, angelegt 2026-11-05
(`gcloud firestore backups schedules create --database='(default)' --recurrence=daily
--retention=14w`). Sicherheitsnetz fuer Firestore selbst, unabhaengig von der Analyse-DB (die
hat kein eigenes Backup, ist aus Firestore ableitbar, s. `analytics/README.md`).

---

## Prüfprotokoll

Vor dem Commit per grep geprüft: kein Treffer für die reale uid (nur `{uid}`), keine E-Mail-Adressen,
keine Token- oder Key-Muster (`sk-ant-`, `AIza`, `ya29.`, `-----BEGIN`). Werte aus `settings/`,
`integrations/` und `oura_tokens` wurden nie übertragen. Andere Collections wurden zwar gelesen, die
Ausgabe enthielt aber nur Feldnamen, Typen und Kategorie-Werte.

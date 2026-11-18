# Tests (fitness-tracker)

Playwright-Tests gegen die echte `index.html`. Nur synthetische Daten - keine uid, keine
E-Mail-Adresse, keine echten Werte/Gewichte von Daniel. Öffentliches Repo.

Harness (`stubs/harness.js` + `stubs/firebase-stub.mjs`): Firebase Auth und Firestore werden
über `page.route` an den vier gstatic-Imports durch einen In-Memory-Stub ersetzt (synthetische
Daten per `window.__TEST_STORE__`, seedbar vor der Navigation). Schreibzugriffe (`setDoc`/
`deleteDoc`) werden geblockt und nach `window.__TEST_WRITES__` protokolliert, nie wirklich
ausgeführt. KI-Aufrufe (`httpsCallable`, z. B. `anthropicProxy`) werden ebenso abgefangen statt
wirklich verschickt - Standard: wirft (wie bisher); mit vorher gesetztem
`window.__TEST_AI_RESPONSE__` wird der Aufruf stattdessen protokolliert (`window.__TEST_AI_CALLS__`)
und eine synthetische Antwort zurückgegeben (siehe `run-017-alkohol.js`). Uhr fest über
`page.clock.install(...)`, Viewport 360px, Zeitzone Europe/Berlin.

Bekannte, vorbestehende Konsolenfehler werden an GENAU EINER Stelle gefiltert:
`stubs/known-errors.js` (aktuell: `updateHiddenSets is not defined`, siehe Kommentar dort). Jede
Harness-Variante (auch die Minimal-Harnesses in `run-016-start-parallel.js`/
`run-016f-analyse-entfernen.js`) ruft diese eine Funktion auf.

## Einrichtung

    df -h ~          # Home-Disk ist knapp (siehe CLAUDE.md), vor npm install pruefen
    npm install       # nur playwright (Chromium wird wiederverwendet, falls bereits im Cache)
    npx playwright install chromium   # nur falls Chromium noch nicht im Cache liegt

## Ausführen

    npm test          # alle Tests nacheinander (run-all.js), ca. 35-40s, druckt eine
                       # Zusammenfassung (Anzahl gruen/rot) am Ende

Ein einzelner Test laeuft auch direkt: `node run-017-smoke.js`.

## Enthaltene Tests

Reihenfolge wie in `run-all.js`/`package.json`:

- `run-012d.js --after` (Aufgabe 012d, Platzhalter "Angenommene Alltagsschritte" entfernt): drei
  Kalorienziel-Szenarien (heute ohne Schritte / heute mit echten Schritten / gestern nur
  Oura-Schritte) plus Einstellungen öffnen/speichern ohne Konsolenfehler, kein Schreiben von
  `assumedDailySteps` mehr. Erwartete Werte und Herleitung siehe Bericht 012d in fuelofit-ops.

- `run-015-datum-zeitzone.js --after` (Aufgabe 015, UTC-Fehler im 365-Tage-Cutoff von
  `loadAllData`): vier Uhrzeit-/Zeitzonen-Szenarien (00:30 / 23:30 / Zeitumstellungswoche /
  Montag 00:30, Europe/Berlin, `page.clock` + `timezoneId`), prüft ob ein synthetischer
  logEntries-Eintrag genau 366 Tage vor "heute" fälschlich mitgeladen wird (`toISOString()` statt
  lokalem Datum - seit dem Fix (`--after`) in keinem Szenario mehr der Fall). Vorher/Nachher-Werte
  und Herleitung siehe Bericht 015 in fuelofit-ops.

- `run-016-start-parallel.js` (Aufgabe 016 Teil A / Nachprüfung 016b Teil A, `loadAllData()` per
  `Promise.all` parallelisiert statt sequenziell): vergleicht einen festen "vorher"-Stand
  (Konstante `BEFORE_SHA`, Default `a40d9dd` - letzter Commit vor der Parallelisierung, per
  `git show <SHA>:index.html`, NICHT `HEAD`) gegen die Arbeitskopie ("nachher"). Bricht vorher mit
  Exit-Code 2 ab, falls beide Stände in `loadAllData` dieselbe Anzahl `Promise.all`-Aufrufe haben
  (kein Beleg für einen Unterschied). Künstliche Latenz 150ms/Abfrage, je 3 Wiederholungen pro
  Stand, Median von Laufzeit und `__TEST_MAX_INFLIGHT__`. Vergleicht den Endzustand (u. a. Summen
  kcal/Protein des heutigen Tags über `getDayIntakeTotals`, Zieldetails über
  `calcHistoricalKcalGoal`, Anzahl geladener logEntries/entries/garminActivities) - bei Abweichung
  kein automatischer Rückbau, Skript wartet (Exit-Code 3) auf Entscheidung, `run-all.js` meldet das
  als Sonderstatus, nicht als rot. Kein `page.clock` (echte Latenz-Timer, siehe Kommentar im
  Skript). Benutzt git (`git show`), braucht also die volle Repo-Historie. Werte und Herleitung
  siehe Bericht 016b-nachpruefung-start-und-reste in fuelofit-ops.

- `run-016f-analyse-entfernen.js` (Aufgabe 016f, Analyse-Tab inkl. Chart.js komplett entfernt -
  Auswertungen laufen seitdem über den MCP-Connector in claude.ai): App-Start ohne Konsolenfehler
  und ohne Request an cdnjs.cloudflare.com, nur noch 4 Haupt-Tabs (alle rendern), alte Tab-Werte
  `analyse`/`dashboard` (switchTab() und Deeplink `?tab=analyse`) fallen auf `uebersicht` zurück,
  Lebensmittel loggen/Training loggen/Plan abhaken/Einstellungen speichern ohne Konsolenfehler
  (früher riefen diese renderDashboard() auf). Zusätzlich Zeilenzahl- und Startzeit-Vergleich
  vorher (Commit vor 016f) / nachher, gleiches Setup wie `run-016-start-parallel.js`. Es gibt keine
  persistente "letzter Tab"-Speicherung in localStorage/IndexedDB (grep-geprüft) - der Deeplink
  ist das nächstliegende reale Äquivalent zu einem alten gespeicherten Tab-Wert. Werte und
  Herleitung siehe Bericht 016f in fuelofit-ops.

- `run-016e-training-plan-first.js` (Aufgabe 016e, Training-Tab: "Plan" ist erster Unter-Tab und
  wird bei jedem Öffnen des Training-Tabs aktiviert): (1) App-Start → Training-Tab öffnen → Plan
  aktiv und gerendert, Loggen versteckt, Button-Reihenfolge Plan|Loggen; (2) auf Loggen wechseln,
  Wiederholungen eintragen → anderer Haupt-Tab → zurück zu Training → Plan aktiv → erneut Loggen →
  Wert noch da; (3) `openPlanToday()` (Link "Planvorschlag für heute" von der Übersicht) aktiviert
  weiterhin Training-Tab + Plan. Siehe Bericht 016e in fuelofit-ops.

- `run-017-formeln.js` (Aufgabe 017 Punkt 4, Formel-Charakterisierungstests, heutiger Ist-Stand -
  NICHT bewertet): `calcActivityKcal` (Laufen Faktor 1,04 / Intervall-Tempo-Erkennung über die
  Notiz Faktor 1,1 / Gehen+Wandern MET 3,5 / Zirkel mit Puls-Mischung über `zirkelPulseBreakdown`,
  inkl. Deckel-Fall), `calcBmrForDate` (Mifflin-St Jeor), `calcHistoricalKcalGoal` (liefert IMMER
  genau `{base, activity, daily, total}`, auch ohne eigene Tageslogs), `getActivityStepsForDate`/
  `getStepsSourceForDate` (Quelle garmin/googlefit/oura/none entscheidet die Abzugsliste, NIE
  gemischt), Rezept-Nährwerte aus Zutaten (`recipeNutritionFromIngredients`, NICHT auf `window` -
  über den echten UI-Pfad `openRecipeModal`/`searchRecipeIngredient`/`addIngredientToRecipe`/
  `saveRecipeModal` und den protokollierten `setDoc`-Payload geprüft).

- `run-017-alkohol.js` (Aufgabe 017 Punkt 4, Alkoholregel A): `isAlcoholDrinkEntry`/
  `getAlcoholEntries` sind NICHT auf `window` exponiert und werden seit 016f (Analyse-Tab entfernt)
  ausschließlich innerhalb der KI-Tagescheck-Payload verwendet. Test nutzt trotzdem den echten
  Code-Pfad (`window.createDailyCheckNow()` → `generateDailyCheck` → `buildDailyCheckPayload` →
  `callAnthropicProxy` → `httpsCallable`), OHNE jeden echten KI-Call - nur der `httpsCallable`-Stub
  fängt den Aufruf ab und protokolliert den Payload-Body (siehe oben, `__TEST_AI_RESPONSE__`/
  `__TEST_AI_CALLS__`). Geprüft: `alkohol: 'ja'` zählt immer, `'kochen'` nur 18:00-05:59 UND
  Menge ≥ 100 (`ALCOHOL_KOCHEN_MIN_AMOUNT`), `'nein'` nie, Rezept-Einträge nie, nur die letzten 3
  Tage.

- `run-017-smoke.js` (Aufgabe 017 Punkt 5): App startet ohne Konsolenfehler, alle 4 Haupt-Tabs
  rendern, ein Lebensmittel loggen (protokollierter Write hat sowohl `datum` als auch `date`,
  gleicher Wert - CLAUDE.md-Fallstrick), ein Modal öffnen (`add-food-modal`) und per echter
  Browser-Zurück-Taste (`page.goBack()`, löst `popstate` aus) wieder schließen
  (`MODAL_IDS`/`pushModalState`).

- `run-017-savesettings.js` (Aufgabe 017 Punkt 9, `saveSettings()`-Charakterisierungstests, NICHT
  bewertet/geändert): (c) normale Speicherung schreibt `settings/main` GENAU EINMAL, ohne `merge`,
  mit GENAU den 11 erwarteten Feldern (`tdee, proteinGoal, carbsGoal, fatGoal, gender, age, height,
  weight, activityLevel, detailDays, recipeDisplay`); der zusätzliche Gewichts-Write aus
  `saveSettings()` (`upsertTodayWeightLog`) geht NICHT auf `settings/main`, sondern (mit `merge`)
  auf `entries/log_YYYYMMDD` (Tageslog). (d) simulierter Firestore-Lesefehler beim Start
  (`window.__TEST_FAIL_PATHS__`, siehe `stubs/firebase-stub.mjs`) → `loadSettings()` befüllt das
  Formular nie → `saveSettings()` schreibt trotzdem (ohne `merge`!) die Standardwerte/`null` und
  überschreibt damit vollständig die echten Werte - Befund und Risikobewertung siehe Bericht 017.

## GitHub Actions - bewusst NICHT eingerichtet (Aufgabe 017 Punkt 8)

Nur Abwägung, keine Einrichtung (siehe Bericht 017):

**Dafür:** automatischer Lauf bei jedem Push/PR ohne Cloud-Shell-Schritt; verhindert einen
vergessenen `npm test` vor dem Push; Status sichtbar direkt im GitHub-Commit/PR.

**Dagegen:** Repo ist öffentlich - ein Actions-Workflow läuft auf von GitHub gehosteten Runnern
(fremde Infrastruktur) und braucht `npx playwright install chromium`/`npm ci` bei JEDEM Lauf (kein
warmer Cache wie hier in der Cloud Shell) → mehrere Minuten zusätzliche Laufzeit pro Push, zu Lasten
des kostenlosen Minutenkontingents öffentlicher Repos; Pflegeaufwand für den Workflow selbst
(Node-/Playwright-Versionen, Caching) kommt zum bestehenden Umfang hinzu; die Tests laufen schon
heute zuverlässig lokal in < 1 Minute vor jedem Commit (siehe CLAUDE.md-Regel unten) - der
zusätzliche Nutzen einer zweiten, entfernten Ausführung ist bei einer Ein-Personen-App gering.

# Tests (fitness-tracker)

Playwright-Tests gegen die echte `index.html`. Nur synthetische Daten - keine uid, keine
E-Mail-Adresse, keine echten Werte von Daniel. Öffentliches Repo.

Harness (`stubs/harness.js` + `stubs/firebase-stub.mjs`): Firebase Auth und Firestore werden
über `page.route` an den vier gstatic-Imports durch einen In-Memory-Stub ersetzt (synthetische
Daten per `window.__TEST_STORE__`, seedbar vor der Navigation). Schreibzugriffe (`setDoc`/
`deleteDoc`) werden geblockt und nach `window.__TEST_WRITES__` protokolliert, nie wirklich
ausgeführt. Uhr fest über `page.clock.install(...)`, Viewport 360px.

## Einrichtung

    df -h ~          # Home-Disk ist knapp (siehe CLAUDE.md), vor npm install pruefen
    npm install       # nur playwright (Chromium wird wiederverwendet, falls bereits im Cache)

## Ausführen

    npm test

## Enthaltene Tests

- `run-012d.js` (Aufgabe 012d, Platzhalter "Angenommene Alltagsschritte" entfernt): drei
  Kalorienziel-Szenarien (heute ohne Schritte / heute mit echten Schritten / gestern nur
  Oura-Schritte) plus Einstellungen öffnen/speichern ohne Konsolenfehler, kein Schreiben von
  `assumedDailySteps` mehr. Erwartete Werte und Herleitung siehe Bericht 012d in fuelofit-ops.
- `run-015-datum-zeitzone.js` (Aufgabe 015, UTC-Fehler im 365-Tage-Cutoff von `loadAllData`):
  vier Uhrzeit-/Zeitzonen-Szenarien (00:30 / 23:30 / Zeitumstellungswoche / Montag 00:30,
  Europe/Berlin, `page.clock` + `timezoneId`), prüft ob ein synthetischer logEntries-Eintrag
  genau 366 Tage vor "heute" fälschlich mitgeladen wird (`toISOString()` statt lokalem Datum).
  Vorher/Nachher-Werte und Herleitung siehe Bericht 015 in fuelofit-ops.

- `run-016-start-parallel.js` (Aufgabe 016 Teil A / Nachprüfung 016b Teil A, `loadAllData()`
  per `Promise.all` parallelisiert statt sequenziell): vergleicht einen festen "vorher"-Stand
  (Konstante `BEFORE_SHA`, Default `a40d9dd` - letzter Commit vor der Parallelisierung, per
  `git show <SHA>:index.html`, NICHT `HEAD`) gegen die Arbeitskopie ("nachher"). Bricht vorher mit
  STOPP ab, falls beide Stände in `loadAllData` dieselbe Anzahl `Promise.all`-Aufrufe haben (kein
  Beleg für einen Unterschied). Künstliche Latenz 150ms/Abfrage, je 3 Wiederholungen pro Stand,
  Median von Laufzeit und `__TEST_MAX_INFLIGHT__`. Vergleicht den Endzustand (u. a. Summen
  kcal/Protein des heutigen Tags über `getDayIntakeTotals`, Zieldetails über
  `calcHistoricalKcalGoal`, Anzahl geladener logEntries/entries/garminActivities) - bei Abweichung
  kein automatischer Rückbau, Skript wartet (Exit-Code 3) auf Entscheidung. Kein `page.clock`
  (echte Latenz-Timer, siehe Kommentar im Skript). Werte und Herleitung siehe Bericht
  016b-nachpruefung-start-und-reste in fuelofit-ops.

Wird von Aufgabe 017 (Testsammlung) übernommen/konsolidiert - diese Dateien bleiben bis dahin als
Einzelskripte bestehen.

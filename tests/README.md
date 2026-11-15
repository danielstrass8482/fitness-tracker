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

Wird von Aufgabe 017 (Testsammlung) übernommen/konsolidiert - diese Datei bleibt bis dahin als
Einzelskript bestehen.

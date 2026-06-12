# Fuelofit – Übergabe für Claude Code

## Projektübersicht

**Fuelofit** ist eine persönliche Fitness- und Ernährungs-Tracking-App, entwickelt und genutzt von einer einzigen Person (Daniel).

**Wichtig: Daniel nutzt ausschließlich die Android-App, nicht die PWA im Browser.** Die Android-App ist ein WebView-Wrapper der `index.html` von GitHub Pages lädt – `index.html` IST also faktisch "die App", auch wenn sie technisch als PWA/statische Website ausgeliefert wird. Jede Änderung an `index.html` wirkt sich direkt auf die Android-App aus (nach Neuladen/Cache-Invalidierung in der WebView). Das Android-Repo selbst (`fuelofit-android`) enthält nur den nativen Wrapper + native Erweiterungen (Schrittsensor, Widget, Token-Handling) – die eigentliche App-Logik liegt in `index.html`.

**Priorität dieser Session:** `index.html` (im `fitness-tracker` Repo) ist der Hauptfokus. Das Android-Repo nur anfassen wenn für das Caching-Feature unbedingt nötig (z.B. falls WebView-Cache-Einstellungen angepasst werden müssen).

Tech-Stack:

- **`index.html`** (eine einzige Datei, ~7000 Zeilen) = die App-Logik, gehostet auf GitHub Pages
  - Repo: `fitness-tracker` (öffentlich)
  - URL: `https://danielstrass8482.github.io/fitness-tracker/index.html`
  - Wird von der Android-App per WebView geladen
- **Android-Wrapper**: natives Gerüst um die WebView, mit nativen Erweiterungen (Schrittsensor, Widget, Push)
  - Repo: `fuelofit-android` (privat)
  - Package: `com.fuelofit.app2`
  - Build: GitHub Actions (`build.yml`) → APK/AAB
- **Backend**: Firebase (Firestore, Cloud Functions, Hosting)
  - Projekt-ID: `fitness-tracker-c6f97`
  - Region: `us-central1`
  - Plan: Blaze

---

## Ziel dieses Auftrags

**Refactoring + Health-Check**, OHNE Funktionsverlust:

1. **Jede bestehende Funktion muss erhalten bleiben** – nichts entfernen, nur strukturieren/verbessern
2. **Jede Funktion soll geprüft werden** – auf Syntax-Fehler, toten Code, doppelte Definitionen, Inkonsistenzen
3. **Code soll sauberer/wartbarer werden**, wo sinnvoll – aber Verhalten bleibt identisch
4. **Alles direkt committen/pushen**, damit der nächste Android-Build (GitHub Actions) die neue Version enthält

**Wichtigstes neues Feature in diesem Durchgang:** Lokales Caching der Diary/Training-Daten (IndexedDB oder ähnlich), damit die App beim Start nicht 1-3 Sekunden auf Firestore warten muss. Cache-first, dann Hintergrund-Sync mit Firestore.

---

## Kritische Arbeitsregeln

- **Vollständige Dateien**: Bei jeder Änderung wird die komplette Datei geschrieben/committed, niemals nur Diffs/Snippets in der Erklärung (Commits selbst sind natürlich Diffs, das ist ok – gemeint ist: keine "füge diese Zeile ein"-Anweisungen an den User)
- **`index.html` ist eine Monolith-Datei** mit `<script type="module">` – Vorsicht bei Refactoring in mehrere Dateien: GitHub Pages liefert nur statische Dateien, also wären zusätzliche `.js`-Module möglich (`<script type="module" src="...">`), aber das ändert Lade-Reihenfolge und CORS-Verhalten. Wenn aufgeteilt wird, gründlich testen.
- **Cloud Functions (`index.js`)**: enthält den Platzhalter `GOOGLE_CLIENT_SECRET = 'HIER_DEIN_GOOGLE_SECRET'` – das ist **absichtlich** ein Platzhalter, der lokal/Daniel manuell mit dem echten Secret aus der Google Cloud Console ersetzt wird (Credentials → Fitness Tracker OAuth Client). **Niemals durch ein echtes Secret ersetzen oder committen.** Nach jedem Deploy von `index.js` muss Daniel daran erinnert werden, den Platzhalter zu ersetzen.
- **Keine Breaking Changes an Firestore-Datenstruktur** ohne Migration. Bestehende Collections:
  - `users/{userId}/entries/{id}` – Diary-Einträge (`typ: 'food'|'recipe'`), Trainings (`typ: 'laufen'|'rad'|'pushups'|...`), Tageslogs (`typ: 'tageslog'`), Phone-Steps (`typ: 'phonesteps'`)
  - `users/{userId}/fooddb/{id}` – Lebensmittel-Datenbank
  - `users/{userId}/recipes/{id}` – Rezepte
  - `users/{userId}/settings/main` – Einstellungen (Gewicht, Alter, Größe, Aktivitätslevel etc.)
  - `users/{userId}/settings/favorites` – Favoriten-IDs
  - `users/{userId}/integrations/googlefit` – OAuth Tokens für Google Fit
  - `users/{userId}/integrations/googledrive` – OAuth Tokens für Google Drive Backup

---

## Bekannte Architektur-Eigenheiten (bewusst so gewachsen, bitte verstehen bevor refactored wird)

### Datum-Handling
- Diary-Einträge haben sowohl `datum` als auch `date` Feld (gleicher Wert) – historisch gewachsen, beide werden noch gelesen für Abwärtskompatibilität
- `new Date("yyyy-mm-dd")` wird als UTC interpretiert → führt zu Off-by-one-Day-Bugs. Wo Datumsvergleiche/-arithmetik gemacht werden, wird explizit lokale Zeitzone behandelt (`new Date(y, m, d)` mit Zahlen statt String)

### Schritte-Berechnung (`calcHistoricalKcalGoal`)
- Zwei Schritt-Quellen: Garmin (via Google Fit Sync, `tageslog.steps`, `source_steps: 'googlefit'`) und Samsung-Sensor (Android-App, `window.phoneStepsToday[date]`)
- Garmin hat Priorität wenn vorhanden (`garminSteps > 0`)
- **Alle Aktivitäts-Schritte** (Laufen, Rad, Gehen, Wandern, etc. – alles mit `schritte > 0` und `typ !== 'tageslog'` und `typ !== 'phonesteps'`) werden von den Gesamtschritten abgezogen, um Double-Counting mit den separat berechneten Aktivitätskalorien zu vermeiden
- `calcHistoricalKcalGoal(date, allDayLogs?, allTrainingEntries?)` muss IMMER `{base, activity, daily, total}` zurückgeben (niemals eine bare number) – mehrere Call-Sites verlassen sich darauf
- Funktion ist als `window.calcHistoricalKcalGoal` global für Debugging

### Aktivitätskalorien (`calcActivityKcal`)
- MET-basierte Berechnung je nach `typ`: laufen (1.04-1.1 × distKm × Gewicht), gehen/wandern (3.5 MET), rad (4-10 MET je nach km/h), rad_ebike (2.5 MET), cardio/kraft (6 MET)
- Gehen/Wandern fließen seit kurzem in die Aktivitätskalorien ein (vorher waren sie ausgeschlossen – diese Änderung ist neu und korrekt, NICHT zurückrollen)

### Phonesteps
- `typ: 'phonesteps'` Einträge (`entries/phonesteps_{datum}`) sind KEINE Aktivitäten – müssen aus allen Aktivitäts-Listen/Anzeigen gefiltert werden (`e.typ !== 'phonesteps'`)
- Werden von der Android-App alle 100 Schritte via Samsung `TYPE_STEP_COUNTER` Sensor geschrieben (`source_steps: 'samsung_sensor'`)
- Bekannter offener Bug: Werte wirken manchmal eingefroren (z.B. exakt 3500 an mehreren Tagen) – wahrscheinlich weil der Sensor nur feuert während die App im Vordergrund ist. Aktuell als "gut genug" akzeptiert, da Gehen/Wandern jetzt separat getrackt wird. **Kein Punkt für dieses Refactoring**, aber wenn beim Code-Lesen die Ursache offensichtlich wird, gerne als Kommentar/Issue dokumentieren statt sofort zu fixen.

### 365-Tage-Limit
- `loadAllData()` lädt seit kurzem nur die letzten 365 Tage (`where('datum', '>=', cutoffStr)`), mit einem Fallback-Query für alte Einträge die nur `date` statt `datum` haben. Das ist **gewollt** (Performance) – ältere Daten existieren weiterhin in Firestore, sind aber nicht im initialen Load. Bitte NICHT wieder auf "alles laden" zurückbauen.

### Modal-System
- Alle Modals haben IDs in der `MODAL_IDS` Konstante – wichtig für den Android Back-Button Handler (`popstate` Event schließt das oberste offene Modal)
- Initiales `style="display:none"` darf NICHT zusätzlich `display:flex` im selben style-Attribut haben (CSS-Reihenfolge-Bug, der Modals beim Laden zeigt) – `display:flex` wird nur dynamisch per JS gesetzt beim Öffnen

### Barcode-Scanner
- `barcode-container` MUSS direktes Kind von `<body>` sein (nicht in einem Modal verschachtelt), sonst funktioniert er nicht global. `barcodeContext` Variable ('food' oder 'recipe') steuert wohin das Scan-Ergebnis geht

### Widget (Android)
- `FuelofitWidget.kt`, Package `com.fuelofit.app2`
- Liest primär aus SharedPreferences-Cache (`fuelofit_widget_cache`), den die PWA via `AndroidTokenBridge.updateWidgetData()` / `updateWidgetHistory()` befüllt
- History-Cache: 31 Tage im Format `date|kcal|protein|carbs|fat|kcalGoal|steps`, semikolon-separiert
- Navigation (Prev/Next Day) ist auf Offset `-31` bis `0` begrenzt – passend zur History-Tiefe
- Fallback: wenn kein Cache-Treffer → Firestore-Direktabfrage via `FirebaseApi.fetchTodayData()`

### Android Back-Button
- `MainActivity.onBackPressed()` dispatcht ein JS `popstate` Event statt die App zu schließen
- `TokenBridge.minimizeApp()` (moveTaskToBack) für expliziten Minimize
- PWA: `pushModalState()` beim Öffnen eines Modals, `popstate`-Listener schließt oberstes Modal oder zeigt Exit-Bestätigung

### Token-Refresh
- `MainActivity.onResume()` refresht den Firebase ID Token (`getIdToken(true)`) und speichert ihn via `TokenStore.updateIdToken()` – nötig damit das Widget einen halbwegs frischen Token hat, da Refresh Tokens vom Firebase SDK nicht direkt exponiert werden

---

## Geplante / gewünschte Features für diesen Durchgang

### 1. Lokales Caching (Hauptfeature)
**Problem:** App-Start dauert 1-3 Sekunden weil `loadAllData()` synchron auf Firestore wartet (foodDB, recipes, foodLog/Diary letzte 365 Tage, trainingEntries letzte 365 Tage, favorites).

**Lösung:**
- IndexedDB (oder vergleichbar, browser-/WebView-kompatibel) als lokaler Cache für: `foodDB`, `recipes`, `foodLog`, `trainingEntries`, `favorites`, `settings`
- **Cache-first Strategie**: Beim App-Start sofort aus IndexedDB rendern (wenn vorhanden), parallel im Hintergrund Firestore abfragen
- Wenn Firestore-Daten neuer/abweichend sind → UI aktualisieren + Cache aktualisieren
- **Schreibvorgänge** (neue Diary-Einträge, Trainings, etc.) gehen weiterhin SOFORT nach Firestore (für Cross-Device-Sync zwischen Handy und Laptop) – zusätzlich in den lokalen Cache schreiben
- **Wichtig:** Laptop-Browser und Android-WebView-App sind unterschiedliche Caches – das ist OK und erwartet (kein Cross-Device-Cache-Sync nötig, Firestore bleibt Source of Truth)
- Konfliktstrategie bei Cache vs. Firestore: Firestore gewinnt immer (Cache ist nur Performance-Optimierung, keine Offline-Diary-Funktion in diesem Schritt)

### 2. KI-Foto-Kalorienschätzung (für einen SPÄTEREN Durchgang, hier nur vormerken)
- Idee: Foto vom Essen → Anthropic API (Claude Vision) schätzt Gewicht/Kalorien/Makros
- Daniel hat bereits API-Zugriff über ein Startup-Konto
- **NICHT in diesem Durchgang umsetzen** – nur als bekanntes nächstes Ziel im Hinterkopf behalten, falls die Code-Struktur dafür vorbereitet werden kann (z.B. ein klar abgegrenzter Bereich für "AI-Integrationen")

---

## Bekannte offene Bugs / Beobachtungen (Prioritäten niedrig, bei Gelegenheit)

1. **Samsung-Schritte eingefroren** (siehe oben, "Phonesteps") – Ursache wahrscheinlich `onPause`/`onResume` Sensor-Lifecycle in `MainActivity.kt`. Wenn beim Lesen offensichtlich, dokumentieren.
2. **GitHub Actions Storage** war zeitweise bei 100% (0.5 GB Limit) – falls der Build aus diesem Grund fehlschlägt, prüfen ob Artifact-Retention in `build.yml` reduziert werden kann (z.B. `retention-days: 7` statt Standard 90)

---

## Was NICHT angefasst werden soll

- Die grundsätzliche UI/UX-Struktur (Tabs: Ernährung, Training, Dashboard, Daten, Einstellungen)
- Die Berechnungslogik für Kalorien/Makros (MET-Werte, BMR-Formel) – nur strukturell aufräumen, Werte/Formeln unverändert lassen
- Firestore-Collection-Namen und Dokumentstruktur (siehe oben)
- Die Cloud-Function-Endpunkte (`createCustomToken`, `googleFitCallback`, `googleFitSync`, `googleFitDailySync`, `googleFitDisconnect`, `syncPhoneSteps`, `googleDriveCallback`, `googleDriveRefresh`) – Namen und Signaturen bleiben stabil, da Android-App und PWA sie aufrufen

---

## Repos & Zugriff

- **PWA**: `github.com/danielstrass8482/fitness-tracker` (öffentlich, GitHub Pages)
  - `index.html` – die App
  - `index.js` – Cloud Functions (wird separat zu Firebase deployed, NICHT über GitHub Pages)
  - `privacy.html` – Datenschutzerklärung
- **Android**: `github.com/danielstrass8482/fuelofit-android` (privat)
  - `app/src/main/java/com/fuelofit/app2/MainActivity.kt`
  - `app/src/main/java/com/fuelofit/app2/FuelofitWidget.kt`
  - `app/src/main/java/com/fuelofit/app2/LoginActivity.kt`
  - `app/src/main/java/com/fuelofit/app2/BootReceiver.kt`
  - `app/src/main/AndroidManifest.xml`
  - `.github/workflows/build.yml`

---

## Vorgehen / Reihenfolge

1. **Erst lesen, dann verstehen, dann planen** – `index.html` ist groß (~7000 Zeilen), nicht blind reinschreiben
2. **Health-Check zuerst**: Syntax-Validierung (`node --check` auf extrahiertem `<script type="module">`), nach doppelten Funktionsdefinitionen suchen, toten Code identifizieren (aber nicht ungefragt löschen – erst auflisten und Daniel fragen wenn unsicher)
3. **Caching-Feature als Hauptarbeit** – iterativ, mit Zwischenstand committen wenn sinnvoll
4. **Alles testen** bevor gepusht wird – wenn ein lokaler Test-Server möglich ist (z.B. `python -m http.server` für die PWA), nutzen
5. **Direkt committen & pushen** auf den `fitness-tracker` Repo, damit `index.html` sofort über GitHub Pages aktualisiert ist
6. **Nach dem Push**: Daniel muss die Android-App neu starten (App komplett schließen, nicht nur in den Hintergrund) – die WebView cached `index.html` teilweise, ein einfacher Reload reicht manchmal nicht. Falls die WebView aggressiv cached, kann ein Cache-Busting-Parameter in der URL helfen (z.B. `?v=TIMESTAMP`) – das aber nur einbauen wenn es Probleme gibt, nicht präventiv
7. Bei Unsicherheiten über Verhalten (z.B. "ist dieser Code-Pfad noch in Benutzung?") – fragen statt raten, da Daniel der einzige User ist und genau weiß was er nutzt

---

## Kontakt-Kontext

Daniel ist Hybrid-Athlet (Laufen, Radfahren, Wandern) in Deutschland, nutzt eine Garmin-Uhr mit Health Sync → Google Fit Pipeline. Die App ist sein tägliches Werkzeug – Stabilität und Datenintegrität haben Vorrang vor neuen Features. Kommunikation gerne direkt und technisch, keine Notwendigkeit für ausführliche Erklärungen bei offensichtlichen Dingen.

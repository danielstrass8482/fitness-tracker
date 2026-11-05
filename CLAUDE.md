# Fuelofit – feste Regeln für Claude Code

## Arbeitsweise
- Nur tun, was der Auftrag verlangt. Unklarheit oder Konflikt → STOPP und fragen. Keine Annahmen über Daniels Nutzung.
- Jede Erfolgsmeldung mit echten Daten/Calls belegen (Befehl + gekürztes Ergebnis). "Keine Exception" ist kein Beleg. Ursachen aus Daten belegen, nicht aus Code ableiten.
- Zahlen, Summen und Querbezüge zwischen Abschnitten selbst abgleichen. Auffällige Einzelwerte durch Wiederholung prüfen (Testumgebung kann instabil sein).
- Verdachts-Aufträge: erst belegen oder widerlegen; widerlegt → STOPP, nichts "auf Verdacht" ändern.
- Bericht kurz, nummeriert nach Auftragspunkten. Nicht Ausgeführtes als NICHT AUSGEFÜHRT mit Grund. Offene Punkte am Ende auflisten, NICHT umsetzen. Auftrag nicht wiederholen.

## Sicherheit
- Secrets nie ausgeben, auch nicht teilweise oder maskiert. Keine Dateien/Dokumente mit Secrets vollständig lesen; bei Keys nur Pfad, Rechte, Länge, Prüfungen ohne Inhaltsausgabe (z. B. -check -noout).
- Niemals Secret-Werte abrufen: kein `firebase functions:secrets:access`, kein `gcloud secrets versions access`, keine Ausgabe von Secret-Dateien. Secrets nur schreibend setzen (Datei/Pipe).
- Firestore: settings/ und integrations/ nur mit Feld-Masken lesen; settings/main enthält den Anthropic-Key.
- Keine IAM-Änderungen. Automatische Grants durch firebase (z. B. secretAccessor) im Bericht benennen.
- Garmin: bei Login-/Auth-Fehlern oder 429 nie wiederholen, nie Passwort-Login.
- Vor jedem Commit: keine Secrets, Tokens, E-Mail-Adressen oder uid im Klartext (uid als {uid}).

## Umgebung
- Zuerst gcloud-Auth prüfen (gcloud auth list, Token holbar). Abgelaufen → STOPP, Befehl für Daniel nennen.
- App: index.html über GitHub Pages, Android-WebView-Hülle. Nach App-Änderungen: APP_BUILD auf aktuelle Zeit (Europe/Berlin), commit, push, Pages-Build abwarten, ausgeliefertes APP_BUILD per curl belegen.
- UI-Tests: Playwright mit echter index.html, Auth gestubbt, Read-only-Proxy auf echte Daten, alle Schreibzugriffe blockiert und mit Payload protokolliert, Viewport 360 px. Kein window.alert/confirm in der App, App-Dialoge (showConfirm) nutzen.
- Tests gegen echte Firestore-Daten sparsam: große Collections (logEntries, foods, entries) stubben oder per Count messen; volle App-Starts gegen echte Daten nur, wenn der Auftrag es verlangt (ein Start ≈ 14.800 Reads, gemessen 04.11.2026).
- Cloud Functions: ~/functions (Repo fuelofit-functions), Region us-central1; Oura-Functions, dartTTS und dartCoach in europe-west1. Deploy nur mit --only functions:<name>. Jede Löschfrage (dartTTS, createCustomToken u. a.) mit "No" beantworten; createCustomToken nie löschen.
- VPS 185.117.250.246 (Trading-Bot LIVE): Lesen jederzeit; Eingriffe nie Mo–Fr 15:30–22:00 (Europe/Berlin). Nie crontab -r. Garmin-Sync unter User fuelofit in /home/fuelofit/fuelofit-garmin.
- Cloud-Shell-Home-Disk ist knapp: vor größeren Downloads/Builds df -h ~ prüfen; nichts außerhalb des Auftrags löschen.

## Bekannte Fallstricke
- `logEntries` tragen `datum` und `date` (gleicher Wert; 1.715 Alt-Einträge nur `date`), `entries` nur `datum`; Lesecode nutzt `entry.datum || entry.date` – vorhandene Felder beibehalten.
- `new Date("yyyy-mm-dd")` ist UTC → Off-by-one; lokale Daten mit `new Date(y, m-1, d)` bilden.
- `calcHistoricalKcalGoal` (auch als `window.`) gibt immer `{base, activity, daily, total}` zurück, nie eine Zahl.
- Aktivitätsschritte werden von Tagesschritten abgezogen, nur über `getActivityStepsForDate`; Quelle je Tag per `getStepsSourceForDate`, nie gemischt.
- `calcActivityKcal`: Gehen/Wandern (MET 3,5) zählen bewusst zu Aktivitätskalorien – nicht zurückrollen.
- Formeln (MET, BMR, Zirkel-/Puls-Kalorien, Kalorienziel) nur auf ausdrücklichen Auftrag ändern; Konstanten zentral halten.
- `loadAllData()` lädt bewusst nur 365 Tage (`datum >= cutoffStr`, Fallback-Query auf `date`) – nicht auf "alles" zurückbauen.
- Jedes Modal in `MODAL_IDS` eintragen und beim Öffnen `pushModalState()` aufrufen, sonst bricht der `popstate`-Zurück-Handler.
- Android `onBackPressed()` dispatcht `popstate` in die WebView, statt die App zu schließen.
- Initiales `style="display:none"` nie mit `display:flex` im selben Attribut; flex nur per JS beim Öffnen.
- `barcode-container` muss direktes Kind von `<body>` bleiben; `barcodeContext` ('food'/'recipe') steuert das Ziel.
- Tab-Struktur (Übersicht, Ernährung, Training, Analyse, Einstellungen) nicht umbauen.
- Firestore-Collections und Dokumentstruktur nie ohne Migration ändern (Bestand: `docs/datenmodell.md`).
- Cloud-Function-Namen und -Signaturen stabil halten; Android-App und index.html rufen sie direkt auf.

# Zähl-Labor (Experiment, Aufgabe 038)

Eigenständige Experimentierseite `labor/zaehlen.html` – **nicht** aus der App verlinkt, kein Login, kein Firestore,
keine Analytics. Handykamera → Posenschätzung im Browser (MediaPipe Pose Landmarker lite, lokal aus `vendor/`) →
Live-Zählung der Wiederholungen für eine gewählte Übung. Kein Video wird gespeichert oder gesendet; die Seite
hat eine eigene CSP (`default-src 'self'`, `connect-src 'self'`) → keine Fremd-Requests.

URL: `https://<pages>/labor/zaehlen.html` (optional `?delegate=CPU` oder `?delegate=GPU`; auch per Auswahl „Rechnen“).

## Dateien
- `zaehlen.html` – Seite (UI deutsch, 360 px, App-Farben, hell/dunkel nach Systemeinstellung)
- `zaehlen.js` – Kamera, Modell, Live-Schleife, Skelett/Signalkurve, Ton, Wake Lock, Replay
- `zaehl-kern.js` – Zählkern (Browser + Node), **alle Parameter im Objekt `CONFIG`**
- `vendor/` – MediaPipe tasks-vision 1.2.3 + Modell (≈ 20,9 MB), siehe `vendor/NOTICE.md`
- `test/synth.js` – erzeugt synthetische Aufnahmen nach `test/data/`
- `test/run-kern.js` – Offline-Test des Zählkerns (Node, ohne Browser); Teil von `npm test`
- `../tests/run-038-zaehl-labor.js` – Playwright (Seite, Modell, Replay, keine Fremd-Requests); `--fps` misst die Live-Schleife mit Fake-Kamera

## Zählverfahren (pro Übung ein Signal)
| Übung | Signal | Ruhelage | Mindestamplitude | Mindestdauer |
|---|---|---|---|---|
| Split Squats | mittlere Hüfthöhe (y) | oben | 0,25 × Rumpflänge | 0,6 s |
| Liegestütze | mittlere Höhe sichtbarer Kopf-/Schulterpunkte (je Punkt gelernter Versatz → lückenrobust); Ersatz: vertikale Bildbewegung (Zeilenprofil, SAD-Suche, integriert, Trend entfernt) | oben | 0,35 × Schulterbreite / 0,03 Bildhöhe | 0,6 s |
| Bizeps-Curls | Ellbogenwinkel (kleinerer beider Arme) | gestreckt | 45° | 0,6 s |
| Terraband gerade | Abstand Knöchel–Hüfte / Oberschenkellänge (größerer beider Beine) | gebeugt | 0,2 | 0,8 s |

Ablauf: Keypoints unter Sichtbarkeit 0,5 werden ignoriert; Lücken ≤ 0,5 s linear überbrückt, längere starten das
Signal neu. EMA-Glättung (0,08 s). Laufende Spanne = 5.–95. Perzentil der letzten 10 s (kurze Ausreißer wie
Umgreifen verschieben sie nicht). Hysterese: über 65 % der Spanne → „in Bewegung“, unter 35 % → Wiederholung,
wenn Dauer (Zeit über 35 %) ≥ Mindestdauer, ≤ Höchstdauer (10 s, Bildbewegung 4 s) und Ausschlag ≥ Mindestamplitude.
Liegestütze: Pose und Bildbewegung zählen parallel; angezeigt wird Pose, solange ≥ 60 % der Frames ein Posensignal
haben, sonst Bildbewegung (beide Zahlen stehen in der Statuszeile).
Während des 5-s-Countdowns läuft das Signal schon mit (Ruhelage lernen), gezählt wird erst danach.

## Keypoint-JSON (Format `zaehl-labor-keypoints/1`)
```json
{
  "format": "zaehl-labor-keypoints/1",
  "exercise": "splitsquats | liegestuetze | curls | band_gerade",
  "fps": 30,
  "armedFrom": 5,
  "expected": 8,
  "frames": [ { "t": 0.033, "kp": [[x, y, sichtbarkeit], ... 33 Einträge], "my": 0.0012 } ]
}
```
- `t` Sekunden ab Aufnahmebeginn; `kp` 33 Punkte in MediaPipe-Pose-Reihenfolge, x/y normiert 0..1 (y nach unten),
  Sichtbarkeit 0..1; `kp: null` = keine Pose im Frame.
- `my` (optional) = integrierte vertikale Bildverschiebung in Bildhöhen (nur Liegestütze-Ersatzsignal).
- `armedFrom` (optional) = ab hier wird gezählt; `expected` (optional) = Sollwert für Tests.
- Offline zählen: `node labor/test/run-kern.js datei.json`; im Browser: Abschnitt „Test: Aufnahme abspielen“.

# Kalorienziel, Aktivitäts- und Schrittkalorien, Makroziele

Stand 040 (24.11.2026). Beschreibt den Ist-Code in `index.html`; die Kalorienformeln wurden in 040
**nicht** geändert (nur dokumentiert). Formeln nur auf ausdrücklichen Auftrag ändern.

## 1. Tages-Kalorienziel (`calcHistoricalKcalGoal(date)` → `{base, activity, daily, total}`)

- `base` = Mifflin-St-Jeor-Grundumsatz × `ACTIVITY_FACTOR` 1,375 (fest „leicht aktiv“), mit Gewicht
  des Tages (letzter Tageslog ≤ Datum, sonst `settings.weight`, sonst 75 kg) und Alter am Datum.
- `activity` = Summe `activityKcalForGoal(e)` über die wirksamen Trainingseinträge des Tages
  (`getEffectiveTrainingEntries`): Regeln aus `countsAsActivity` (Plan neben Auto-Eintrag gleichen
  Typs zählt nicht, Einträge ohne `source` zählen nicht); manuelle/Plan-Einträge erst ab
  `MIN_MANUAL_KCAL` = 50 kcal je Eintrag, sonst 0; Garmin-Einträge immer.
- `daily` = round(Alltagsschritte × 0,04 kcal) – **gewichtsunabhängig**.
  Alltagsschritte = `getAlltagsschritteForDate` = Tagesschritte (`getKcalStepsForDate`: Garmin, sonst
  Oura-Rückfall für vergangene Tage) − Aktivitätsschritte (`getActivityStepsForDate`).
- `total` = base + activity + daily.

## 2. Aktivitätskalorien je Typ (`calcActivityKcal(entry)`)

Gewicht = `weightForDate(entry.datum)`, Stunden = `zeit` (hh:mm:ss), Distanz in km.

| Typ | Formel |
|---|---|
| `laufen` | 1,04 × km × kg (Titel mit intervall/tempo/fartlek/wettkampf/race/sprint: 1,1) |
| `gehen`, `wandern` | MET 3,5 × kg × h (zählt bewusst als Aktivität) |
| `rad` | MET 4 / 6 (≥ 16 km/h) / 8 (≥ 19) / 10 (≥ 22) × kg × h |
| `rad_ebike` | MET 2,5 × kg × h |
| `cardio`, `crosstraining` | MET 6 × kg × h |
| Garmin-Kraft ohne Zirkel | Garmin-Netto (`strengthGarminNettoBreakdown`) |
| `source: 'plan'` | `calcPlanActivityKcal` (Tabelle `PLAN_MET`, z. B. gehen/wandern 3,5, laufen 9, yoga 2,5; Kraft/Zirkel über Übungseinstellungen; Zirkel ggf. Puls-Mischwert `zirkelPulseBreakdown`) |
| sonst mit Zeit | MET 5 × kg × h |
| `covered` | 0 |

Alle Formeln außer den Alltagsschritten skalieren linear mit dem Körpergewicht.

## 3. Abzug der Aktivitätsschritte (`getActivityStepsForDate`)

- Schrittquelle des Tages per `getStepsSourceForDate`, nie gemischt.
- Quelle Garmin/Oura/keine: Summe `steps` der sichtbaren Garmin-Aktivitäten des Tages.
- Quelle Google Fit (Altbestand): Summe `schritte` der Trainingseinträge.
- Diese Schritte werden von den Tagesschritten abgezogen, damit sie nicht zusätzlich mit 0,04 kcal
  zählen – die Aktivität bekommt stattdessen ihre Typ-Formel aus Abschnitt 2.

## 4. Beispiel Wanderung 21.11.2026 (Daten aus dem Connector)

- `views.training_sessions`: `garmin_25151411495`, typ `wandern`, 19,24 km, Zeit 04:05:55
  (14.755 s), 24.322 Schritte, 653 Hm, Ø 4,7 km/h, `act_kcal_calc` 1.082 (Garmin selbst: 1.485).
- Rechnung: 3,5 × 75,4 kg × 4,0987 h = 1.081,6 → **1.082 kcal**. Die Schrittzahl geht nicht ein.
- Tagesschritte 34.153 − 24.322 Aktivitätsschritte = 9.831 Alltagsschritte × 0,04 = 393 kcal
  (`kcal_goal_daily` 393). Zwei Plan-Einheiten (Klimmzüge 48, Curls 45 kcal) liegen unter 50 kcal → 0.
  Ziel: 2.279 + 1.082 + 393 = 3.754 kcal = Snapshot.
- 1.082 / 24.322 = 0,0445 kcal/Schritt gegenüber 0,04 im Alltag: kein eigener Schrittfaktor, sondern
  Zufall der Zeitformel. Wandern rechnet nach Zeit (MET × kg × h); bei langsamem Tempo mit Höhenmetern
  (4,7 km/h, 1,65 Schritte/s) fallen auf jeden Schritt mehr Minuten → etwas mehr kcal je Schritt.
  Bei 5,5 km/h in der Ebene wären es weniger kcal je Schritt. Je kg mehr Gewicht steigt der Wert linear,
  der Alltagswert 0,04 nicht.

## 5. Makroziele (040, Daniel 24.11.2026) – `calcMacroGoals(date)` / `macroSplit(G, kg)`

- G = `calcHistoricalKcalGoal(date).total` (unverändert).
- Protein P = round(max(20 % × G / 4, 1,8 g/kg × `weightForDate`)); Fett F = round(33 % × G / 9);
  Kohlenhydrate C = round((G − 4P − 9F) / 4). Greift die Protein-Untergrenze, gehen die Mehr-kcal von
  den KH ab (`proteinFloorApplied`, Hinweis „Mindestwert 1,8 g/kg“ in Kachel/Tagebuch).
- Summe 4P + 9F + 4C = G bis auf Rundung: ganze Gramm machen exakte Gleichheit für beliebiges G
  unmöglich; C ist Rest → Abweichung höchstens 2 kcal (Test: 50 zufällige G, −1 … +2 kcal).
- Makro-Prognose (nur heute, offene Plan-Einheiten, `plannedOpenUnitsKcal`): dasselbe Modell auf
  G + Zusatz-kcal; nur Anzeige und Snapshot-Zusatzfelder, `goal_*` bleiben Ist.
- Fett-Hinweis (nur Anzeige): „Fettanteil [heute] X % (über 35 %)“, wenn 9 × Fett / aufgenommene kcal
  > 35 %; vergangene Tage immer, heute erst ab 50 % des Kalorienziels erfasst.
- Konstanten zentral: `MACRO_SHARE`, `MACRO_PROTEIN_MIN_G_PER_KG`, `MACRO_KCAL_PER_G`,
  `MACRO_FAT_HINT_SHARE`, `MACRO_FAT_HINT_TODAY_MIN_LOGGED`.
- Vorher (027/027b, 21.–24.11.2026): Protein 150 g und Fett 100 g fix (Einstellungen), KH = Rest,
  mind. 3 g/kg, Prognose 100 % KH. `settings.proteinGoal/fatGoal/carbsGoal` bleiben im Dokument,
  werden nicht mehr verwendet; Eingabefelder und „Makro-Vorschlag“ in den Einstellungen entfernt.
- Gesättigte Fettsäuren: nicht erfasst (weder `foods`, `logEntries`, OFF-Import noch
  `data/bls-makros.json` haben ein Feld dafür) → kein Hinweis möglich.

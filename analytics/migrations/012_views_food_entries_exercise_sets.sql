-- Migration 012: views.food_log_entries + views.exercise_sets (Aufgabe 016g/016h).
--
-- Grundlage: Bericht 016g Teil A (Logik aus index.html, Commit 70e06a7) -- Felder/Regeln dort
-- belegt, hier nicht neu hergeleitet.
--
-- ===== views.food_log_entries =====
-- Jede aktive raw.log_entries-Zeile = ein Log-Eintrag (kein Aggregat -- Summen je Tag muessen
-- zu views.daily_nutrition passen, gleiche Quelle "day"). kategorie wie kat_breakdown
-- (renderDashboard): ein Eintrag zaehlt als 'gerichte', wenn recipeId gesetzt ist (unabhaengig
-- davon, ob das Rezept noch existiert) ODER foodId selbst die ID eines (noch aktiven) Rezepts
-- ist (kollabierte Alt-Eintraege ohne eigenes recipeId-Feld, siehe Probelauf-Beleg). Sonst
-- foods.kategorie der foodId, fehlt sie/foodId unbekannt -> 'unbekannt'. Expandierte
-- Rezept-Zutaten (_fromRecipe gesetzt, kein recipeId) fallen NICHT unter 'gerichte', sondern
-- unter die Kategorie der Zutat selbst (foods.kategorie der Zutat-foodId) -- kat_breakdown
-- prueft _fromRecipe gar nicht.
-- einheit: 'g' bei normalen Eintraegen (amount ist dort immer Gramm); bei kollabierten
-- Rezept-Block-Eintraegen (eigenes unit-Feld) 'grams'->'g' / 'portions'->'portion'.
-- aus_rezept: Rezeptname aus recipeId (falls das Rezept noch existiert) oder aus _fromRecipe,
-- sonst NULL. Bekannter Grenzfall (32 Alt-Eintraege, 04-05/2026): kollabierte Rezept-Eintraege
-- ohne recipeId-Feld (foodId = Rezept-ID, Name-Muster "<Rezept> (Xg)") bekommen kategorie=
-- 'gerichte' (ueber die foodId-Regel oben), aber aus_rezept bleibt NULL, weil fuer aus_rezept nur
-- recipeId/_fromRecipe vorgesehen sind (siehe Bericht 016h) -- bewusst nicht erweitert, da nicht
-- im Auftrag.
-- alkohol: foods.alkohol der foodId, sonst NULL (Rezept-Bloecke haben kein foods-Dokument).
-- entry_id: gekuerzt = Teil vor dem ersten "_" (Zeitstempel-Praefix der Original-ID) + "_" +
-- letzte 4 Zeichen der Original-ID -- nur Kuerzung fuer die Anzeige, keine Garantie auf
-- Eindeutigkeit (entry_id ist hier kein Schluessel). Keine uid-Spalte (Single-User-DB).
--
-- ===== views.exercise_sets =====
-- Option A (Daniel 17.11.2026 informiert, Claude-Empfehlung aus Bericht 016g): nur Eintraege mit
-- typ <> 'zirkel', exakt die Menge, die populateWorkoutTypeSelect/renderWorkoutChart zeigten:
-- typ (nach Altformat-Mapping) in ('pullups','pushups','lunges') ODER beginnt mit 'custom_'.
-- Zirkel-Einheiten (typ='zirkel') werden NIE erfasst -- sie stehen in views.training_sessions.
-- variante wie das alte Diagramm normalisiert (variantLabelToKey), Default 'regulaer' (JS-"||"
-- behandelt auch einen leeren String als "nicht gesetzt" -- per Probelauf belegt: ohne dieses
-- Verhalten waeren 32 Zeilen faelschlich nicht 'regulaer').
-- saetze/wdh_gesamt/wdh_max ausschliesslich aus dem Feld "sets" (Bindestrich-String, z. B.
-- "10-8-6"; nur positive Zahlen zaehlen) -- bewusst wie im alten Chart: Haltezeit-Eintraege
-- (sets leer) liefern hier 0/0/0, NICHT die Haltezeit.
-- haltezeit_sek_gesamt/haltezeit_je_satz NEU aus dem Feld "holdSec" (Array Sekunden je Satz),
-- sonst NULL -- bewusst ANDERS als der alte Chart, der eine Haltezeit-Uebung effektiv als 0 Wdh.
-- zeigte (siehe views_info.json-Hinweis). Kein Gewicht-Feld (existiert in den Trainingsdaten
-- nicht).
-- entry_id: gleiche Kuerzung wie bei food_log_entries oben.
--
-- Idempotent (CREATE OR REPLACE VIEW). Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 012_views_food_entries_exercise_sets.sql

CREATE OR REPLACE VIEW views.food_log_entries AS
WITH l AS (
  SELECT
    le.id,
    le.day,
    le.data->>'time' AS uhrzeit,
    le.data->>'name' AS lebensmittel,
    (le.data->>'amount')::numeric AS menge,
    le.data->>'unit' AS unit_raw,
    (le.data->>'kcal')::numeric AS kcal,
    (le.data->>'protein')::numeric AS protein,
    (le.data->>'carbs')::numeric AS carbs,
    (le.data->>'fat')::numeric AS fat,
    NULLIF(le.data->>'recipeId', '') AS recipe_id,
    NULLIF(le.data->>'_fromRecipe', '') AS from_recipe,
    le.data->>'foodId' AS food_id,
    split_part(le.id, '_', 1) || '_' || right(le.id, 4) AS entry_id_kurz
  FROM raw.log_entries le
  WHERE le.deleted_at IS NULL AND le.day IS NOT NULL
)
SELECT
  l.day,
  l.uhrzeit,
  l.lebensmittel,
  l.menge,
  CASE l.unit_raw WHEN 'grams' THEN 'g' WHEN 'portions' THEN 'portion' ELSE 'g' END AS einheit,
  l.kcal,
  l.protein,
  l.carbs,
  l.fat,
  CASE
    WHEN l.recipe_id IS NOT NULL OR r_food.id IS NOT NULL THEN 'gerichte'
    ELSE COALESCE(f.data->>'kategorie', 'unbekannt')
  END AS kategorie,
  COALESCE(r_rid.data->>'name', l.from_recipe) AS aus_rezept,
  f.data->>'alkohol' AS alkohol,
  l.entry_id_kurz AS entry_id
FROM l
LEFT JOIN raw.foods f ON f.id = l.food_id AND f.deleted_at IS NULL
LEFT JOIN raw.recipes r_food ON r_food.id = l.food_id AND r_food.deleted_at IS NULL
LEFT JOIN raw.recipes r_rid ON r_rid.id = l.recipe_id AND r_rid.deleted_at IS NULL;

GRANT SELECT ON views.food_log_entries TO fuelofit_ro;

CREATE OR REPLACE VIEW views.exercise_sets AS
WITH base AS (
  SELECT
    e.id,
    e.day,
    COALESCE(
      e.data->>'typ',
      CASE e.data->>'type' WHEN 'pull' THEN 'pullups' WHEN 'push' THEN 'pushups' ELSE e.data->>'type' END
    ) AS uebung,
    e.data->>'source' AS quelle,
    NULLIF(e.data->>'sets', '') AS sets_raw,
    e.data->'holdSec' AS hold_sec_raw,
    lower(trim(COALESCE(NULLIF(e.data->>'variant', ''), NULLIF(e.data->>'variante', ''), 'regulaer'))) AS variant_raw,
    split_part(e.id, '_', 1) || '_' || right(e.id, 4) AS entry_id_kurz
  FROM raw.entries e
  WHERE e.deleted_at IS NULL
),
filtered AS (
  SELECT *
  FROM base
  WHERE uebung IN ('pullups', 'pushups', 'lunges') OR uebung ~ '^custom_'
),
parsed AS (
  SELECT
    f.*,
    ARRAY(
      SELECT n::int
      FROM unnest(string_to_array(COALESCE(f.sets_raw, ''), '-')) AS n
      WHERE n ~ '^[0-9]+$' AND n::int > 0
    ) AS nums,
    ARRAY(
      SELECT (h)::numeric::int
      FROM jsonb_array_elements_text(COALESCE(f.hold_sec_raw, '[]'::jsonb)) AS h
    ) AS hold_nums
  FROM filtered f
)
SELECT
  p.day,
  p.uebung,
  CASE p.variant_raw
    WHEN 'regulär' THEN 'regulaer'
    WHEN 'regular' THEN 'regulaer'
    WHEN 'regulaer' THEN 'regulaer'
    WHEN 'reverse' THEN 'reverse'
    WHEN 'hammer grip' THEN 'hammer'
    WHEN 'hammer' THEN 'hammer'
    WHEN 'weit' THEN 'weit'
    WHEN 'eng' THEN 'eng'
    WHEN 'diamond' THEN 'diamond'
    WHEN 'normal' THEN 'normal'
    WHEN 'elevated feet' THEN 'elevated_feet'
    WHEN 'elevated_feet' THEN 'elevated_feet'
    WHEN 'mit gewichten' THEN 'weighted'
    WHEN 'weighted' THEN 'weighted'
    ELSE p.variant_raw
  END AS variante,
  p.quelle,
  COALESCE(array_length(p.nums, 1), 0) AS saetze,
  COALESCE((SELECT sum(x) FROM unnest(p.nums) x), 0) AS wdh_gesamt,
  COALESCE((SELECT max(x) FROM unnest(p.nums) x), 0) AS wdh_max,
  p.sets_raw AS wdh_je_satz,
  CASE WHEN array_length(p.hold_nums, 1) > 0 THEN (SELECT sum(x) FROM unnest(p.hold_nums) x) END AS haltezeit_sek_gesamt,
  CASE WHEN array_length(p.hold_nums, 1) > 0 THEN array_to_string(p.hold_nums, '-') END AS haltezeit_je_satz,
  p.entry_id_kurz AS entry_id
FROM parsed p;

GRANT SELECT ON views.exercise_sets TO fuelofit_ro;

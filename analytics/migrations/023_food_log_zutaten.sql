-- Migration 023: views.food_log_zutaten -- Rezept-Bloecke in Zutaten zerlegt (Aufgabe 045).
--
-- Wie views.food_log_entries (gleiche Quelle raw.log_entries, gleiche Spalten), aber jeder
-- kollabierte Rezept-Block wird durch seine Zutaten ersetzt. food_log_entries und daily_nutrition
-- bleiben unveraendert. Zusatzspalten: herkunft, rezept, skalierung, abweichung_pct.
--
-- Rezept-Block = recipeId gesetzt ODER foodId ist die ID eines aktiven Rezepts (gleiche Regel wie
-- kategorie 'gerichte' in food_log_entries; Lebensmittel mit foods.kategorie 'gerichte', z. B.
-- Fertiggerichte, sind KEINE Bloecke -> herkunft 'direkt'). Rezept = recipeId, sonst foodId.
--
-- herkunft:
--   'direkt'                 normale Lebensmittel-Zeile (unveraendert wie food_log_entries)
--   'rezept_expandiert'      vorhandene _fromRecipe-Zeile (App-Modus "expanded", schon Zutat)
--   'rezept_zerlegt'         Zutat eines zerlegten Blocks
--   'rezept_nicht_zerlegbar' Block ohne auffindbares Rezept / ohne Zutaten / ohne Faktor (eine
--                            Zeile = Original-Block) ODER Rest-Zeile eines zerlegten Blocks:
--                            Rest = geloggt - Summe zerlegt, je Feld (kcal, P, C, F), damit
--                            Tagessummen exakt bleiben; immer wenn ein Feld-Rest >= 0,05 ist
--                            (fehlende Zutaten-Lebensmittel, Makro ohne Zutatenwert, Rundung);
--                            kategorie 'gerichte'.
--
-- Faktor (skalierung) je Block: unit 'portions' -> amount / recipe.portions; unit 'grams' ->
-- amount / recipe.totalWeight; sonst (Alt-Eintraege ohne unit) kcal_eintrag / recipe.kcal.
-- Zutat ungeskaliert = foods je 100 g x amount/100 x Faktor (wie App saveRecipeEntry "expanded");
-- fehlt das Zutaten-Lebensmittel in raw.foods, zaehlt fuer die Vergleichssumme der im Rezept
-- gespeicherte Zutatenwert x Faktor. abweichung_pct = (Vergleichssumme kcal - geloggte kcal) /
-- geloggte kcal x 100 (> 5 % = Rezept oder Lebensmittel nach dem Loggen geaendert).
-- Danach werden alle Zutaten mit s = geloggte kcal / Vergleichssumme kcal skaliert (der geloggte
-- Wert ist die Wahrheit); Makros je Makro mit eigenem Verhaeltnis geloggt / Vergleichssumme
-- (Vergleichssumme wie oben) -> Tagessummen exakt; die Makro-Aufteilung auf
-- einzelne Zutaten ist bei hoher abweichung_pct naeherungsweise. Werte auf 2 Nachkommastellen.
-- kategorie der Zutat = foods.kategorie, sonst 'unbekannt' (wie food_log_entries).
-- alkohol der Zutat = foods.alkohol der Zutat (nur Info). Die Alkohol-Regel (alkohol_tage, App
-- ~8291) zaehlt Rezeptzutaten NIE -- diese Spalte nicht fuer Alkoholtage verwenden.
-- menge der Zutat = Zutatenmenge x Faktor (g). entry_id = gekuerzte ID des Blocks (alle Zutaten
-- eines Blocks teilen sie).
--
-- Idempotent. Ausfuehrung auf dem VPS als postgres:
-- psql -1 -v ON_ERROR_STOP=1 -d fuelofit_analytics -f 023_food_log_zutaten.sql

CREATE OR REPLACE VIEW views.food_log_zutaten AS
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
),
lj AS (
  SELECT
    l.*,
    f.data AS food,
    (l.recipe_id IS NOT NULL OR r_food.id IS NOT NULL) AS ist_block,
    COALESCE(r_rid.data, CASE WHEN l.recipe_id IS NULL THEN r_food.data END) AS rezept_data
  FROM l
  LEFT JOIN raw.foods f ON f.id = l.food_id AND f.deleted_at IS NULL
  LEFT JOIN raw.recipes r_food ON r_food.id = l.food_id AND r_food.deleted_at IS NULL
  LEFT JOIN raw.recipes r_rid ON r_rid.id = l.recipe_id AND r_rid.deleted_at IS NULL
),
-- Bloecke mit Faktor
b AS (
  SELECT
    lj.*,
    lj.rezept_data->>'name' AS rezept_name,
    CASE
      WHEN lj.rezept_data IS NULL THEN NULL
      WHEN lj.unit_raw = 'portions' AND (lj.rezept_data->>'portions')::numeric > 0
        THEN lj.menge / (lj.rezept_data->>'portions')::numeric
      WHEN lj.unit_raw = 'grams' AND (lj.rezept_data->>'totalWeight')::numeric > 0
        THEN lj.menge / (lj.rezept_data->>'totalWeight')::numeric
      WHEN (lj.rezept_data->>'kcal')::numeric > 0
        THEN lj.kcal / (lj.rezept_data->>'kcal')::numeric
    END AS faktor
  FROM lj
  WHERE lj.ist_block
),
-- Zutaten ungeskaliert
z AS (
  SELECT
    b.id AS block_id,
    z.ord,
    zf.id IS NOT NULL AS food_da,
    COALESCE(zf.data->>'name', z.ing->>'name') AS name,
    (z.ing->>'amount')::numeric * b.faktor AS menge,
    zf.data->>'kategorie' AS kategorie,
    zf.data->>'alkohol' AS alkohol,
    CASE WHEN zf.id IS NOT NULL
      THEN (zf.data->>'kcal')::numeric * COALESCE((z.ing->>'amount')::numeric, 100) / 100 * b.faktor
      ELSE (z.ing->>'kcal')::numeric * b.faktor END AS kcal,
    CASE WHEN zf.id IS NOT NULL THEN (zf.data->>'protein')::numeric * COALESCE((z.ing->>'amount')::numeric, 100) / 100
      ELSE (z.ing->>'protein')::numeric END * b.faktor AS protein,
    CASE WHEN zf.id IS NOT NULL THEN (zf.data->>'carbs')::numeric * COALESCE((z.ing->>'amount')::numeric, 100) / 100
      ELSE (z.ing->>'carbs')::numeric END * b.faktor AS carbs,
    CASE WHEN zf.id IS NOT NULL THEN (zf.data->>'fat')::numeric * COALESCE((z.ing->>'amount')::numeric, 100) / 100
      ELSE (z.ing->>'fat')::numeric END * b.faktor AS fat
  FROM b
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.rezept_data->'ingredients', '[]'::jsonb))
    WITH ORDINALITY AS z(ing, ord)
  LEFT JOIN raw.foods zf ON zf.id = z.ing->>'foodId' AND zf.deleted_at IS NULL
  WHERE b.faktor IS NOT NULL
),
bs AS (
  SELECT
    b.*,
    zs.summe_kcal,
    zs.n_da,
    zs.n_fehlt,
    CASE WHEN zs.summe_kcal > 0 THEN b.kcal / zs.summe_kcal END AS s,
    CASE WHEN zs.summe_p > 0 THEN b.protein / zs.summe_p ELSE 0 END AS s_p,
    CASE WHEN zs.summe_c > 0 THEN b.carbs / zs.summe_c ELSE 0 END AS s_c,
    CASE WHEN zs.summe_f > 0 THEN b.fat / zs.summe_f ELSE 0 END AS s_f
  FROM b
  LEFT JOIN (
    SELECT block_id, sum(kcal) AS summe_kcal, sum(protein) AS summe_p, sum(carbs) AS summe_c, sum(fat) AS summe_f,
      count(*) FILTER (WHERE food_da) AS n_da, count(*) FILTER (WHERE NOT food_da) AS n_fehlt
    FROM z GROUP BY block_id
  ) zs ON zs.block_id = b.id
),
-- zerlegbar: Faktor, Vergleichssumme > 0, mind. eine Zutat mit Lebensmittel
zr AS (
  SELECT
    bs.id AS block_id,
    z.ord,
    z.name,
    z.menge,
    z.kategorie,
    z.alkohol,
    round(z.kcal * bs.s, 2) AS kcal,
    round(z.protein * bs.s_p, 2) AS protein,
    round(z.carbs * bs.s_c, 2) AS carbs,
    round(z.fat * bs.s_f, 2) AS fat
  FROM bs JOIN z ON z.block_id = bs.id AND z.food_da
  WHERE bs.s IS NOT NULL AND bs.n_da > 0
),
rest AS (
  SELECT
    bs.id AS block_id,
    bs.kcal - COALESCE(sum(zr.kcal), 0) AS kcal,
    bs.protein - COALESCE(sum(zr.protein), 0) AS protein,
    bs.carbs - COALESCE(sum(zr.carbs), 0) AS carbs,
    bs.fat - COALESCE(sum(zr.fat), 0) AS fat
  FROM bs JOIN zr ON zr.block_id = bs.id
  GROUP BY bs.id, bs.kcal, bs.protein, bs.carbs, bs.fat
  HAVING greatest(abs(bs.kcal - COALESCE(sum(zr.kcal), 0)), abs(bs.protein - COALESCE(sum(zr.protein), 0)),
                  abs(bs.carbs - COALESCE(sum(zr.carbs), 0)), abs(bs.fat - COALESCE(sum(zr.fat), 0))) >= 0.05
)
-- 1) direkt + rezept_expandiert (wie food_log_entries)
SELECT
  lj.day, lj.uhrzeit, lj.lebensmittel, lj.menge,
  CASE lj.unit_raw WHEN 'grams' THEN 'g' WHEN 'portions' THEN 'portion' ELSE 'g' END AS einheit,
  lj.kcal, lj.protein, lj.carbs, lj.fat,
  COALESCE(lj.food->>'kategorie', 'unbekannt') AS kategorie,
  lj.from_recipe AS aus_rezept,
  lj.food->>'alkohol' AS alkohol,
  lj.entry_id_kurz AS entry_id,
  CASE WHEN lj.from_recipe IS NOT NULL THEN 'rezept_expandiert' ELSE 'direkt' END AS herkunft,
  lj.from_recipe AS rezept,
  NULL::numeric AS skalierung,
  NULL::numeric AS abweichung_pct
FROM lj
WHERE NOT lj.ist_block
UNION ALL
-- 2) rezept_zerlegt
SELECT
  bs.day, bs.uhrzeit, zr.name, round(zr.menge, 1), 'g',
  zr.kcal, zr.protein, zr.carbs, zr.fat,
  COALESCE(zr.kategorie, 'unbekannt'),
  bs.rezept_name,
  zr.alkohol,
  bs.entry_id_kurz,
  'rezept_zerlegt',
  bs.rezept_name,
  round(bs.faktor, 4),
  round((bs.summe_kcal - bs.kcal) / NULLIF(bs.kcal, 0) * 100, 1)
FROM bs JOIN zr ON zr.block_id = bs.id
UNION ALL
-- 3a) Rest eines zerlegten Blocks (fehlende Zutaten-Lebensmittel, Makro ohne Zutatenwert, Rundung)
SELECT
  bs.day, bs.uhrzeit,
  'Rest ' || COALESCE(bs.rezept_name, bs.lebensmittel, 'Rezept') || COALESCE(
    ' (Zutat ohne Lebensmittel: ' ||
      (SELECT string_agg(z.name, ', ' ORDER BY z.ord) FROM z WHERE z.block_id = bs.id AND NOT z.food_da) || ')',
    ' (Rundung/Makro ohne Zutatenwert)'),
  NULL::numeric, 'g',
  rest.kcal, rest.protein, rest.carbs, rest.fat,
  'gerichte',
  bs.rezept_name,
  NULL,
  bs.entry_id_kurz,
  'rezept_nicht_zerlegbar',
  bs.rezept_name,
  round(bs.faktor, 4),
  round((bs.summe_kcal - bs.kcal) / NULLIF(bs.kcal, 0) * 100, 1)
FROM bs JOIN rest ON rest.block_id = bs.id
UNION ALL
-- 3b) Block gar nicht zerlegbar (kein Rezept, keine Zutaten, kein Faktor, nur fehlende Lebensmittel)
SELECT
  bs.day, bs.uhrzeit, bs.lebensmittel, bs.menge,
  CASE bs.unit_raw WHEN 'grams' THEN 'g' WHEN 'portions' THEN 'portion' ELSE 'g' END,
  bs.kcal, bs.protein, bs.carbs, bs.fat,
  'gerichte',
  bs.rezept_name,
  NULL,
  bs.entry_id_kurz,
  'rezept_nicht_zerlegbar',
  bs.rezept_name,
  round(bs.faktor, 4),
  round((bs.summe_kcal - bs.kcal) / NULLIF(bs.kcal, 0) * 100, 1)
FROM bs
WHERE NOT (bs.s IS NOT NULL AND COALESCE(bs.n_da, 0) > 0);

GRANT SELECT ON views.food_log_zutaten TO fuelofit_ro;

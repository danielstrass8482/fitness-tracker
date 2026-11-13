-- Migration 006: views.alkohol_tage -- Trinktage aus foods.alkohol (Aufgaben 011/011b).
--
-- Regel (Daniel, 13.11.2026, Variante A): Ein Log-Eintrag zaehlt als GETRUNKEN, wenn
--   - das Lebensmittel alkohol = 'ja' hat, ODER
--   - alkohol = 'kochen' UND Uhrzeit 18:00-05:59 UND Menge >= 100 (ml bzw. g) UND der Eintrag
--     nicht aus einem Rezept stammt (recipeId / _fromRecipe).
-- alkohol = 'nein' und Lebensmittel ohne Feld zaehlen nie. Rezept-Block-Eintraege haben
-- foodId = Rezept-ID (kein foods-Doc) und fallen schon durch den JOIN heraus.
-- Datenbasis: belastbar ab ca. 11/2025 (aeltere Eintraege teils auf geloeschte Lebensmittel).
--
-- amount ist bisher immer jsonb-number; nicht-numerische Werte werden sicher als NULL behandelt
-- (zaehlen im kochen-Zweig nicht, gehen nicht in menge_ml ein).
--
-- Idempotent (CREATE OR REPLACE VIEW). Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 006_alkohol_tage.sql

CREATE OR REPLACE VIEW views.alkohol_tage AS
WITH e AS (
  SELECT
    l.day,
    f.data->>'name' AS food_name,
    f.data->>'alkohol' AS alkohol,
    l.data->>'time' AS t,
    CASE WHEN (l.data->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
         THEN (l.data->>'amount')::numeric END AS amount,
    (COALESCE(l.data->>'recipeId', '') <> '' OR COALESCE(l.data->>'_fromRecipe', '') <> '') AS aus_rezept
  FROM raw.log_entries l
  JOIN raw.foods f ON f.id = l.data->>'foodId' AND f.deleted_at IS NULL
  WHERE l.deleted_at IS NULL
    AND l.day IS NOT NULL
    AND f.data->>'alkohol' IN ('ja', 'kochen')
)
SELECT
  day,
  count(*) AS getraenke,
  sum(amount) AS menge_ml,
  string_agg(DISTINCT food_name, ' | ' ORDER BY food_name) AS lebensmittel
FROM e
WHERE alkohol = 'ja'
   OR ( alkohol = 'kochen'
        AND t ~ '^[0-9]{2}:[0-9]{2}$'
        AND (t >= '18:00' OR t < '06:00')
        AND amount >= 100
        AND NOT aus_rezept )
GROUP BY day;

GRANT SELECT ON views.alkohol_tage TO fuelofit_ro;

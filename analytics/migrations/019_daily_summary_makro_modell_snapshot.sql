-- Migration 019: views.daily_summary.makro_modell aus dem Snapshot-Feld (Aufgabe 040a, 24.11.2026).
--
-- Ab Release 040a schreibt die App das Feld makro_modell in raw.daily_snapshots.data
-- ('hybrid_040a': Protein 150 g fix (mind. 1,8 g/kg), Fett 33 % von (Basis + Alltagsschritte)
-- + 30 % der Aktivitaets-kcal, KH = Rest). Die View nimmt dieses Feld, wenn vorhanden; sonst
-- Datums-Rueckfall wie in Migration 018 (fix_027 21.-23.11., prozent_040 ab 24.11.). Behebt
-- Pruefer-Hinweis 2 aus 040 fuer alle Snapshots ab 040a (Datum allein beschreibt den Build nicht).
-- Nur der CASE-Ausdruck von makro_modell aendert sich; Spalten, Reihenfolge und Typen unveraendert.
-- Grant unveraendert (zur Sicherheit erneut gesetzt, idempotent).
CREATE OR REPLACE VIEW views.daily_summary AS
SELECT
  ds.day,
  (ds.data->'kcalGoal'->>'total')::numeric AS kcal_goal_total,
  (ds.data->'kcalGoal'->>'base')::numeric AS kcal_goal_base,
  (ds.data->'kcalGoal'->>'activity')::numeric AS kcal_goal_activity,
  (ds.data->'kcalGoal'->>'daily')::numeric AS kcal_goal_daily,
  (ds.data->'intake'->>'kcal')::numeric AS intake_kcal,
  (ds.data->'intake'->>'protein')::numeric AS intake_protein,
  (ds.data->'intake'->>'carbs')::numeric AS intake_carbs,
  (ds.data->'intake'->>'fat')::numeric AS intake_fat,
  (ds.data->'intake'->>'kcal')::numeric - (ds.data->'kcalGoal'->>'total')::numeric AS balance_kcal,
  (ds.data->'steps'->>'display')::numeric AS steps_display,
  ds.data->'steps'->>'source' AS steps_source,
  (SELECT COALESCE(sum((a->>'kcalGezaehlt')::numeric), 0)
     FROM jsonb_array_elements(ds.data->'activities') a) AS activity_kcal_sum,
  bw.weight_kg,
  (ds.data->>'final')::boolean AS final,
  (ds.data->>'backfilled')::boolean AS backfilled,
  ds.data->>'appBuild' AS app_build,
  (ds.data->>'goal_protein_g')::numeric AS ziel_protein_g,
  (ds.data->>'goal_fat_g')::numeric AS ziel_fett_g,
  (ds.data->>'goal_carbs_g')::numeric AS ziel_kh_g,
  CASE
    WHEN ds.data->>'goal_protein_g' IS NULL THEN NULL
    WHEN ds.data->>'makro_modell' IS NOT NULL THEN ds.data->>'makro_modell'
    WHEN ds.day < DATE '2026-11-21' THEN NULL
    WHEN ds.day < DATE '2026-11-24' THEN 'fix_027'
    ELSE 'prozent_040'
  END AS makro_modell
FROM raw.daily_snapshots ds
LEFT JOIN views.body_weight bw ON bw.day = ds.day
WHERE ds.deleted_at IS NULL;

GRANT SELECT ON views.daily_summary TO fuelofit_ro;

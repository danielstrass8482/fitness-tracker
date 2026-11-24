-- Migration 018: views.daily_summary um Makroziele des Tages erweitert (Aufgabe 040, 24.11.2026).
--
-- Quelle wie beim Kalorienziel: raw.daily_snapshots.data (von der App geschrieben,
-- buildDailySnapshotPayload / calcMacroGoals) -- KEINE Formel-Nachbildung hier, keine
-- Rueckrechnung alter Tage (Daniel 24.11.: "Ältere Tage müssen nicht nachberechnet werden.").
--   ziel_protein_g / ziel_fett_g / ziel_kh_g  <- goal_protein_g / goal_fat_g / goal_carbs_g
--   makro_modell:
--     NULL          Tage vor 2026-11-21 bzw. ohne goal_*-Felder im Snapshot
--     'fix_027'     2026-11-21 .. 2026-11-23: Protein 150 g / Fett 100 g fix, KH = Rest (mind. 3 g/kg)
--     'prozent_040' ab 2026-11-24 (Release 040): Protein 20 % (mind. 1,8 g/kg), Fett 33 %, KH 47 % (Rest)
-- Spalten nur ANGEHAENGT (CREATE OR REPLACE VIEW erlaubt das; bestehende Spalten/Reihenfolge
-- unveraendert). Grant unveraendert (fuelofit_ro SELECT bleibt bei REPLACE erhalten; zur
-- Sicherheit erneut gesetzt, idempotent).
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
    WHEN ds.data->>'goal_protein_g' IS NULL OR ds.day < DATE '2026-11-21' THEN NULL
    WHEN ds.day < DATE '2026-11-24' THEN 'fix_027'
    ELSE 'prozent_040'
  END AS makro_modell
FROM raw.daily_snapshots ds
LEFT JOIN views.body_weight bw ON bw.day = ds.day
WHERE ds.deleted_at IS NULL;

GRANT SELECT ON views.daily_summary TO fuelofit_ro;

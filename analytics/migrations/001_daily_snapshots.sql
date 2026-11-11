-- Migration 001: raw.daily_snapshots + views.daily_summary (Phase 1b, Aufgabe 003c Teil D)
--
-- Idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE VIEW) - fuehrt NICHT das ganze
-- schema.sql erneut aus, nur diese Ergaenzung. Inhalt identisch zum entsprechenden Abschnitt
-- in schema.sql (dort bleibt schema.sql die vollstaendige Referenz fuer einen Neuaufbau).
--
-- Ausfuehrung auf dem VPS: psql -d fuelofit_analytics -f 001_daily_snapshots.sql
-- (als Rolle mit Schreibrecht auf Schema raw/views, z.B. der Postgres-Superuser der Instanz)

CREATE TABLE IF NOT EXISTS raw.daily_snapshots (
  id text PRIMARY KEY,            -- = YYYY-MM-DD (Firestore-Doc-ID, siehe Teil B Aufgabe 003c)
  day date,
  data jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS daily_snapshots_day_idx ON raw.daily_snapshots (day);
CREATE INDEX IF NOT EXISTS daily_snapshots_data_gin ON raw.daily_snapshots USING gin (data);

GRANT SELECT, INSERT, UPDATE ON raw.daily_snapshots TO fuelofit_sync;
-- fuelofit_ro bekommt bewusst KEIN Recht auf raw.* (008b/008b3); die View daily_summary
-- laeuft mit Owner-Rechten. Frueher: GRANT SELECT ON raw.daily_snapshots TO fuelofit_ro;

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
  ds.data->>'appBuild' AS app_build
FROM raw.daily_snapshots ds
LEFT JOIN views.body_weight bw ON bw.day = ds.day
WHERE ds.deleted_at IS NULL;

GRANT SELECT ON views.daily_summary TO fuelofit_ro;

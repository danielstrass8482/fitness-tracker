-- Migration 015: views.zirkel_uebungen - fehlendes mode bei Plan-Zirkel (datenbasis='geplant')
-- faellt wie in der App auf Wiederholungen zurueck (Aufgabe 022b Teil B, Befund 021c: 6 alte
-- Plan-Zirkel 28.09.-09.10.2026 ohne mode -> wdh_soll NULL, 120 Zeilen).
--
-- Gleiche Bedingung wie im App-Code (index.html): normalizePlanUnit (~Zeile 9316) ruft fuer
-- typ='zirkel' IMMER normalizeZirkelUebung(x, 'reps') -- der zweite Parameter ist der
-- legacyModeFallback, der nur greift, wenn x.mode weder 'time' noch 'reps' ist
-- (normalizeZirkelUebung ~Zeile 9269: "Alte Plan-Zirkel kannten nur Wiederholungen (kein
-- mode-Feld) -> Fallback 'reps'"). In DB-Begriffen (Migration 013s Mapping 'reps'->'wdh')
-- heisst das: fehlendes mode bei einer Uebung in geplant_rows (datenbasis='geplant', also OHNE
-- details[]) -> mode='wdh', wdh_soll = ueb.wdh (dasselbe Rohfeld, das Migration 013 auch sonst
-- fuer wdh_soll verwendet). Betrifft NUR geplant_rows -- details_rows (mit echten details[])
-- hatte dieses Problem laut Befund 021c nicht, bleibt unveraendert. Keine Rohdaten geaendert,
-- nur die View-Ableitung.
--
-- Neue Spalte mode_abgeleitet (boolean) AM ENDE angehaengt: true NUR fuer genau diese 120
-- hergeleiteten Faelle (6 Plan-Zirkel, 28.09.-09.10.2026), sonst false.
--
-- Vorher/Nachher geprueft (Bericht 022b): 120 Zeilen (datenbasis='geplant' AND mode IS NULL
-- vorher) bekommen wdh_soll = wdh-Rohwert, mode_abgeleitet=true; EXCEPT-Vergleich der
-- unveraenderten Spalten fuer die uebrigen 375 Zeilen = 0 Differenzen.
--
-- Idempotent (CREATE OR REPLACE VIEW). Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 015_zirkel_uebungen_mode_fallback.sql

CREATE OR REPLACE VIEW views.zirkel_uebungen AS
WITH z AS (
  SELECT
    e.id,
    e.day,
    e.data->>'source' AS quelle,
    NULLIF(e.data->>'runden', '')::int AS zirkel_runden,
    CASE WHEN jsonb_typeof(e.data->'uebungen') = 'array' THEN e.data->'uebungen' END AS uebungen_raw,
    CASE WHEN jsonb_typeof(e.data->'details') = 'array' AND jsonb_array_length(e.data->'details') > 0
         THEN e.data->'details' END AS details_raw,
    split_part(e.id, '_', 1) || '_' || right(e.id, 4) AS zirkel_id
  FROM raw.entries e
  WHERE e.deleted_at IS NULL AND e.data->>'typ' = 'zirkel'
),
ueb AS (
  SELECT
    z.id,
    (u.ord - 1)::int AS idx,
    u.val->>'typ' AS typ,
    trim(COALESCE(u.val->>'variant', '')) AS variant_raw,
    CASE u.val->>'mode' WHEN 'time' THEN 'zeit' WHEN 'reps' THEN 'wdh' END AS mode,
    NULLIF(u.val->>'wdh', '')::int AS wdh,
    NULLIF(u.val->>'holdSec', '')::int AS hold_sec
  FROM z, jsonb_array_elements(z.uebungen_raw) WITH ORDINALITY AS u(val, ord)
  WHERE z.uebungen_raw IS NOT NULL
),
det AS (
  SELECT
    z.id,
    d.ord AS detail_ord,
    NULLIF(d.val->>'round', '')::int AS runde,
    d.val->>'typ' AS typ,
    trim(COALESCE(d.val->>'variant', '')) AS variant_raw,
    CASE d.val->>'mode' WHEN 'time' THEN 'zeit' WHEN 'reps' THEN 'wdh' END AS mode,
    NULLIF(d.val->>'wdh', '')::int AS wdh,
    NULLIF(d.val->>'sec', '')::int AS sec,
    d.val->>'side' AS seite,
    (d.val->>'perSide')::boolean AS per_side_flag,
    CASE WHEN (d.val->'exIdx') IS NOT NULL AND d.val->'exIdx' <> 'null'::jsonb
         THEN (d.val->>'exIdx')::int END AS exidx
  FROM z, jsonb_array_elements(z.details_raw) WITH ORDINALITY AS d(val, ord)
  WHERE z.details_raw IS NOT NULL
),
entry_hasexidx AS (
  SELECT z.id, COALESCE(bool_or(det.exidx IS NOT NULL), false) AS has_exidx
  FROM z LEFT JOIN det ON det.id = z.id
  WHERE z.details_raw IS NOT NULL
  GROUP BY z.id
),
det_ranked AS (
  SELECT det.*,
    ROW_NUMBER() OVER (PARTITION BY det.id, det.runde, det.typ, det.variant_raw ORDER BY det.detail_ord) - 1 AS occ_rank
  FROM det
),
ueb_ranked AS (
  SELECT ueb.*,
    ROW_NUMBER() OVER (PARTITION BY ueb.id, ueb.typ, ueb.variant_raw ORDER BY ueb.idx) - 1 AS occ_rank
  FROM ueb
),
det_slot AS (
  SELECT
    dr.id, dr.detail_ord, dr.runde, dr.typ, dr.variant_raw, dr.mode, dr.wdh, dr.sec, dr.seite,
    dr.per_side_flag,
    CASE WHEN eh.has_exidx THEN dr.exidx ELSE ur.idx END AS slot
  FROM det_ranked dr
  JOIN entry_hasexidx eh ON eh.id = dr.id
  LEFT JOIN ueb_ranked ur
    ON ur.id = dr.id AND ur.typ = dr.typ AND ur.variant_raw = dr.variant_raw AND ur.occ_rank = dr.occ_rank
    AND NOT eh.has_exidx
),
det_full AS (
  SELECT
    ds.id, ds.detail_ord, ds.runde, ds.slot, ds.typ, ds.variant_raw, ds.mode, ds.wdh, ds.sec,
    ds.seite, ds.per_side_flag,
    u2.hold_sec AS matched_hold_sec,
    CASE
      WHEN ds.mode = 'zeit' THEN (ds.sec IS DISTINCT FROM u2.hold_sec)
      WHEN ds.mode = 'wdh' THEN (ds.sec IS DISTINCT FROM ds.wdh * 3 * (CASE WHEN ds.per_side_flag THEN 2 ELSE 1 END))
      ELSE false
    END AS deviates
  FROM det_slot ds
  LEFT JOIN ueb u2 ON u2.id = ds.id AND u2.idx = ds.slot
),
weg_calc AS (
  SELECT id,
    CASE
      WHEN bool_or(deviates) THEN 'timer'
      WHEN bool_or(mode = 'wdh') THEN 'plan_abhaken'
      ELSE 'unbekannt'
    END AS weg
  FROM det_full
  GROUP BY id
),
details_rows AS (
  SELECT
    z.day,
    z.zirkel_id,
    z.quelle,
    wc.weg,
    df.runde,
    df.slot,
    df.typ AS uebung,
    COALESCE(NULLIF(df.variant_raw, ''), 'regulaer') AS variante,
    df.mode,
    df.seite,
    'details'::text AS datenbasis,
    CASE WHEN df.mode = 'wdh' THEN df.wdh END AS wdh_soll,
    CASE WHEN df.mode = 'zeit' THEN df.matched_hold_sec END AS haltezeit_soll_sek,
    df.sec AS dauer_sek,
    z.zirkel_runden,
    false AS mode_abgeleitet
  FROM det_full df
  JOIN z ON z.id = df.id
  JOIN weg_calc wc ON wc.id = df.id
),
geplant_rows AS (
  SELECT
    z.day,
    z.zirkel_id,
    z.quelle,
    'unbekannt'::text AS weg,
    r.runde,
    ueb.idx AS slot,
    ueb.typ AS uebung,
    COALESCE(NULLIF(ueb.variant_raw, ''), 'regulaer') AS variante,
    COALESCE(ueb.mode, 'wdh') AS mode,
    NULL::text AS seite,
    'geplant'::text AS datenbasis,
    CASE WHEN COALESCE(ueb.mode, 'wdh') = 'wdh' THEN ueb.wdh END AS wdh_soll,
    CASE WHEN COALESCE(ueb.mode, 'wdh') = 'zeit' THEN ueb.hold_sec END AS haltezeit_soll_sek,
    NULL::int AS dauer_sek,
    z.zirkel_runden,
    (ueb.mode IS NULL) AS mode_abgeleitet
  FROM z
  JOIN ueb ON ueb.id = z.id
  CROSS JOIN LATERAL generate_series(1, z.zirkel_runden) AS r(runde)
  WHERE z.details_raw IS NULL AND z.zirkel_runden > 0 AND z.uebungen_raw IS NOT NULL
)
SELECT * FROM details_rows
UNION ALL
SELECT * FROM geplant_rows;

GRANT SELECT ON views.zirkel_uebungen TO fuelofit_ro;

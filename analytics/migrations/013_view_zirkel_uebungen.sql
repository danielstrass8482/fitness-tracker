-- Migration 013: views.zirkel_uebungen (Aufgabe 016i, Option C aus Bericht 016g/016h Rueckfrage,
-- Daniels Entscheidung "ich will auf jeden Fall C" 17.11.2026 18:33).
--
-- Grundlage: Bericht 016i Teil A -- Felder/Logik aus index.html (saveZirkelTimer ~11751,
-- planCompleteEntryFromInputs ~10890, calcZirkelEntryKcal ~4311, zirkelEstimateWorkSec ~9279)
-- belegt, hier nicht neu hergeleitet. views.exercise_sets (Migration 012) erfasst typ='zirkel'
-- bewusst NICHT -- diese View ist die Zirkel-Entsprechung, eine Zeile je Runde x Uebungsslot
-- (x Seite bei perSide).
--
-- ===== Zuordnung Detail-Zeile -> Uebungsslot (calcZirkelEntryKcal, wortgleich uebernommen) =====
-- Pro Zirkel-Eintrag: hat irgendeine details[]-Zeile ein exIdx, wird fuer ALLE Zeilen dieses
-- Eintrags exIdx direkt als Slot genommen. Sonst (aeltere Eintraege ohne exIdx): die n-te
-- details-Zeile mit gleichem round+typ+variant (in Array-Reihenfolge) wird dem n-ten uebungen-
-- Slot mit demselben typ+variant zugeordnet (in Array-Reihenfolge, 0-indiziert). Bekannter
-- App-eigener Grenzfall (siehe Audit zu Commit 99f3bc8, Kommentar in calcZirkelEntryKcal): bei
-- Altdaten ohne exIdx UND perSide+mode='time' UND Dublette im selben Zirkel wuerde die
-- Seiten-Aufteilung die Zuordnung verfaelschen -- in den real vorhandenen 12 Alteintraegen ohne
-- exIdx kommt perSide jedoch nicht vor (gepruefter Bestand, Probelauf), daher kein Einfluss.
--
-- ===== weg ('timer' | 'plan_abhaken' | 'unbekannt') =====
-- Das source-Feld unterscheidet NICHT zwischen Live-Timer und Plan-Abhaken -- beide schreiben
-- IMMER source='plan' (saveZirkelTimer Zeile ~11772, planCompleteEntryFromInputs Zeile ~10926).
-- weg wird daher aus der Messsignatur der details[] abgeleitet (Probelauf-belegt, Bericht 016i
-- Teil A Punkt 1/3):
--   - Live-Timer (saveZirkelTimer): bei automatischem Segmentwechsel wird exakt die Soll-Dauer
--     (zirkelSync: zirkelFinishSegment(seg.dur)) als "sec" gespeichert, bei manuellem
--     Ueberspringen (zirkelTimerSkip) die TATSAECHLICH gemessene (kuerzere) Zeit; bei mode 'reps'
--     ("Fertig"-Taste, zirkelTimerRepDone) ist "sec" IMMER echte verstrichene Zeit, nie aus wdh
--     abgeleitet.
--   - Plan-Abhaken (planCompleteEntryFromInputs): "sec" ist IMMER die Schaetzformel
--     zirkelEstimateWorkSec(x) -- bei mode 'time' exakt holdSec, bei mode 'reps' exakt
--     wdh * 3 (ZIRKEL_SEC_PER_WDH), je perSide-reps-Zeile verdoppelt -- NIE gemessen.
-- Daraus: weicht irgendeine details-Zeile des Eintrags von ihrer Soll-Formel ab (mode 'time':
-- sec < holdSec; mode 'reps': sec <> wdh*3*(2 bei perSide-Zeile, sonst 1)), ist das ein
-- Messwert -> weg='timer'. Gibt es mindestens eine 'reps'-Zeile und weicht KEINE Zeile ab (bei
-- echten Menschen ueber mehrere Runden praktisch ausgeschlossen, wenn es nicht exakt diese
-- Formel war), ist das die Plan-Abhaken-Signatur -> weg='plan_abhaken'. Besteht der Eintrag nur
-- aus mode 'time'-Zeilen ohne jede Abweichung, bleibt der Fall unentscheidbar (ein exakt
-- durchgehaltener Timer-Lauf sieht identisch aus wie Plan-Abhaken) -> weg='unbekannt'. Eintraege
-- ohne details[] (datenbasis='geplant') sind grundsaetzlich 'unbekannt' -- sie sind aelter als
-- beide heutigen Speicherwege (Probelauf-belegt: 6 von 6 ohne details liegen vor 10.10.2026,
-- vor exIdx UND vor mode/holdSec/perSide/metClass je Uebung).
-- Bestandsprobe (21 Eintraege mit details, Stand 18.11.2026): ALLE 21 zeigen Abweichung bei
-- mindestens einer 'reps'-Zeile -> ALLE weg='timer'. Kein einziger Eintrag im Bestand ist
-- bisher per Plan-Abhaken fuer Zirkel gespeichert worden (Probelauf-Beleg im Bericht).
--
-- ===== datenbasis='geplant' (Eintraege ohne details[]) =====
-- Zeilen = runden x Anzahl uebungen, OHNE Verdopplung bei perSide: Die App berechnet fuer diesen
-- Fall nur EINEN Schaetzwert je Slot (zirkelEstimateWorkSec multipliziert intern mit sides, OHNE
-- je eine zweite Zeile/Seite zu erzeugen -- die Seiten-Aufteilung in zwei Zeilen gibt es nur in
-- den details[]-Pfaden). Eine Seiten-Verdopplung der Zeilenzahl waere hier neu erfundene Logik,
-- die es in der App nicht gibt -- deshalb bewusst NICHT umgesetzt. seite ist bei 'geplant' daher
-- immer NULL. dauer_sek NULL (keine Messung moeglich). mode kann NULL sein, wenn die Uebung kein
-- mode-Feld hat (sehr alte Eintraege vor der Intensitaetsklassen-Erweiterung, siehe Bestand).
--
-- ===== uebrige Spalten =====
-- wdh_soll: der Zielwert aus uebungen[slot].wdh bzw. details[].wdh (beide identisch, copy bei
-- Speichern) -- NIE ein gezaehlter Ist-Wert. Die App zaehlt bei mode 'reps' nur die verstrichene
-- Zeit, keine Wiederholungen -- es gibt nirgends einen Ist-Wdh-Wert, daher KEINE wdh_ist-Spalte
-- (Auftragsvorgabe Punkt 4, "nur wenn Teil A belegt"). NULL wenn mode <> 'wdh' (wdh-Feld bei
-- mode='time'-Uebungen ein Datenrest aus fruehrem Umschalten, siehe normalizeZirkelUebung).
-- haltezeit_soll_sek: holdSec aus dem zugeordneten uebungen-Slot (steht nicht in details[]
-- selbst). NULL wenn mode <> 'zeit'.
-- dauer_sek: nur bei datenbasis='details' die gemessene/Soll-Zeit aus details[].sec -- siehe
-- weg-Hinweis oben: bei weg='plan_abhaken' ist das TROTZ datenbasis='details' keine Messung,
-- sondern derselbe Schaetzwert wie bei datenbasis='geplant' (deutlicher Hinweis in
-- views_info.json, nicht nur hier).
-- variante: Default 'regulaer' bei leerem/fehlendem Feld (wie Migration 012 fuer exercise_sets).
-- zirkel_id: gleiche Kuerzung wie entry_id in Migration 012 (Praefix vor erstem "_" + letzte 4
-- Zeichen der Original-ID) -- nur Anzeige, kein Schluessel.
--
-- Idempotent (CREATE OR REPLACE VIEW). Ausfuehrung auf dem VPS:
-- psql -d fuelofit_analytics -f 013_view_zirkel_uebungen.sql

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
    z.zirkel_runden
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
    ueb.mode,
    NULL::text AS seite,
    'geplant'::text AS datenbasis,
    CASE WHEN ueb.mode = 'wdh' THEN ueb.wdh END AS wdh_soll,
    CASE WHEN ueb.mode = 'zeit' THEN ueb.hold_sec END AS haltezeit_soll_sek,
    NULL::int AS dauer_sek,
    z.zirkel_runden
  FROM z
  JOIN ueb ON ueb.id = z.id
  CROSS JOIN LATERAL generate_series(1, z.zirkel_runden) AS r(runde)
  WHERE z.details_raw IS NULL AND z.zirkel_runden > 0 AND z.uebungen_raw IS NOT NULL
)
SELECT * FROM details_rows
UNION ALL
SELECT * FROM geplant_rows;

GRANT SELECT ON views.zirkel_uebungen TO fuelofit_ro;

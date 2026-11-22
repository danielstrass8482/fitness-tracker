#!/usr/bin/env node
// 027 + 027b - Makroziele dynamisch: Protein/Fett fix, KH = (Ist-Kalorienziel - 4xP - 9xF)/4,
// Untergrenze 3 g/kg mit Hinweis. 027b (Daniel 22.11.2026): Kalorienziel IMMER Ist (keine Prognose,
// keine Schritt-Annahme); Prognose NUR fuer die Makros aus offenen Plan-Einheiten (100 % KH,
// prognoseAnteilFett = 0). Tagescheck-Kontext + dailySnapshots-Felder. Synthetische Daten, Writes geblockt.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-19T06:00:00.000Z'; // Do 19.11.2026 07:00 Europe/Berlin
const TODAY = '2026-11-19';
const MONDAY = '2026-11-16';
const W = 75.4; // Beispiel 19.11.: 12,51 km, 75,4 kg
const BASE_SETTINGS = { height: 180, age: 35, gender: 'male', weight: W, tdee: 2700, proteinGoal: 150, carbsGoal: 281, fatGoal: 100 };
const U = p => `users/${TEST_UID}/${p}`;
const LAUF = { id: 'u_lauf', typ: 'laufen', typLabel: '', variant: '', distanzKm: 12.51, dauerMin: null, sets: null, pauseSec: null, notiz: 'Long Run' };
const LAUF_KCAL = Math.round(1.04 * 12.51 * W); // 981

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}
function shift(d, n) { const [y, m, dd] = d.split('-').map(Number); const x = new Date(y, m - 1, dd + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }
function store({ settings, plan, entries, garminActivities, stepHistory }) {
  const e = [];
  const s = {
    [U('settings')]: [{ id: 'main', data: settings || BASE_SETTINGS }],
    [U('trainingplans')]: [{ id: MONDAY, data: { datum: MONDAY, mo: e, di: e, mi: e, do: plan || e, fr: e, sa: e, so: e } }],
  };
  if (entries) s[U('entries')] = entries;
  if (garminActivities) s[U('garminActivities')] = garminActivities;
  if (stepHistory) {
    // Vortage mit vielen Schritten, HEUTE keine (morgens vor dem Sync) -> frueher Median-Annahme
    const rows = [];
    for (let i = 1; i <= 14; i++) { const d = shift(TODAY, -i); rows.push({ id: d, data: { date: d, steps: 14000 } }); }
    s[U('garminDaily')] = rows;
  }
  return s;
}
async function start(browser, st) {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__TEST_AI_RESPONSE__ = null; });
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: st });
  return { page, h };
}
const ui = page => page.evaluate(() => ({
  kh: document.getElementById('daily-carbs-goal').textContent,
  fett: document.getElementById('daily-fat-goal').textContent,
  kachel: document.getElementById('daily-kcal-goal').textContent,
  tagebuch: document.getElementById('diary-kcal-line').textContent.replace(/\s+/g, ' ').trim(),
  makro: document.getElementById('diary-macro-line').textContent.replace(/\s+/g, ' ').trim(),
  diff: (document.querySelector('[data-kpi-diff="kcal"]') || {}).textContent || '',
  khDiff: (document.querySelector('[data-kpi-diff="kh"]') || {}).textContent || '',
}));
const de = n => n.toLocaleString('de-DE');
const state = page => page.evaluate((d) => ({ m: window.calcMacroGoals(d), g: window.calcHistoricalKcalGoal(d), act: window.calcHistoricalKcalGoal(d).total, open: window.plannedOpenUnitsKcal(d), legacy: typeof window.expectedDailyGoal }), TODAY);
const snapshot = async page => { const s = await page.evaluate((d) => window.__TEST_WRITES__.filter(w => w.path.endsWith('/dailySnapshots/' + d)).map(w => w.data), TODAY); return s[s.length - 1]; };
const AI_OK = { content: [{ type: 'text', text: JSON.stringify({ status: 'gruen', headline: 'ok', actions: ['x'], reason: 'y', confidence: 'mittel', flags: { illness: false, alcohol: false }, planSuggestion: null }) }], stop_reason: 'end_turn' };
async function dailyCheckCall(page) {
  await page.evaluate((r) => { window.__TEST_AI_RESPONSE__ = r; }, AI_OK);
  await page.evaluate((p) => { window.__TEST_STORE__[p] = [{ id: '2026-11-19', data: { date: '2026-11-19', sleepDurationSec: 25200, sleepScore: 80, readinessScore: 78 } }]; }, U('oura_daily'));
  await page.evaluate(() => window.retryLoadAfterError());
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.setSubjectiveStatus('fit'); window.saveSubjectiveStatusPending(); });
  await page.waitForTimeout(500);
  const calls = await page.evaluate(() => (window.__TEST_AI_CALLS__ || []).filter(c => c.name === 'anthropicProxy'));
  return calls[0] ? { payload: JSON.parse(calls[0].data.messages?.[0]?.content || '{}'), system: calls[0].data.system || '' } : null;
}

async function main() {
  const browser = await chromium.launch();

  // (c) Ruhetag: kein Plan -> Ist-Ziel, keine Prognose. Synthetisch ohne Schritte ~Grundumsatz-Basis -> Fett 80 g,
  // damit die Untergrenze NICHT greift (eigener Fall Untergrenze).
  {
    const { page, h } = await start(browser, store({ settings: { ...BASE_SETTINGS, fatGoal: 80 } }));
    const { m, act, legacy } = await state(page);
    check('(c) Ruhetag: keine Makro-Prognose, kcalGoal = Ist', m.forecast === null && m.kcalGoal === Math.round(act), [m, act]);
    check('(c) Ruhetag: KH = (Ziel - 600 - 720)/4, Untergrenze greift nicht', m.carbs === Math.round((act - 600 - 720) / 4) && m.protein === 150 && m.fat === 80 && !m.floorApplied, m);
    check('Ruhetag: settings.carbsGoal (281) wird nicht verwendet', m.carbs !== 281, m.carbs);
    check('027b: expectedDailyGoal (Schritt-Median) entfernt', legacy === 'undefined', legacy);
    const u = await ui(page);
    check('(c) Ruhetag: nirgends "Prognose"', !/Prognose/.test(u.kh + u.fett + u.kachel + u.tagebuch + u.makro) && u.kh.includes(`Ziel ${de(m.carbs)} g`), u);
    check('(c) Ruhetag: kcal-Kachel/Tagebuch = Ist', u.kachel === `Ziel ${de(m.kcalGoal)} kcal` && u.tagebuch.includes(`/ ${de(m.kcalGoal)} kcal`), u);
    const last = await snapshot(page);
    check('(c) Snapshot: goal_* = Ist, keine Prognosefelder, kein goal_is_forecast', last && last.goal_protein_g === 150 && last.goal_fat_g === 80 && last.goal_carbs_g === m.carbs && !('goal_carbs_forecast_g' in last) && !('goal_fat_forecast_g' in last) && !('goal_is_forecast' in last), last && Object.keys(last).filter(k => k.startsWith('goal')));
    const dc = await dailyCheckCall(page);
    check('(c) Tagescheck: makro_prognose.aktiv=false', dc && dc.payload.makro_prognose && dc.payload.makro_prognose.aktiv === false, dc && dc.payload.makro_prognose);
    check('Ruhetag: keine unbekannten Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }

  // (a)+(d)+(e) Lauftag morgens 12,51 km geplant, noch kein Garmin-Lauf; Vortage 14.000 Schritte, heute 0
  let istCarbs, fcCarbs;
  {
    const { page, h } = await start(browser, store({ plan: [LAUF], stepHistory: true }));
    const { m, g, act, open } = await state(page);
    istCarbs = m.carbs; fcCarbs = m.forecast && m.forecast.carbs;
    console.log(`     Beispiel 19.11.: Lauf 1,04 x 12,51 km x 75,4 kg = ${LAUF_KCAL} kcal -> +${Math.round(LAUF_KCAL / 4)} g KH; Ist-Ziel ${act} kcal, KH ${m.carbs} g -> Prognose ${fcCarbs} g`);
    check('(d) Schritte heute 0 -> Ziel ohne Schritt-kcal (keine Median-Annahme trotz 14.000/Tag Vorgeschichte)', g.daily === 0 && act === g.base + g.activity && g.activity === 0, g);
    check('(a) Kalorienziel = Ist ohne Lauf', m.kcalGoal === Math.round(act), [m.kcalGoal, act]);
    check('(a) offene Plan-Einheit: Lauf = 1,04 x 12,51 x 75,4 = 981 kcal', open.kcal === LAUF_KCAL && LAUF_KCAL === 981 && open.geplant.length === 1, open);
    // Ohne Schritte morgens liegt der Rest (212 g) unter der Untergrenze 3 g/kg (226 g) -> Ist-KH = 226 g
    check('(a) Ist-KH = max((Ist - 600 - 900)/4, 3 g/kg)', m.carbs === Math.max(Math.round((act - 1500) / 4), Math.round(3 * W)), [m.carbs, act]);
    check('(a) Prognose-KH = Ist-KH + 981/4, Fett/Protein unveraendert', m.forecast && m.forecast.carbs === Math.round((act - 1500 + LAUF_KCAL) / 4) && m.forecast.fat === 100 && m.protein === 150 && m.forecast.zusatzKcal === LAUF_KCAL, m.forecast);
    const u = await ui(page);
    check('(a) kcal-Kachel = Ist, kein "(Prognose)"', u.kachel === `Ziel ${de(m.kcalGoal)} kcal`, u.kachel);
    check('(a) Tagebuchzeile kcal = Ist, kein "Prognose"', /^0 \/ [\d.]+ kcal/.test(u.tagebuch) && u.tagebuch.includes(`/ ${de(m.kcalGoal)} kcal`) && !u.tagebuch.includes('Prognose'), u.tagebuch);
    check('(a) kcal-Differenz gegen Ist', u.diff.includes(`−${de(m.kcalGoal)}`), u.diff);
    check('(a) KH-Kachel: "Ziel <Ist> g Kohlenhydrate [· Mindestwert] · mit geplantem Lauf ~<Prognose> g (Prognose)"', u.kh === `Ziel ${de(m.carbs)} g Kohlenhydrate${m.floorApplied ? ' · Mindestwert 3 g/kg' : ''} · mit geplantem Lauf ~${de(fcCarbs)} g (Prognose)`, u.kh);
    check('(a) KH-Differenz gegen Ist-KH', u.khDiff.includes(`−${de(m.carbs)}`), u.khDiff);
    check('(a) Fett-Kachel ohne Prognose (Anteil Fett 0)', u.fett === 'Ziel 100 g Fett', u.fett);
    check('(a) Tagebuch-Makrozeile: KH Ist + Prognosehinweis, sonst keine Prognose', u.makro.includes(`0 / ${de(m.carbs)} g`) && u.makro.includes(`mit geplantem Lauf ~${de(fcCarbs)} g (Prognose)`) && (u.makro.match(/Prognose/g) || []).length === 1, u.makro);
    const last = await snapshot(page);
    check('(a) Snapshot: goal_carbs_g = Ist, goal_carbs_forecast_g/goal_fat_forecast_g gesetzt, kcalGoal.total = Ist', last && last.goal_carbs_g === m.carbs && last.goal_carbs_forecast_g === fcCarbs && last.goal_fat_forecast_g === 100 && !('goal_is_forecast' in last) && Math.round(last.kcalGoal.total) === Math.round(act), last && { c: last.goal_carbs_g, cf: last.goal_carbs_forecast_g, ff: last.goal_fat_forecast_g, t: last.kcalGoal && last.kcalGoal.total });
    if (process.env.SHOT_DIR) {
      await page.evaluate(() => window.switchTab('uebersicht')); await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.SHOT_DIR + '/027b-lauftag-uebersicht.png', fullPage: false });
      await page.evaluate(() => window.switchTab('ernaehrung')); await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.SHOT_DIR + '/027b-lauftag-tagebuch.png', fullPage: false });
    }
    const dc = await dailyCheckCall(page);
    const p = dc ? dc.payload : {};
    check('(e) Tagescheck: makro_prognose aktiv mit KH/Fett + geplanter Lauf', p.makro_prognose && p.makro_prognose.aktiv === true && p.makro_prognose.kohlenhydrate_g === fcCarbs && p.makro_prognose.fett_g === 100 && p.makro_prognose.zusatz_kcal_geplant === LAUF_KCAL && p.makro_prognose.geplante_einheiten[0].kcal === LAUF_KCAL, p.makro_prognose);
    check('(e) Tagescheck: kalorienziel_ist = Ist-Zwischenstand, Schritte gemessen 0', p.kalorienziel_ist && p.kalorienziel_ist.kcal === Math.round(act) && p.kalorienziel_ist.schritte_kcal_gemessen === 0 && /ZWISCHENSTAND/.test(p.kalorienziel_ist.hinweis), p.kalorienziel_ist);
    check('(e) Tagescheck: kein erwartetes Kalorienziel / keine Schritt-Annahme im Payload', !Object.keys(p).some(k => /erwartet|zwischenstand_kcal|prognose_kcal/.test(k)) && !/median|typisch/i.test(JSON.stringify(p)), Object.keys(p));
    check('(e) Tagescheck: makroziele_heute = Ist-Makros', p.makroziele_heute && p.makroziele_heute.kohlenhydrate_g === m.carbs && !('prognose' in p.makroziele_heute), p.makroziele_heute);
    check('(e) System-Prompt: Makro-Prognose + Kohlenhydrate + Zwischenstand, kein erwartetes Tagesziel', dc && /makro_prognose/.test(dc.system) && /Kohlenhydrate/.test(dc.system) && /Zwischenstand/i.test(dc.system) && !/erwartetes_tagesziel/.test(dc.system), dc && dc.system.length);
    check('Lauftag: keine unbekannten Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }

  // (a2) Lauftag ohne Untergrenze (Fett 80 g): Prognose-KH = Ist-KH + 981 kcal / 4 (= +245 g)
  {
    const { page } = await start(browser, store({ settings: { ...BASE_SETTINGS, fatGoal: 80 }, plan: [LAUF] }));
    const { m } = await state(page);
    check('(a2) ohne Untergrenze: Prognose-KH - Ist-KH = 981/4 (±1 Rundung)', !m.floorApplied && m.forecast && Math.abs(m.forecast.carbs - m.carbs - LAUF_KCAL / 4) <= 1 && m.forecast.fat === 80, [m.carbs, m.forecast && m.forecast.carbs]);
    const u = await ui(page);
    check('(a2) KH-Kachel exakt', u.kh === `Ziel ${de(m.carbs)} g Kohlenhydrate · mit geplantem Lauf ~${de(m.forecast.carbs)} g (Prognose)`, u.kh);
    await page.close();
  }

  // (b1) Lauf manuell/aus Plan erfasst -> keine Prognose, Ist-Ziel enthaelt den Lauf
  {
    const ent = [{ id: 'e1', data: { datum: TODAY, typ: 'laufen', source: 'plan', planUnitId: 'u_lauf', distanz: 12.51, zeit: '01:10:00', notiz: 'Long Run' } }];
    const { page } = await start(browser, store({ plan: [LAUF], entries: ent }));
    const { m, g, act, open } = await state(page);
    check('(b) Lauf erfasst: keine offene Plan-Einheit, keine Prognose', open.kcal === 0 && m.forecast === null, [open, m.forecast]);
    check('(b) Lauf erfasst: Ist-Ziel enthaelt den Lauf (981 kcal)', g.activity === LAUF_KCAL && m.kcalGoal === Math.round(act), g);
    check('(b) Lauf erfasst: KH = Prognose von vorher (keine Doppelzaehlung)', m.carbs === fcCarbs && m.carbs > istCarbs, [m.carbs, fcCarbs, istCarbs]);
    const u = await ui(page);
    check('(b) Lauf erfasst: Prognosezeile weg (Kachel/Tagebuch/Makrozeile)', !/Prognose/.test(u.kh + u.fett + u.kachel + u.tagebuch + u.makro), u);
    const last = await snapshot(page);
    check('(b) Snapshot ohne Prognosefelder', last && !('goal_carbs_forecast_g' in last) && last.goal_carbs_g === m.carbs, last && Object.keys(last).filter(k => k.startsWith('goal')));
    await page.close();
  }

  // (b2) Garmin-Lauf erfasst (anderer Eintrag, gleicher typ) ersetzt die Planeinheit
  {
    const ga = [{ id: 'act1', data: { startLocal: TODAY + 'T06:30:00+01:00', garminType: 'running', mappedTyp: 'laufen', steps: 11000, durationSec: 4200, distanceM: 12510, avgHr: 145, maxHr: 165 } }];
    const { page } = await start(browser, store({ plan: [LAUF], garminActivities: ga }));
    const { m, g, open } = await state(page);
    check('(b) Garmin-Lauf erfasst: keine Prognose, Lauf im Ist-Ziel', open.kcal === 0 && m.forecast === null && g.activity > 0, [open, g]);
    check('(b) Garmin-Lauf: kein "Prognose" in der Anzeige', !/Prognose/.test(Object.values(await ui(page)).join(' ')));
    await page.close();
  }

  // Untergrenze 3 g/kg (75,4 kg -> 226 g) greift mit Hinweis
  {
    const { page } = await start(browser, store({ settings: { ...BASE_SETTINGS, proteinGoal: 250, fatGoal: 150 } }));
    const { m, act } = await state(page);
    const rest = Math.round((act - 1000 - 1350) / 4);
    check('Untergrenze: Rest < 226 g', rest < 226, rest);
    check('Untergrenze: KH = 226 g, floorApplied', m.carbs === 226 && m.floorApplied && m.minCarbs === 226, m);
    const u = await ui(page);
    check('Untergrenze: Hinweis in Kachel + Makrozeile, keine Prognose', u.kh.includes('Mindestwert 3 g/kg') && u.makro.includes('Mindestwert 3 g/kg') && !u.makro.includes('Prognose'), u);
    await page.close();
  }

  // Fallback: fatGoal fehlt -> 100 g
  {
    const s = { ...BASE_SETTINGS }; delete s.fatGoal;
    const { page } = await start(browser, store({ settings: s }));
    const { m } = await state(page);
    check('Fallback: ohne fatGoal 100 g', m.fat === 100, m.fat);
    await page.close();
  }

  await browser.close();
  if (!ok) { console.log('FAIL'); process.exit(1); }
  console.log('PASS');
}
main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// 027 - Makroziele dynamisch: Protein/Fett fix, KH = (Tagesziel - 4xP - 9xF)/4, heute mit
// Plan-Prognose (expectedDailyGoal) solange die geplante Einheit nicht erfasst ist; Untergrenze
// 3 g/kg mit Hinweis; Tagescheck-Kontext + dailySnapshots-Felder. Synthetische Daten, Writes geblockt.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-19T06:00:00.000Z'; // Do 19.11.2026 07:00 Europe/Berlin
const TODAY = '2026-11-19';
const MONDAY = '2026-11-16';
const BASE_SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700, proteinGoal: 150, carbsGoal: 281, fatGoal: 100 };
const U = p => `users/${TEST_UID}/${p}`;
const LAUF = { id: 'u_lauf', typ: 'laufen', typLabel: '', variant: '', distanzKm: 12.5, dauerMin: null, sets: null, pauseSec: null, notiz: 'Long Run' };

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}
function store({ settings, plan, entries }) {
  const e = [];
  const s = {
    [U('settings')]: [{ id: 'main', data: settings || BASE_SETTINGS }],
    [U('trainingplans')]: [{ id: MONDAY, data: { datum: MONDAY, mo: e, di: e, mi: e, do: plan || e, fr: e, sa: e, so: e } }],
  };
  if (entries) s[U('entries')] = entries;
  return s;
}
async function start(browser, st) {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__TEST_AI_RESPONSE__ = null; });
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: st });
  return { page, h };
}
const tile = page => page.$eval('#daily-carbs-goal', e => e.textContent);
const kcalUi = page => page.evaluate(() => ({
  kachel: document.getElementById('daily-kcal-goal').textContent,
  tagebuch: document.getElementById('diary-kcal-line').textContent.replace(/\s+/g, ' ').trim(),
  makro: document.getElementById('diary-macro-line').textContent.replace(/\s+/g, ' ').trim(),
  diff: (document.querySelector('[data-kpi-diff="kcal"]') || {}).textContent || '',
  bar: document.getElementById('bar-kcal-label').textContent,
}));
const de = n => n.toLocaleString('de-DE');
const state = page => page.evaluate((d) => ({ m: window.calcMacroGoals(d), act: window.calcHistoricalKcalGoal(d).total, exp: window.expectedDailyGoal(d).total }), TODAY);

async function main() {
  const browser = await chromium.launch();

  // 1) Ruhetag: kein Plan -> tatsaechliches Ziel, keine Prognose. Synthetisch ohne Schritte liegt das
  // Ziel nur bei Grundumsatz-Basis (~2.400) -> Fett hier 80 g, damit die Untergrenze NICHT greift (eigener Fall 4).
  {
    const { page, h } = await start(browser, store({ settings: { ...BASE_SETTINGS, fatGoal: 80 } }));
    const { m, act } = await state(page);
    check('Ruhetag: kein Forecast, kcalGoal = tatsaechliches Ziel', !m.isForecast && m.kcalGoal === Math.round(act), [m, act]);
    check('Ruhetag: KH = (Ziel - 600 - 720)/4, Untergrenze greift nicht', m.carbs === Math.round((act - 600 - 720) / 4) && m.protein === 150 && m.fat === 80 && !m.floorApplied, m);
    check('Ruhetag: settings.carbsGoal (281) wird nicht verwendet', m.carbs !== 281, m.carbs);
    const t = await tile(page);
    check('Ruhetag: Kachel zeigt dynamisches KH-Ziel ohne "Prognose"', t.includes(`Ziel ${m.carbs.toLocaleString('de-DE')} g`) && !t.includes('Prognose'), t);
    const u = await kcalUi(page);
    check('Ruhetag: kcal-Kachel/Tagebuch tatsaechliches Ziel ohne "Prognose"', u.kachel === `Ziel ${de(m.kcalGoal)} kcal` && u.tagebuch.includes(`/ ${de(m.kcalGoal)} kcal`) && !u.tagebuch.includes('Prognose') && !u.makro.includes('Prognose'), u);
    const snap = await page.evaluate((d) => window.__TEST_WRITES__.filter(w => w.path.endsWith('/dailySnapshots/' + d)).map(w => w.data), TODAY);
    const last = snap[snap.length - 1];
    check('Snapshot: goal_protein_g/goal_fat_g/goal_carbs_g/goal_is_forecast geschrieben', last && last.goal_protein_g === 150 && last.goal_fat_g === 80 && last.goal_carbs_g === m.carbs && last.goal_is_forecast === false, last && { p: last.goal_protein_g, f: last.goal_fat_g, c: last.goal_carbs_g, fc: last.goal_is_forecast, n: snap.length });
    check('Ruhetag: keine unbekannten Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }

  // 2) Lauftag 12,5 km geplant, noch nicht erfasst -> Prognose
  let forecastCarbs;
  {
    const { page, h } = await start(browser, store({ plan: [LAUF] }));
    const { m, act, exp } = await state(page);
    forecastCarbs = m.carbs;
    check('Lauftag geplant: Forecast, kcalGoal = expectedDailyGoal', m.isForecast && m.kcalGoal === Math.round(exp) && exp > act, [m, act, exp]);
    check('Lauftag geplant: KH = (Prognose - 600 - 900)/4', m.carbs === Math.round((exp - 1500) / 4), [m.carbs, exp]);
    check('Lauftag geplant: Plan-Lauf = 1,04 x 12,5 x 80 kg in der Prognose', exp - act >= Math.round(1.04 * 12.5 * 80), [exp, act]);
    const t = await tile(page);
    check('Lauftag geplant: Kachel kennzeichnet "(Prognose)"', t.includes('(Prognose)') && t.includes(m.carbs.toLocaleString('de-DE')), t);
    const u = await kcalUi(page);
    check('Lauftag geplant: kcal-Kachel zeigt Prognoseziel "(Prognose)"', u.kachel === `Ziel ${de(m.kcalGoal)} kcal (Prognose)`, u.kachel);
    check('Lauftag geplant: Tagebuchzeile "0 / Prognose kcal (Prognose)"', u.tagebuch.includes(`/ ${de(m.kcalGoal)} kcal (Prognose)`) && !u.tagebuch.includes(de(Math.round(act))), u.tagebuch);
    check('Lauftag geplant: Differenz und Balken gegen Prognose', u.diff.includes(`−${de(m.kcalGoal)}`) && u.bar === '0%', [u.diff, u.bar]);
    check('Lauftag geplant: Tagebuch-Makrozeile KH "Prognose"', /Kohlenhydrate\s*0 \/ [\d.]+ g\s*Prognose/.test(u.makro) && u.makro.includes(`/ ${de(m.carbs)} g`) && !u.makro.includes('Mindestwert'), u.makro);
    check('Lauftag geplant: kcal-Ziel und Makros konsistent (4P+4KH+9F ~ Ziel)', Math.abs(4 * 150 + 4 * m.carbs + 9 * 100 - m.kcalGoal) <= 2, [m.kcalGoal, m.carbs]);
    check('Lauftag geplant: calcHistoricalKcalGoal unveraendert (= tatsaechliches Ziel)', Math.round(act) < m.kcalGoal, [act, m.kcalGoal]);
    const snapL = await page.evaluate((d) => window.__TEST_WRITES__.filter(w => w.path.endsWith('/dailySnapshots/' + d)).map(w => w.data), TODAY);
    const lastL = snapL[snapL.length - 1];
    check('Lauftag geplant: Snapshot kcalGoal.total bleibt tatsaechliches Ziel', lastL && lastL.kcalGoal && Math.round(lastL.kcalGoal.total) === Math.round(act) && lastL.goal_is_forecast === true, lastL && { total: lastL.kcalGoal && lastL.kcalGoal.total, act, n: snapL.length });
    if (process.env.SHOT_DIR) {
      await page.evaluate(() => window.switchTab('uebersicht'));
      await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.SHOT_DIR + '/027-lauftag-prognose-uebersicht.png', fullPage: false });
      await page.evaluate(() => window.switchTab('ernaehrung'));
      await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.SHOT_DIR + '/027-lauftag-prognose-tagebuch.png', fullPage: false });
    }
    // Tagescheck-Kontext
    await page.evaluate(() => { window.__TEST_AI_RESPONSE__ = { content: [{ type: 'text', text: JSON.stringify({ status: 'gruen', headline: 'ok', actions: ['x'], reason: 'y', confidence: 'mittel', flags: { illness: false, alcohol: false }, planSuggestion: null }) }], stop_reason: 'end_turn' }; });
    await page.evaluate((p) => { window.__TEST_STORE__[p] = [{ id: '2026-11-19', data: { date: '2026-11-19', sleepDurationSec: 25200, sleepScore: 80, readinessScore: 78 } }]; }, U('oura_daily'));
    await page.evaluate(() => window.retryLoadAfterError());
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.setSubjectiveStatus('fit'); window.saveSubjectiveStatusPending(); });
    await page.waitForTimeout(500);
    const calls = await page.evaluate(() => (window.__TEST_AI_CALLS__ || []).filter(c => c.name === 'anthropicProxy'));
    const payload = calls[0] ? JSON.parse(calls[0].data.messages?.[0]?.content || '{}') : {};
    const mz = payload.makroziele_heute;
    check('Tagescheck: makroziele_heute mit Prognose-KH', mz && mz.kohlenhydrate_g === m.carbs && mz.prognose === true && mz.protein_g === 150 && mz.fett_g === 100 && /PROGNOSE/.test(mz.hinweis), mz || calls.length);
    check('Lauftag: keine unbekannten Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }

  // 3) Prognose -> echte Aktivitaet: Lauf erfasst -> tatsaechliches Ziel, kein Forecast
  {
    const ent = [{ id: 'e1', data: { datum: TODAY, typ: 'laufen', source: 'plan', planUnitId: 'u_lauf', distanz: 12.5, zeit: '01:10:00', notiz: 'Long Run' } }];
    const { page } = await start(browser, store({ plan: [LAUF], entries: ent }));
    const { m, act } = await state(page);
    check('Lauf erfasst: kein Forecast, kcalGoal = tatsaechliches Ziel inkl. Lauf', !m.isForecast && m.kcalGoal === Math.round(act), [m, act]);
    check('Lauf erfasst: KH = (Ziel - 1500)/4', m.carbs === Math.round((act - 1500) / 4), m.carbs);
    check('Lauf erfasst: Kachel ohne "(Prognose)"', !(await tile(page)).includes('Prognose'), await tile(page));
    const u = await kcalUi(page);
    check('Lauf erfasst: kcal-Kachel/Tagebuch/Makrozeile ohne Kennzeichnung', u.kachel === `Ziel ${de(m.kcalGoal)} kcal` && u.tagebuch.includes(`/ ${de(m.kcalGoal)} kcal`) && !u.tagebuch.includes('Prognose') && !u.makro.includes('Prognose'), u);
    console.log(`     Prognose-KH ${forecastCarbs} g -> erfasst ${m.carbs} g (Differenz = Schritt-Median, hier 0 ohne Schrittdaten)`);
    await page.close();
  }

  // 4) Untergrenze 3 g/kg (80 kg -> 240 g) greift mit Hinweis
  {
    const { page } = await start(browser, store({ settings: { ...BASE_SETTINGS, proteinGoal: 250, fatGoal: 150 } }));
    const { m, act } = await state(page);
    const rest = Math.round((act - 1000 - 1350) / 4);
    check('Untergrenze: Rest < 240 g', rest < 240, rest);
    check('Untergrenze: KH = 240 g, floorApplied', m.carbs === 240 && m.floorApplied && m.minCarbs === 240, m);
    const t = await tile(page);
    check('Untergrenze: Hinweis in der Kachel', t.includes('Mindestwert 3 g/kg'), t);
    const u = await kcalUi(page);
    check('Untergrenze: Tagebuch-Makrozeile KH "Mindestwert 3 g/kg"', u.makro.includes('Mindestwert 3 g/kg') && !u.makro.includes('Prognose'), u.makro);
    await page.close();
  }

  // 5) Fallbacks: fatGoal fehlt -> 100 g
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

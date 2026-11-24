#!/usr/bin/env node
// 040 - Makroziele als feste Anteile des Tages-Kalorienziels (Daniel 24.11.2026): Protein 20 %,
// Fett 33 %, KH 47 % (Rest), Protein mind. 1,8 g/kg (Mehr-kcal gehen von den KH ab); Summe = Ziel
// bis auf Rundung (<= 2 kcal). Makro-Prognose (offene Plan-Einheiten, nur heute) nach demselben
// Modell auf (Ziel + Zusatz-kcal). Fett-Hinweis (> 35 % der aufgenommenen kcal; heute erst ab 50 %
// des Ziels erfasst). Ersetzt run-027-makroziele.js (027/027b-Modell). Synthetische Daten, Writes geblockt.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-19T06:00:00.000Z'; // Do 19.11.2026 07:00 Europe/Berlin
const TODAY = '2026-11-19';
const MONDAY = '2026-11-16';
const W = 75.4;
// Alt-Makrofelder bewusst gesetzt: duerfen NICHT mehr wirken
const BASE_SETTINGS = { height: 180, age: 35, gender: 'male', weight: W, tdee: 2700, proteinGoal: 150, carbsGoal: 281, fatGoal: 100 };
const U = p => `users/${TEST_UID}/${p}`;
const LAUF = { id: 'u_lauf', typ: 'laufen', typLabel: '', variant: '', distanzKm: 12.51, dauerMin: null, sets: null, pauseSec: null, notiz: 'Long Run' };
const LAUF_KCAL = Math.round(1.04 * 12.51 * W); // 981

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}
// Referenzmodell (unabhaengig von index.html)
function ref(G, w) {
  const P = Math.round(Math.max(0.20 * G / 4, 1.8 * w));
  const F = Math.round(0.33 * G / 9);
  const C = Math.round((G - 4 * P - 9 * F) / 4);
  return { protein: P, fat: F, carbs: C, proteinFloorApplied: 1.8 * w > 0.20 * G / 4 };
}
const log = (id, date, kcal, fat, carbs, protein) => ({ id, data: { id, name: 'Test ' + id, foodId: 'f_' + id, date, datum: date, meal: 'Mittags', amount: 100, kcal, protein: protein || 0, carbs: carbs || 0, fat, time: '12:00' } });
function store({ settings, plan, entries, logEntries }) {
  const e = [];
  const s = {
    [U('settings')]: [{ id: 'main', data: settings || BASE_SETTINGS }],
    [U('trainingplans')]: [{ id: MONDAY, data: { datum: MONDAY, mo: e, di: e, mi: e, do: plan || e, fr: e, sa: e, so: e } }],
  };
  if (entries) s[U('entries')] = entries;
  if (logEntries) s[U('logEntries')] = logEntries;
  return s;
}
async function start(browser, st) {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__TEST_AI_RESPONSE__ = null; });
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: st });
  return { page, h };
}
const ui = page => page.evaluate(() => ({
  p: document.getElementById('daily-protein-goal').textContent,
  kh: document.getElementById('daily-carbs-goal').textContent,
  fett: document.getElementById('daily-fat-goal').textContent,
  kachel: document.getElementById('daily-kcal-goal').textContent,
  makro: document.getElementById('diary-macro-line').textContent.replace(/\s+/g, ' ').trim(),
  fatHint: (() => { const e = document.getElementById('diary-fat-hint'); return { display: e.style.display, text: e.textContent }; })(),
}));
const de = n => n.toLocaleString('de-DE');
const state = (page, d = TODAY) => page.evaluate((d) => ({ m: window.calcMacroGoals(d), g: window.calcHistoricalKcalGoal(d), open: window.plannedOpenUnitsKcal(d) }), d);
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
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

async function main() {
  const browser = await chromium.launch();

  // (1) Kontrollwerte + Summenprobe (macroSplit aus index.html, Gewicht fix 75,4)
  {
    const { page, h } = await start(browser, store({}));
    const r = await page.evaluate((W) => [3710, 3060, 2500].map(G => ({ G, ...window.macroSplit(G, W) })), W);
    const [a, b, c] = r;
    console.log('     Kontrollwerte:', JSON.stringify(r));
    check('3.710 kcal -> 186 P / 136 F / 436 C (±2 g)', near(a.protein, 186) && near(a.fat, 136) && near(a.carbs, 436) && !a.proteinFloorApplied, a);
    check('3.060 kcal -> 153 / 112 / 360 (±2 g)', near(b.protein, 153) && near(b.fat, 112) && near(b.carbs, 360) && !b.proteinFloorApplied, b);
    check('2.500 kcal -> P 136 (Untergrenze 1,8 x 75,4 = 135,7 greift), F 92, C Rest', c.protein === 136 && c.proteinFloorApplied && c.fat === 92 && c.carbs === Math.round((2500 - 544 - 828) / 4), c);
    // 50 zufaellige G in 1.800-4.500 (fester Seed -> reproduzierbar)
    let seed = 40; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const Gs = Array.from({ length: 50 }, () => 1800 + Math.round(rnd() * 2700));
    const res = await page.evaluate(({ Gs, W }) => Gs.map(G => ({ G, ...window.macroSplit(G, W) })), { Gs, W });
    const devs = res.map(x => 4 * x.protein + 9 * x.fat + 4 * x.carbs - x.G);
    const refOk = res.every(x => { const q = ref(x.G, W); return q.protein === x.protein && q.fat === x.fat && q.carbs === x.carbs && q.proteinFloorApplied === x.proteinFloorApplied; });
    console.log(`     Summenprobe 50 G: Abweichung 4P+9F+4C-G min ${Math.min(...devs)} / max ${Math.max(...devs)} kcal; Untergrenze aktiv in ${res.filter(x => x.proteinFloorApplied).length}/50`);
    check('Summe 4P+9F+4C = G (|Abweichung| <= 2 kcal) fuer 50 zufaellige G', devs.every(d => Math.abs(d) <= 2), devs);
    check('macroSplit = Referenzformel fuer alle 50 G', refOk);
    check('Protein >= 1,8 g/kg (gerundet) fuer alle 50 G', res.every(x => x.protein >= Math.round(1.8 * W)));
    check('Konsole sauber', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }

  // (2) Ruhetag (kein Plan, kein Training): niedriges Ziel -> Protein-Untergrenze aktiv, Hinweis in Kachel + Tagebuch
  {
    const { page, h } = await start(browser, store({}));
    const { m, g } = await state(page);
    const r = ref(g.total, W);
    console.log(`     Ruhetag: Ziel ${g.total} kcal -> P ${m.protein} / F ${m.fat} / KH ${m.carbs}`);
    check('Ruhetag: calcMacroGoals = Referenzmodell auf calcHistoricalKcalGoal.total', m.protein === r.protein && m.fat === r.fat && m.carbs === r.carbs && m.kcalGoal === Math.round(g.total), [m, r]);
    check('Ruhetag: Alt-Settings (P 150 / F 100) wirken nicht', m.protein !== 150 && m.fat !== 100, m);
    check('Ruhetag: Protein-Untergrenze aktiv (niedriges Ziel)', m.proteinFloorApplied && m.protein === Math.round(1.8 * W), m);
    check('Ruhetag: keine Prognose', m.forecast === null);
    const u = await ui(page);
    check('Ruhetag: Kacheln zeigen neue Ziele', u.p === `Ziel ${de(m.protein)} g Protein · Mindestwert 1,8 g/kg` && u.kh === `Ziel ${de(m.carbs)} g Kohlenhydrate` && u.fett === `Ziel ${de(m.fat)} g Fett`, u);
    check('Ruhetag: Tagebuch-Makrozeile mit Zielen + Untergrenze-Hinweis, keine Prognose', u.makro.includes(`0 / ${de(m.protein)} g`) && u.makro.includes(`0 / ${de(m.carbs)} g`) && u.makro.includes(`0 / ${de(m.fat)} g`) && u.makro.includes('Mindestwert 1,8 g/kg') && !u.makro.includes('Prognose'), u.makro);
    const last = await snapshot(page);
    check('Ruhetag: Snapshot goal_* = neue Ziele, keine Prognosefelder', last && last.goal_protein_g === m.protein && last.goal_fat_g === m.fat && last.goal_carbs_g === m.carbs && !Object.keys(last).some(k => /forecast/.test(k)), last && Object.fromEntries(Object.entries(last).filter(([k]) => k.startsWith('goal'))));
    if (process.env.SHOT_DIR) {
      await page.evaluate(() => window.switchTab('uebersicht')); await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.SHOT_DIR + '/040-ruhetag-uebersicht.png' });
    }
    check('Ruhetag: Konsole sauber', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }

  // (3) Trainingstag: Lauf erfasst (aus Plan) -> hoeheres Ziel, Untergrenze greift nicht, keine Prognose
  {
    const ent = [{ id: 'e1', data: { datum: TODAY, typ: 'laufen', source: 'plan', planUnitId: 'u_lauf', distanz: 12.51, zeit: '01:10:00', notiz: 'Long Run' } }];
    const { page } = await start(browser, store({ plan: [LAUF], entries: ent }));
    const { m, g, open } = await state(page);
    const r = ref(g.total, W);
    console.log(`     Trainingstag: Ziel ${g.total} kcal (Aktivitaet ${g.activity}) -> P ${m.protein} / F ${m.fat} / KH ${m.carbs}`);
    check('Trainingstag: Lauf im Ist-Ziel, keine offene Einheit/Prognose', g.activity === LAUF_KCAL && open.kcal === 0 && m.forecast === null, [g, open]);
    check('Trainingstag: = Referenzmodell, Untergrenze greift nicht', m.protein === r.protein && m.fat === r.fat && m.carbs === r.carbs && !m.proteinFloorApplied, [m, r]);
    const u = await ui(page);
    check('Trainingstag: Kacheln zeigen neue Ziele ohne Hinweise', u.p === `Ziel ${de(m.protein)} g Protein` && u.kh === `Ziel ${de(m.carbs)} g Kohlenhydrate` && u.fett === `Ziel ${de(m.fat)} g Fett`, u);
    if (process.env.SHOT_DIR) {
      await page.evaluate(() => window.switchTab('uebersicht')); await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.SHOT_DIR + '/040-trainingstag-uebersicht.png' });
    }
    await page.close();
  }

  // (4) Prognose: Lauf geplant, noch offen -> Prognose = Modell auf (Ziel + 981 kcal), auf alle Makros verteilt
  {
    const { page, h } = await start(browser, store({ plan: [LAUF] }));
    const { m, g, open } = await state(page);
    const fr = ref(g.total + LAUF_KCAL, W);
    console.log(`     Prognose: Ist ${g.total} + ${open.kcal} kcal -> P ${m.forecast && m.forecast.protein} / F ${m.forecast && m.forecast.fat} / KH ${m.forecast && m.forecast.carbs}`);
    check('Prognose: offene Einheit 981 kcal', open.kcal === LAUF_KCAL, open);
    check('Prognose: goal = Ist-Modell, forecast = Modell auf (Ist + 981)', m.forecast && m.forecast.protein === fr.protein && m.forecast.fat === fr.fat && m.forecast.carbs === fr.carbs && m.forecast.zusatzKcal === LAUF_KCAL && m.carbs === ref(g.total, W).carbs, [m, fr]);
    check('Prognose: verteilt auf Fett und KH (nicht 100 % KH)', m.forecast.fat > m.fat && m.forecast.carbs > m.carbs, m.forecast);
    const u = await ui(page);
    const lbl = v => ` · mit geplantem Lauf ~${de(v)} g (Prognose)`;
    check('Prognose: KH-/Fett-Kachel mit Prognose', u.kh === `Ziel ${de(m.carbs)} g Kohlenhydrate${lbl(m.forecast.carbs)}` && u.fett === `Ziel ${de(m.fat)} g Fett${lbl(m.forecast.fat)}`, u);
    check('Prognose: Protein-Kachel mit Prognose nur, wenn Prognose-Protein hoeher', m.forecast.protein > m.protein ? u.p.endsWith(lbl(m.forecast.protein)) : !u.p.includes('Prognose'), u.p);
    check('Prognose: kcal-Kachel = Ist', u.kachel === `Ziel ${de(m.kcalGoal)} kcal`, u.kachel);
    const nFc = (u.makro.match(/Prognose/g) || []).length;
    check('Prognose: Tagebuch-Makrozeile zeigt Prognose je erhoehtem Makro', nFc === [m.forecast.protein > m.protein, m.forecast.carbs > m.carbs, m.forecast.fat > m.fat].filter(Boolean).length, u.makro);
    const last = await snapshot(page);
    check('Prognose: Snapshot goal_* = Ist, goal_{protein,carbs,fat}_forecast_g gesetzt', last && last.goal_protein_g === m.protein && last.goal_carbs_g === m.carbs && last.goal_fat_g === m.fat && last.goal_protein_forecast_g === fr.protein && last.goal_carbs_forecast_g === fr.carbs && last.goal_fat_forecast_g === fr.fat, last && Object.fromEntries(Object.entries(last).filter(([k]) => k.startsWith('goal'))));
    if (process.env.SHOT_DIR) {
      await page.evaluate(() => window.switchTab('uebersicht')); await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.SHOT_DIR + '/040-prognose-uebersicht.png' });
    }
    const dc = await dailyCheckCall(page);
    const p = dc ? dc.payload : {};
    check('Tagescheck: makroziele_heute = Ist-Makros (Prozentmodell) + Untergrenze-Flag', p.makroziele_heute && p.makroziele_heute.protein_g === m.protein && p.makroziele_heute.fett_g === m.fat && p.makroziele_heute.kohlenhydrate_g === m.carbs && p.makroziele_heute.protein_untergrenze_aktiv === m.proteinFloorApplied && /20 %/.test(p.makroziele_heute.hinweis) && /1\.8 g\/kg/.test(p.makroziele_heute.hinweis), p.makroziele_heute);
    check('Tagescheck: makro_prognose verteilt auf alle Makros', p.makro_prognose && p.makro_prognose.aktiv === true && p.makro_prognose.protein_g === fr.protein && p.makro_prognose.fett_g === fr.fat && p.makro_prognose.kohlenhydrate_g === fr.carbs && /Prozentmodell/.test(p.makro_prognose.hinweis), p.makro_prognose);
    check('Prognose/Tagescheck: Konsole sauber', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }

  // (5) Fett-Hinweis: Vortag 36 % -> Hinweis; Vorvortag 30 % -> keiner; heute 45 % aber < 50 % des Ziels erfasst -> keiner
  {
    const logs = [log('a', '2026-11-18', 1000, 40), log('b', '2026-11-17', 1000, 30, 150, 25), log('c', TODAY, 800, 40)];
    const { page, h } = await start(browser, store({ logEntries: logs }));
    await page.evaluate(() => window.switchTab('ernaehrung')); await page.waitForTimeout(200);
    const t = await ui(page);
    const g = (await state(page)).g.total;
    check(`heute 800 kcal < 50 % von ${g} kcal, Fett 45 % -> kein Hinweis`, 800 < 0.5 * g && t.fatHint.display === 'none' && t.fatHint.text === '', t.fatHint);
    await page.evaluate(() => window.changeDate(-1)); await page.waitForTimeout(250);
    const y = await ui(page);
    check('Vortag 36 % -> "Fettanteil 36 % (über 35 %)"', y.fatHint.display === 'block' && y.fatHint.text === 'Fettanteil 36 % (über 35 %)', y.fatHint);
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/040-fetthinweis-vortag.png' });
    const ym = await state(page, '2026-11-18');
    check('Vortag: Ziele/Farben unberuehrt vom Hinweis (Ziele = Modell)', ym.m.fat === ref(ym.g.total, W).fat, ym.m);
    await page.evaluate(() => window.changeDate(-1)); await page.waitForTimeout(250);
    const v = await ui(page);
    check('Vorvortag 30 % -> kein Hinweis', v.fatHint.display === 'none', v.fatHint);
    check('Fett-Hinweis: Konsole sauber', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }
  // (5b) heute >= 50 % des Ziels erfasst, Fett 40,5 % -> "Fettanteil heute 41 % (über 35 %)"
  {
    const { page } = await start(browser, store({ logEntries: [log('d', TODAY, 2000, 90)] }));
    await page.evaluate(() => window.switchTab('ernaehrung')); await page.waitForTimeout(200);
    const g = (await state(page)).g.total;
    const t = await ui(page);
    check(`heute 2.000 kcal >= 50 % von ${g} kcal, Fett 40,5 % -> Hinweis "Fettanteil heute 41 % (über 35 %)"`, 2000 >= 0.5 * g && t.fatHint.display === 'block' && t.fatHint.text === 'Fettanteil heute 41 % (über 35 %)', t.fatHint);
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/040-fetthinweis-heute.png' });
    await page.close();
  }

  // (6) Gewicht aus Tageslog (weightForDate) bestimmt die Protein-Untergrenze
  {
    const ent = [{ id: 'log_20261118', data: { id: 'log_20261118', datum: '2026-11-18', typ: 'tageslog', weight: 90 } }];
    const { page } = await start(browser, store({ entries: ent }));
    const { m } = await state(page);
    check('Untergrenze mit Tageslog-Gewicht 90 kg = 162 g', m.weight === 90 && m.protein === 162 && m.proteinFloorApplied, m);
    await page.close();
  }

  await browser.close();
  if (!ok) { console.log('FAIL'); process.exit(1); }
  console.log('PASS');
}
main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// 055 - Workout-Builder: angezeigte Woche + 2 Folgewochen in einem Durchgang aendern.
// Playwright gegen die ECHTE index.html, Auth/Firestore gestubbt (synthetische Daten, wie
// 023a2/034/051), Viewport 360, KI-Antwort gestubbt. Schreibzugriffe werden NICHT persistiert,
// nur mit Payload in window.__TEST_WRITES__ protokolliert (und hier ausgegeben).
// Faelle (Aufgabe 055 "Tests"): a) nur W0+1 ab; b) W0+2 nur; c) W0 nur + W0+1 ab; c2) W0 ab +
// W0+1 nur (Fortwirkung); d) bestehende Version W0+2 + W0+1 ab (Hinweis); e) Undo aller Gruppen;
// g) KW ausserhalb / Vergangenheit abgelehnt; p) pausierte Uebung in Folgewoche gefiltert.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED = '2026-11-23T07:00:00.000Z'; // Mo 23.11.2026 08:00 Berlin, KW48
const W0 = '2026-11-23', W1 = '2026-11-30', W2 = '2026-12-07', W3 = '2026-12-14';
const U = p => `users/${TEST_UID}/${p}`;
const planCol = m => U('trainingplans/' + m);
const lauf = (id, notiz) => ({ id, typ: 'laufen', typLabel: '', variant: '', distanzKm: 5, dauerMin: null, sets: null, pauseSec: null, notiz });
const verDoc = (m, tag) => ({ id: m, data: { datum: m, mo: [lauf('u_mo', tag + '-MO')], di: [lauf('u_di', tag + '-DI')], mi: [], do: [], fr: [], sa: [], so: [] } });
const store = (extra = [], settingsExtra = []) => ({
  [U('settings')]: [{ id: 'main', data: { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 } }, ...settingsExtra],
  [U('trainingplans')]: [verDoc('2026-11-02', 'BASE'), verDoc(W0, 'CUR'), ...extra],
});

let ok = true;
const check = (n, c, d) => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; };
const planWrites = async page => (await page.evaluate(() => window.__TEST_WRITES__ || []))
  .filter(w => w.path.includes('/trainingplans/'))
  .map(w => ({ type: w.type, path: w.path.replace(TEST_UID, '{uid}'), data: w.data ? (({ updatedAt, ...r }) => r)(w.data) : undefined }));
const short = ws => ws.map(w => ({ type: w.type, week: w.path.split('/').pop(), mo: w.data?.mo?.map(u => u.notiz), di: w.data?.di?.map(u => u.notiz) }));
const pathOf = m => planCol(m).replace(TEST_UID, '{uid}');

async function runBuilder(page, aiJson, text) {
  await page.evaluate(() => { window.switchTab('training'); window.shiftPlanWeek(0); window.renderTrainingPlan(true); });
  await page.evaluate(() => window.openWorkoutBuilder());
  await page.evaluate(r => { window.__TEST_AI_RESPONSE__ = { content: [{ type: 'text', text: JSON.stringify(r) }], stop_reason: 'end_turn' }; }, aiJson);
  await page.fill('#workout-builder-text', text);
  await page.evaluate(() => window.generateWorkoutBuilderSuggestion());
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__TEST_WRITES__ = []; });
}
async function apply(page) { await page.click('#workout-builder-apply-btn'); await page.waitForTimeout(150); return planWrites(page); }
async function undo(page) { await page.evaluate(() => { window.__TEST_WRITES__ = []; }); await page.evaluate(() => window.undoPlanSave()); await page.waitForTimeout(150); return planWrites(page); }
const upd = (week, day, unitId, notiz) => ({ week, op: 'update', day, unitId, unit: lauf(unitId, notiz) });
const allPayloads = {};

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async st => { const page = await browser.newPage(); const h = await installHarness(page, { fixedTimeIso: FIXED, store: st }); errors.push(h.consoleErrors); return page; };

  // a) nur W0+1 "ab" waehrend W0 angezeigt
  {
    const page = await newPage(store());
    await runBuilder(page, { summary: 'Ab KW49 Mo 8 km', changes: [upd(W1, 'Mo', 'u_mo', 'A-KW49-MO')], gueltigkeit: { [W1]: 'ab_dieser_woche' }, questions: [] }, 'ab nächster Woche Montag 8 km');
    const payload = await page.evaluate(() => JSON.parse(window.__TEST_AI_CALLS__[0].data.messages[0].content));
    check('Payload: wochen = KW48/49/50 mit Montag', JSON.stringify(payload.wochen.map(w => [w.montag, w.kw])) === JSON.stringify([[W0, 48], [W1, 49], [W2, 50]]), payload.wochen.map(w => [w.montag, w.kw]));
    check('Payload: Folgewochen mit plan, angezeigte Woche in aktueller_plan', !!payload.wochen[1].plan && !!payload.wochen[2].plan && !('plan' in payload.wochen[0]) && payload.aktueller_plan.mo[0].notiz === 'CUR-MO', payload.wochen.map(w => !!w.plan));
    check('Payload: eigene_version nur KW48', JSON.stringify(payload.wochen.map(w => w.eigene_version)) === '[true,false,false]', payload.wochen.map(w => w.eigene_version));
    const head = await page.$$eval('.wb-week-head', els => els.map(e => e.textContent.trim()));
    check('Vorschau: Gruppe "KW 49 (30.11.–06.12.) – ab dieser Woche dauerhaft"', head.length === 1 && head[0] === 'KW 49 (30.11.–06.12.) – ab dieser Woche dauerhaft', head);
    const ws = await apply(page); allPayloads.a = ws;
    check('a) genau 1 Plan-Schreibzugriff: KW49 (neu), KW48 unberuehrt', ws.length === 1 && ws[0].path === pathOf(W1) && ws[0].data.mo[0].notiz === 'A-KW49-MO' && ws[0].data.di[0].notiz === 'CUR-DI', short(ws));
    await page.close();
  }

  // b) W0+2 "nur" -> eigene Version KW50 + Kontinuitaet KW51
  {
    const page = await newPage(store());
    await runBuilder(page, { summary: 'Nur KW50', changes: [upd(W2, 'Di', 'u_di', 'B-KW50-DI')], gueltigkeit: { [W2]: 'nur_diese_woche' }, questions: [] }, 'nur in KW 50 Dienstag anders');
    const ws = await apply(page); allPayloads.b = ws;
    check('b) KW50 eigene Version mit Aenderung + KW51 Kontinuitaet mit bisherigem Inhalt, sonst nichts',
      ws.length === 2 && ws[0].path === pathOf(W2) && ws[0].data.di[0].notiz === 'B-KW50-DI' && ws[1].path === pathOf(W3) && ws[1].data.di[0].notiz === 'CUR-DI', short(ws));
    const u = await undo(page); allPayloads.b_undo = u;
    check('e) Undo b: KW50 und KW51 geloescht', u.length === 2 && u.every(w => w.type === 'delete') && u.map(w => w.path).join() === [pathOf(W2), pathOf(W3)].join(), short(u));
    await page.close();
  }

  // c) W0 nur + W0+1 ab in einem Durchgang
  {
    const page = await newPage(store());
    await runBuilder(page, { summary: 'KW48 nur, ab KW49 dauerhaft', changes: [upd(W0, 'Mo', 'u_mo', 'C-KW48-NUR'), upd(W1, 'Di', 'u_di', 'C-AB-KW49')],
      gueltigkeit: { [W0]: 'nur_diese_woche', [W1]: 'ab_dieser_woche' }, questions: [] }, 'diese Woche nur Montag anders, ab nächster Woche Dienstag dauerhaft');
    const head = await page.$$eval('.wb-week-head', els => els.map(e => e.textContent.trim()));
    check('c) Vorschau: 2 Gruppen nach KW', JSON.stringify(head) === JSON.stringify(['KW 48 (23.11.–29.11.) – nur diese Woche', 'KW 49 (30.11.–06.12.) – ab dieser Woche dauerhaft']), head);
    const globalHidden = await page.$eval('#workout-builder-validity-block', el => el.style.display);
    const groupBtns = await page.$$eval('.wb-week-group', gs => gs.map(g => g.querySelectorAll('[data-wb-scope]').length));
    check('c) mehrere Gruppen: globale Gueltigkeit ausgeblendet, je Gruppe Buttons (KW48 inkl. "Nur heute": 3, KW49: 2)', globalHidden === 'none' && JSON.stringify(groupBtns) === '[3,2]', { globalHidden, groupBtns });
    // Gueltigkeit je Gruppe umstellbar (und zurueck)
    await page.click(`.wb-week-group[data-wb-week="${W1}"] [data-wb-scope="nur_diese_woche"]`);
    const head2 = await page.$$eval('.wb-week-head', els => els.map(e => e.textContent.trim()));
    check('c) KW49-Gruppe auf "nur diese Woche" umstellbar', head2[1].endsWith('nur diese Woche') && head2[0].endsWith('nur diese Woche'), head2);
    await page.click(`.wb-week-group[data-wb-week="${W1}"] [data-wb-scope="ab_dieser_woche"]`);
    const ws = await apply(page); allPayloads.c = ws;
    check('c) genau 2 Schreibzugriffe: KW48 eigene Version, KW49 neue Dauer-Version (keine Kontinuitaet ueber KW49)',
      ws.length === 2 && ws[0].path === pathOf(W0) && ws[1].path === pathOf(W1), short(ws));
    check('c) KW48: Mo geaendert, Di wie vorher', ws[0]?.data.mo[0].notiz === 'C-KW48-NUR' && ws[0]?.data.di[0].notiz === 'CUR-DI', short(ws));
    check('c) KW49: Di geaendert, Mo = bisheriger Inhalt (KW48-nur wirkt nicht weiter)', ws[1]?.data.di[0].notiz === 'C-AB-KW49' && ws[1]?.data.mo[0].notiz === 'CUR-MO', short(ws));
    const bar = await page.$eval('#plan-save-undo-bar', el => el.style.display);
    check('e) eine Undo-Leiste fuer beide Gruppen', bar === 'flex', bar);
    const u = await undo(page); allPayloads.c_undo = u;
    check('e) Undo c: KW48 auf vorherigen Inhalt zurueckgeschrieben, KW49 geloescht',
      u.length === 2 && u[0].type === 'set' && u[0].path === pathOf(W0) && u[0].data.mo[0].notiz === 'CUR-MO' && u[1].type === 'delete' && u[1].path === pathOf(W1), short(u));
    await page.close();
  }

  // c2) W0 ab + W0+1 nur: KW49 baut auf der KW48-Aenderung auf, Kontinuitaet KW50 = KW48-neu
  {
    const page = await newPage(store());
    await runBuilder(page, { summary: 'ab KW48 Mo, nur KW49 Di', changes: [upd(W0, 'Mo', 'u_mo', 'C2-AB-KW48'), upd(W1, 'Di', 'u_di', 'C2-NUR-KW49')],
      gueltigkeit: { [W0]: 'ab_dieser_woche', [W1]: 'nur_diese_woche' }, questions: [] }, 'ab jetzt Montag anders, nur nächste Woche Dienstag');
    const ws = await apply(page); allPayloads.c2 = ws;
    check('c2) 3 Schreibzugriffe KW48/KW49/KW50 (Kontinuitaet)', ws.length === 3 && ws.map(w => w.path).join() === [pathOf(W0), pathOf(W1), pathOf(W2)].join(), short(ws));
    check('c2) KW49 = KW48-Aenderung (Mo) + eigene (Di)', ws[1]?.data.mo[0].notiz === 'C2-AB-KW48' && ws[1]?.data.di[0].notiz === 'C2-NUR-KW49', short(ws));
    check('c2) KW50-Kontinuitaet = neuer Dauerplan ab KW48 (Mo neu, Di alt)', ws[2]?.data.mo[0].notiz === 'C2-AB-KW48' && ws[2]?.data.di[0].notiz === 'CUR-DI', short(ws));
    await page.close();
  }

  // d) bestehende Version ab KW50; "ab" in KW49 -> Hinweis, KW50 bleibt
  {
    const page = await newPage(store([verDoc(W2, 'LATER')]));
    await runBuilder(page, { summary: 'ab KW49', changes: [upd(W1, 'Mo', 'u_mo', 'D-AB-KW49')], gueltigkeit: { [W1]: 'ab_dieser_woche' }, questions: [] }, 'ab nächster Woche Montag');
    await page.waitForTimeout(100);
    const notes = await page.$$eval('.wb-week-note', els => els.map(e => e.textContent));
    check('d) Hinweis "Ab KW 50 gilt bereits eine andere Version"', notes.some(n => n.includes('Ab KW 50 gilt bereits eine andere Version')), notes);
    const payload = await page.evaluate(() => JSON.parse(window.__TEST_AI_CALLS__[0].data.messages[0].content));
    check('d) Payload: KW50 eigene_version=true, Plan = LATER', payload.wochen[2].eigene_version === true && payload.wochen[2].plan.mo[0].notiz === 'LATER-MO', payload.wochen[2].plan.mo);
    const ws = await apply(page); allPayloads.d = ws;
    check('d) nur KW49 geschrieben, KW50 unberuehrt', ws.length === 1 && ws[0].path === pathOf(W1), short(ws));
    await page.close();
  }

  // g) KW ausserhalb des Bereichs / Vergangenheit -> abgelehnt mit Grund
  {
    const page = await newPage(store());
    await runBuilder(page, { summary: 'x', changes: [upd(W3, 'Mo', 'u_mo', 'G-KW51'), upd('2026-11-16', 'Mo', 'u_mo', 'G-KW47')], gueltigkeit: 'ab_dieser_woche', questions: ['Ich kann nur KW 48–50 ändern.'] }, 'ab KW 51 Montag');
    const txt = await page.$eval('#workout-builder-changes', el => el.innerText);
    check('g) KW51 abgelehnt mit "nur KW 48–50"', txt.includes('KW 51 außerhalb des Bereichs – nur KW 48–50'), txt);
    check('g) KW47 (vergangen) abgelehnt', txt.includes('KW 47 liegt in der Vergangenheit'), txt);
    const dis = await page.$eval('#workout-builder-apply-btn', el => el.disabled);
    check('g) nichts uebernehmbar (Button deaktiviert)', dis === true, dis);
    await page.close();
  }

  // p) pausierte Uebung (034a) in Folgewoche: gefiltert wie in der angezeigten Woche
  {
    const page = await newPage(store([], [{ id: 'exercises', data: { plank: { pausedUntil: '2026-12-31' } } }]));
    const zirkel = { typ: 'zirkel', runden: 2, pauseSec: 60, prepSec: 10, sideSwitchSec: 5, uebungen: [
      { typ: 'plank', variant: '', mode: 'time', holdSec: 30, wdh: 0, pauseSec: 15, perSide: false },
      { typ: 'liegestuetz', variant: '', mode: 'reps', holdSec: 0, wdh: 10, pauseSec: 15, perSide: false }], notiz: '' };
    await runBuilder(page, { summary: 'Zirkel KW50', changes: [{ week: W2, op: 'add', day: 'Mi', unitId: null, unit: zirkel }], gueltigkeit: { [W2]: 'ab_dieser_woche' }, questions: [] }, 'in KW 50 Mittwoch Zirkel');
    const ws = await apply(page); allPayloads.p = ws;
    const ueb = ws[0]?.data?.mi?.[0]?.uebungen?.map(x => x.typ);
    check('p) pausierte Uebung (plank) nicht in KW50-Zirkel', ws.length === 1 && ws[0].path === pathOf(W2) && Array.isArray(ueb) && !ueb.includes('plank') && ueb.includes('liegestuetz'), ueb);
    await page.close();
  }

  await browser.close();
  check('keine Konsolenfehler/Exceptions', errors.every(e => e.length === 0), errors.flat());
  console.log('\nPAYLOADS (Plan-Schreibzugriffe, gekuerzt):');
  for (const [k, v] of Object.entries(allPayloads)) console.log(k, JSON.stringify(short(v)));
  if (!ok) { console.error('\nFEHLER: mindestens eine Erwartung nicht erfuellt.'); process.exit(1); }
  console.log('\nOK: 055 Workout-Builder mehrere Wochen wie erwartet.');
})();

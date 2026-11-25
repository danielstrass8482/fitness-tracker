#!/usr/bin/env node
// 051 - Ruhetag einheitlich: Builder-Ruhetag == Editor-Ruhetag (Tag ohne Einheiten); Legacy-Einheit
// {typ:'ruhetag'} in gespeicherter Version wird wie leerer Tag gelesen (Anzeige "Ruhetag", 0 kcal Prognose).
// Playwright, echte index.html, Auth/Firestore gestubbt, Viewport 360, Schreibzugriffe nur protokolliert.
const { installHarness, TEST_UID } = require('./stubs/harness.js');
const { chromium } = require('playwright');
const FIXED = '2026-11-16T07:00:00.000Z'; // Mo 16.11.2026 08:00 Berlin
const MON = '2026-11-16';
const U = p => `users/${TEST_UID}/${p}`;
const LAUF = { id: 'u_lauf_mi', typ: 'laufen', typLabel: '', variant: '', distanzKm: 6, dauerMin: null, sets: null, pauseSec: null, notiz: '' };
let ok = true;
const check = (n, c, d) => { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; };
const store = (mi, extra = {}) => ({
  [U('settings')]: [{ id: 'main', data: { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 } }],
  [U('trainingplans')]: [{ id: MON, data: { datum: MON, mo: [], di: [], mi, do: [], fr: [], sa: [], so: [], ...extra } }],
});
const planW = async page => (await page.evaluate(() => window.__TEST_WRITES__ || [])).filter(w => w.path.includes('/trainingplans/') && w.type === 'set')
  .map(w => ({ path: w.path, data: (({ updatedAt, ...r }) => r)(w.data) }));

(async () => {
  const browser = await chromium.launch();
  const ctx = { viewport: { width: 360, height: 780 } };
  // a) Builder (update der Lauf-Einheit -> Ruhetag, Mittwoch) vs. Editor (planRemoveUnit)
  let builderPayload, editorPayload;
  {
    const page = await browser.newPage(ctx.viewport ? { viewport: ctx.viewport } : {});
    await installHarness(page, { fixedTimeIso: FIXED, store: store([LAUF]) });
    await page.evaluate(() => { window.switchTab('training'); window.shiftPlanWeek(0); window.renderTrainingPlan(true); });
    await page.evaluate(() => window.openWorkoutBuilder());
    await page.evaluate(() => { window.__TEST_AI_RESPONSE__ = { content: [{ type: 'text', text: JSON.stringify({ summary: 'Mi Ruhetag',
      changes: [{ op: 'update', day: 'Mi', unitId: 'u_lauf_mi', unit: { typ: 'ruhetag' } }], gueltigkeit: 'ab_dieser_woche', questions: [] }) }], stop_reason: 'end_turn' }; });
    await page.fill('#workout-builder-text', 'Mittwoch Ruhetag');
    await page.evaluate(() => window.generateWorkoutBuilderSuggestion());
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.__TEST_WRITES__ = []; });
    await page.click('#workout-builder-apply-btn');
    await page.waitForTimeout(120);
    builderPayload = await planW(page);
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
    await installHarness(page, { fixedTimeIso: FIXED, store: store([LAUF]) });
    await page.evaluate(() => { window.switchTab('training'); window.shiftPlanWeek(0); window.renderTrainingPlan(true); window.openPlanEditor(); window.planRemoveUnit('mi', 0); });
    await page.evaluate(() => { window.__TEST_WRITES__ = []; });
    await page.evaluate(() => { window.planEditorSave(); });
    await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
    await page.click('#plan-scope-options button:has-text("Ab dieser Woche dauerhaft")');
    await page.waitForTimeout(120);
    editorPayload = await planW(page);
    await page.close();
  }
  check('Builder-Ruhetag-Payload == Editor-Payload', builderPayload.length === 1 && JSON.stringify(builderPayload) === JSON.stringify(editorPayload), { builderPayload, editorPayload });
  check('Mittwoch ohne Einheiten, kein typ ruhetag', builderPayload[0]?.data?.mi?.length === 0 && !JSON.stringify(builderPayload).includes('ruhetag'), builderPayload[0]?.data?.mi);
  // b) Legacy-Version
  {
    const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
    const h = await installHarness(page, { fixedTimeIso: FIXED, store: store([{ id: 'pu_legacy', typ: 'ruhetag' }]) });
    await page.evaluate(() => { window.switchTab('training'); window.shiftPlanWeek(0); window.renderTrainingPlan(true); });
    await page.waitForTimeout(150);
    const txt = await page.evaluate(() => document.getElementById('training-plan-container').innerText);
    const mi = txt.split('\n');
    check('Legacy-Ruhetag-Einheit: Plan zeigt "Ruhetag" (Mi), nicht als Einheit/verpasst', txt.includes('Ruhetag') && !/verpasst/i.test(txt), txt.slice(0, 300));
    const kcal = await page.evaluate(() => window.plannedOpenUnitsKcal('2026-11-18'));
    check('Legacy-Ruhetag: Prognose-kcal 0', (typeof kcal === 'number' ? kcal : kcal && (kcal.kcal ?? kcal.total ?? 0)) === 0, kcal);
    await page.evaluate(() => window.openPlanEditor());
    const sum = await page.evaluate(() => [...document.querySelectorAll('#training-plan-container summary')].map(s => s.innerText).join('|'));
    check('Editor zeigt Mi als Ruhetag (0 Einheiten)', /Mittwoch\s*Ruhetag/.test(sum), sum);
    check('keine Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors);
    await page.close();
  }
  await browser.close();
  process.exit(ok ? 0 : 1);
})();

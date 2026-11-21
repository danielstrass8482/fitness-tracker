#!/usr/bin/env node
// 025 - Plan-Editor: gespeicherten Zirkel einfuegen/tauschen (kein KI-Call). Synthetische Daten,
// Auth/Firestore gestubbt, Schreibzugriffe nur protokolliert. "Neu laden" = geschriebenes Plan-
// Dokument in einen frischen Store legen und die Einheit pruefen.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z';
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };
const CUR = '2026-11-16';
const empty = { mo: [], di: [], mi: [], do: [], fr: [], sa: [], so: [] };
const TPL = { id: 'zt_1', name: 'Core Test', runden: 4, pauseSec: 45, prepSec: 10, sideSwitchSec: 7, updatedAt: '2026-11-10T10:00:00Z',
  uebungen: [
    { typ: 'custom_gerade_planks', variant: '', mode: 'time', holdSec: 40, wdh: 0, pauseSec: 10, perSide: false },
    { typ: 'custom_gerade_planks', variant: '', mode: 'reps', holdSec: 0, wdh: 12, pauseSec: 5, perSide: false } ] };
const PLAN_Z = { id: 'u_z', typ: 'zirkel', runden: 3, pauseSec: 150, prepSec: 0, sideSwitchSec: 5, notiz: 'PLAN-ZIRKEL',
  uebungen: [ { typ: 'custom_gerade_planks', variant: '', mode: 'time', holdSec: 30, wdh: 0, pauseSec: 0, perSide: false } ] };
const RUN = { id: 'u_run', typ: 'laufen', typLabel: '', variant: '', distanzKm: 5, dauerMin: null, sets: null, pauseSec: null, notiz: 'LAUF' };

function store(plan) {
  return {
    [`users/${TEST_UID}/settings`]: [{ id: 'main', data: SETTINGS }],
    [`users/${TEST_UID}/intervalTemplates`]: [{ id: TPL.id, data: TPL }],
    [`users/${TEST_UID}/trainingplans`]: [{ id: CUR, data: { datum: CUR, ...plan } }],
  };
}
let ok = true;
function check(n, c, d) { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; }
const writes = p => p.evaluate(() => window.__TEST_WRITES__ || []);

async function saveEditor(page) {
  await page.evaluate(() => { window.planEditorSave(); });
  await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
  await page.click('#plan-scope-options button:has-text("Ab dieser Woche dauerhaft")');
  await page.waitForTimeout(100);
  const ws = (await writes(page)).filter(w => w.type === 'set' && w.path === `users/${TEST_UID}/trainingplans/${CUR}`);
  return ws[ws.length - 1]?.data;
}
async function pick(page, textPart, key, idx) {
  await page.evaluate(([k, i]) => window.planOpenZirkelPick(k, i), [key, idx]);
  await page.waitForSelector('#plan-zirkel-pick-modal', { state: 'visible' });
  const labels = await page.$$eval('#plan-zirkel-pick-select option', o => o.map(x => x.textContent));
  const i = labels.findIndex(l => l.includes(textPart));
  await page.selectOption('#plan-zirkel-pick-select', String(i));
  await page.click('#plan-zirkel-pick-ok');
  await page.waitForTimeout(80);
  return labels;
}

(async () => {
  const browser = await chromium.launch();
  const errs = [];
  const page = await browser.newPage();
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: store({ ...empty, mo: [PLAN_Z, RUN] }) });
  await page.evaluate(() => window.openPlanEditor());
  await page.waitForTimeout(100);
  check('Knopf "Zirkel einfügen" je Tag (7)', (await page.$$('button:has-text("Zirkel einfügen")')).length === 7);
  check('Knopf "Zirkel tauschen" bei Zirkel-Einheit (1)', (await page.$$('button:has-text("Zirkel tauschen")')).length === 1);
  const labels = await pick(page, 'Vorlage: Core Test', 'mi', -1);
  check('Liste: Plan-Zirkel oben, dann Vorlage; 2 Einträge', labels.length === 2 && labels[0].startsWith('Plan') && labels[1].startsWith('Vorlage'), labels);
  await pick(page, 'Core Test', 'mo', 0); // dedupliziert: Eintrag kommt jetzt aus Plan Mittwoch
  const saved = await saveEditor(page);
  const mi = saved?.mi?.[0], mo = saved?.mo;
  check('Mi: Zirkel aus Vorlage ergänzt', mi?.typ === 'zirkel' && mi.notiz === 'Core Test' && mi.runden === 4 && mi.pauseSec === 45 && mi.prepSec === 10 && mi.sideSwitchSec === 7, mi);
  check('Mi: Übungen mit mode/holdSec/wdh/pauseSec', mi?.uebungen?.length === 2 && mi.uebungen[0].mode === 'time' && mi.uebungen[0].holdSec === 40 && mi.uebungen[0].pauseSec === 10 && mi.uebungen[1].mode === 'reps' && mi.uebungen[1].wdh === 12, mi?.uebungen);
  check('Mo: Zirkel getauscht, Lauf-Einheit unverändert dahinter', mo?.length === 2 && mo[0].typ === 'zirkel' && mo[0].notiz === 'Core Test' && mo[1].notiz === 'LAUF', mo?.map(u => u.notiz));
  check('Mo: neue Einheit hat andere id als vorher', mo?.[0]?.id !== 'u_z');
  check('Kein KI-Call', (await page.evaluate(() => (window.__TEST_AI_CALLS__ || []).length)) === 0);
  errs.push(...h.consoleErrors);
  await page.close();

  // Neu laden: gespeichertes Dokument als Store, Editor oeffnen, Entwurf vergleichen
  const page2 = await browser.newPage();
  const h2 = await installHarness(page2, { fixedTimeIso: FIXED_TIME_ISO, store: store({ ...empty, mi: saved.mi, mo: saved.mo }) });
  await page2.evaluate(() => window.openPlanEditor());
  await page2.waitForTimeout(100);
  // Unveraendert speichern: normalisierter Entwurf == geladener Plan -> kein Scope-Dialog, kein Schreiben
  await page2.evaluate(() => { window.planEditorSave(); });
  await page2.waitForTimeout(150);
  const dlg = await page2.$eval('#plan-scope-modal', el => el.style.display);
  const w2 = await writes(page2); check('Nach Neuladen: Einheiten identisch (unveraendert speichern = keine Aenderung erkannt)', dlg !== 'flex' && w2.filter(w => w.path.includes('trainingplans')).length === 0, w2.map(w => w.path.replace(/users\/[^/]+/, '{uid}')));
  const txt = await page2.evaluate(() => document.getElementById('training-plan-container').innerText);
  check('Nach Neuladen: Plan zeigt Zirkel-Einheiten', txt.includes('Core Test'), txt.slice(0, 80));
  errs.push(...h2.consoleErrors);
  await page2.close();
  await browser.close();
  check('keine Konsolenfehler', errs.length === 0, errs);
  if (!ok) { console.error('\nFEHLER'); process.exit(1); }
  console.log('\nOK: Zirkel einfügen/tauschen (025).');
})();

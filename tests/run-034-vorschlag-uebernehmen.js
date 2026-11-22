#!/usr/bin/env node
// 034 - Tagescheck-Planvorschlag "In Plan übernehmen" (neue Planversion). Playwright gegen die ECHTE
// index.html (Auth/Firestore gestubbt, Viewport 360, Schreibzugriffe nur protokolliert, nie ausgefuehrt).
// Je Vorschlagsart (Lauf / Zirkel / Ruhetag) x Gueltigkeit ("Nur diese Woche" / "Ab dieser Woche
// dauerhaft"): Payload der Uebernahme == Payload einer manuellen Editor-Aenderung derselben Sache
// (updatedAt ausgenommen). Zusaetzlich: Dialog nur 2 Optionen (Standard "Nur diese Woche"), Hinweis
// auf spaetere Version, Rueckgaengig, andere Wochentage unveraendert, Vorschlagszeile weg, bereits
// geloggter Eintrag bleibt zugeordnet.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-19T06:00:00.000Z'; // Do 19.11.2026 07:00 Europe/Berlin, KW47
const TODAY = '2026-11-19';
const CUR_MONDAY = '2026-11-16';
const NEXT_MONDAY = '2026-11-23';
const BASE_MONDAY = '2026-11-02';
const LATER_MONDAY = '2026-12-28';
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };
const U = p => `users/${TEST_UID}/${p}`;
const planPath = m => U(`trainingplans/${m}`);

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

const LAUF_DO = { id: 'u_lauf_do', typ: 'laufen', typLabel: '', variant: '', distanzKm: 12, dauerMin: null, sets: null, pauseSec: null, notiz: 'Long Run' };
const LAUF_MI = { id: 'u_lauf_mi', typ: 'laufen', typLabel: '', variant: '', distanzKm: 6, dauerMin: null, sets: null, pauseSec: null, notiz: 'MI-UNVERAENDERT' };
const ZIRKEL_DO = { id: 'u_zirkel_do', typ: 'zirkel', runden: 3, pauseSec: 120, prepSec: 0, sideSwitchSec: 5,
  uebungen: [{ typ: 'custom_gerade_planks', variant: '', mode: 'time', holdSec: 30, wdh: 0, pauseSec: 0, perSide: false }], notiz: 'Core' };

function planDoc(monday, doUnits) {
  return { id: monday, data: { datum: monday, mo: [], di: [], mi: [LAUF_MI], do: doUnits, fr: [], sa: [], so: [] } };
}

// Vorschlaege so, wie validateDailyCheckResult sie speichert (unit bereits normalisiert, eigene id).
const SUGG = {
  lauf: { originalUnitId: 'u_lauf_do', reason: 'HRV niedrig - kuerzer laufen.',
    unit: { id: 'pu_sugg1', typ: 'laufen', typLabel: '', variant: '', distanzKm: 8, dauerMin: null, sets: null, pauseSec: null, notiz: 'Locker' } },
  zirkel: { originalUnitId: 'u_zirkel_do', reason: 'Eine Runde weniger.',
    unit: { id: 'pu_sugg2', typ: 'zirkel', runden: 2, pauseSec: 120, prepSec: 0, sideSwitchSec: 5,
      uebungen: [{ typ: 'custom_gerade_planks', variant: '', mode: 'time', holdSec: 30, wdh: 0, pauseSec: 0, perSide: false }], notiz: 'Core', dauerMin: 3 } },
  ruhetag: { originalUnitId: 'u_lauf_do', reason: 'Krankheitsanzeichen - Pause.', unit: { typ: 'ruhetag' } },
};
// Editor-Aequivalent derselben Aenderung (planEditField / planRemoveUnit auf Donnerstag, Index 0)
const EDITOR = {
  lauf: async page => page.evaluate(() => { window.planEditField('do', 0, 'distanzKm', '8'); window.planEditField('do', 0, 'notiz', 'Locker'); }),
  zirkel: async page => page.evaluate(() => { window.planEditField('do', 0, 'runden', 2); }),
  ruhetag: async page => page.evaluate(() => { window.planRemoveUnit('do', 0); }),
};

function store(kind, { later, entries } = {}) {
  const doUnits = kind === 'zirkel' ? [ZIRKEL_DO] : [LAUF_DO];
  const s = {
    [U('settings')]: [{ id: 'main', data: SETTINGS }],
    [U('trainingplans')]: [planDoc(BASE_MONDAY, doUnits), ...(later ? [planDoc(LATER_MONDAY, [])] : [])],
    [U('dailyCheck')]: [{ id: TODAY, data: {
      date: TODAY, status: 'gelb', headline: 'Etwas muede', actions: ['Locker bleiben.'], reason: 'Test.',
      confidence: 'mittel', flags: { illness: false, alcohol: false }, planSuggestion: SUGG[kind], suggestionStatus: 'offen',
      createdAt: '2026-11-19T05:30:00.000Z' } }],
  };
  if (entries) s[U('entries')] = entries;
  return s;
}

const writes = page => page.evaluate(() => window.__TEST_WRITES__ || []);
const clearWrites = page => page.evaluate(() => { window.__TEST_WRITES__ = []; });
const planWrites = ws => ws.filter(w => w.path.includes('/trainingplans/'))
  .map(w => ({ type: w.type, path: w.path, data: w.data ? (({ updatedAt, ...rest }) => rest)(w.data) : undefined }));
const containerText = page => page.evaluate(() => document.getElementById('training-plan-container').innerText);

async function start(browser, st) {
  const page = await browser.newPage();
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: st });
  await page.evaluate(() => { window.switchTab('training'); window.shiftPlanWeek(0); window.renderTrainingPlan(true); });
  await page.waitForTimeout(150);
  return { page, h };
}

async function openScopeVia(page, fn) {
  await page.evaluate((f) => { window[f](); }, fn);
  await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
}
async function pick(page, label) {
  await page.click(`#plan-scope-options button:has-text("${label}")`);
  await page.waitForTimeout(120);
}

const SCOPES = [['nur_diese_woche', 'Nur diese Woche'], ['ab_dieser_woche', 'Ab dieser Woche dauerhaft']];
const payloadLog = [];

async function scenario(browser, kind, scopeLabel) {
  const errors = [];
  // a) Uebernahme
  let adoptPayload;
  {
    const { page, h } = await start(browser, store(kind));
    const before = await containerText(page);
    check(`${kind}/${scopeLabel}: Vorschlagszeile + Button sichtbar`, before.includes('Vorschlag') && before.includes('In Plan übernehmen'), before.includes('In Plan übernehmen'));
    await clearWrites(page);
    await page.click('#training-plan-container button:has-text("In Plan übernehmen")');
    await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
    const opts = await page.$$eval('#plan-scope-options button', bs => bs.map(b => ({ t: b.textContent.trim(), d: b.dataset.default === '1' })));
    check(`${kind}/${scopeLabel}: Dialog nur 2 Optionen, Standard "Nur diese Woche"`, opts.length === 2 && opts[0].t.startsWith('Nur diese Woche') && opts[0].d && !opts[1].d && opts[1].t === 'Ab dieser Woche dauerhaft', opts);
    await pick(page, scopeLabel);
    adoptPayload = planWrites(await writes(page));
    const other = (await writes(page)).filter(w => !w.path.includes('/trainingplans/'));
    check(`${kind}/${scopeLabel}: keine Schreibzugriffe ausser Planversionen`, other.length === 0, other.map(w => w.path));
    const after = await containerText(page);
    check(`${kind}/${scopeLabel}: Vorschlagszeile + "Original"-Tag nach Uebernahme weg`, !after.includes('In Plan übernehmen') && !after.includes('Original') && !/Vorschlag\n/.test(after), after.slice(0, 400));
    const undoBar = await page.$eval('#plan-save-undo-bar', el => el.innerText);
    check(`${kind}/${scopeLabel}: Rueckgaengig-Leiste sichtbar`, undoBar.includes('Rückgängig'), undoBar);
    // Rueckgaengig
    await clearWrites(page);
    await page.evaluate(() => window.undoPlanSave());
    await page.waitForTimeout(150);
    const undoW = planWrites(await writes(page));
    const expectedUndo = adoptPayload.map(w => ({ type: 'delete', path: w.path, data: undefined }));
    check(`${kind}/${scopeLabel}: Rueckgaengig loescht genau die neu angelegten Versionen`, JSON.stringify(undoW) === JSON.stringify(expectedUndo), undoW);
    check(`${kind}/${scopeLabel}: nach Rueckgaengig Original + Vorschlag wieder sichtbar`, (await containerText(page)).includes('In Plan übernehmen'), null);
    payloadLog.push({ kind, scope: scopeLabel, adopt: adoptPayload, undo: undoW });
    errors.push(...h.consoleErrors);
    await page.close();
  }
  // b) Manuelle Editor-Aenderung derselben Sache
  {
    const { page, h } = await start(browser, store(kind));
    await page.evaluate(() => window.openPlanEditor());
    await EDITOR[kind](page);
    await clearWrites(page);
    await openScopeVia(page, 'planEditorSave');
    await pick(page, scopeLabel);
    const editorPayload = planWrites(await writes(page));
    check(`${kind}/${scopeLabel}: Payload Uebernahme == Payload Editor`, JSON.stringify(adoptPayload) === JSON.stringify(editorPayload), { adoptPayload, editorPayload });
    errors.push(...h.consoleErrors);
    await page.close();
  }
  // Inhalt
  const cur = adoptPayload.find(w => w.path === planPath(CUR_MONDAY));
  check(`${kind}/${scopeLabel}: Mittwoch unveraendert`, JSON.stringify(cur?.data?.mi?.map(u => u.notiz)) === '["MI-UNVERAENDERT"]', cur?.data?.mi);
  check(`${kind}/${scopeLabel}: andere Tage (mo/di/fr/sa/so) leer wie vorher`, ['mo', 'di', 'fr', 'sa', 'so'].every(k => cur?.data?.[k]?.length === 0), cur?.data);
  if (kind === 'ruhetag') check(`${kind}/${scopeLabel}: Donnerstag ohne Einheit`, cur?.data?.do?.length === 0, cur?.data?.do);
  else check(`${kind}/${scopeLabel}: Donnerstag = Vorschlag mit id des Originals`, cur?.data?.do?.length === 1 && cur.data.do[0].id === SUGG[kind].originalUnitId
    && (kind === 'lauf' ? cur.data.do[0].distanzKm === 8 : cur.data.do[0].runden === 2), cur?.data?.do);
  const next = adoptPayload.find(w => w.path === planPath(NEXT_MONDAY));
  if (scopeLabel === 'Nur diese Woche') check(`${kind}/${scopeLabel}: Fortsetzungsversion KW48 mit bisherigem Inhalt`, adoptPayload.length === 2 && next?.data?.do?.[0]?.id === SUGG[kind].originalUnitId
    && JSON.stringify(next.data.do[0]) !== JSON.stringify(cur.data.do[0]), next?.data?.do);
  else check(`${kind}/${scopeLabel}: nur eine Version (keine Fortsetzung)`, adoptPayload.length === 1, adoptPayload.map(w => w.path));
  return errors;
}

async function main() {
  const browser = await chromium.launch();
  const errors = [];
  for (const kind of ['lauf', 'zirkel', 'ruhetag']) {
    for (const [, label] of SCOPES) errors.push(...await scenario(browser, kind, label));
  }

  // Hinweis auf spaetere Version
  {
    const { page, h } = await start(browser, store('lauf', { later: true }));
    await page.click('#training-plan-container button:has-text("In Plan übernehmen")');
    await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
    const note = await page.$eval('#plan-scope-note', el => el.textContent);
    check('Spaetere Version (KW53) -> Hinweis im Dialog', note.includes('Ab KW 53'), note);
    await page.click('#plan-scope-modal button:has-text("Abbrechen")');
    await page.waitForTimeout(80);
    const w = planWrites(await writes(page));
    check('Abbrechen -> kein Plan-Schreibzugriff, Vorschlag bleibt', w.length === 0 && (await containerText(page)).includes('In Plan übernehmen'), w);
    errors.push(...h.consoleErrors);
    await page.close();
  }

  // Bereits geloggter Eintrag bleibt zugeordnet (Lauf 8 km erfasst; Zirkel per Vorschlag gestartet)
  {
    const entry = { id: 'e_lauf', data: { datum: TODAY, typ: 'laufen', distanz: 8, zeit: '00:45', source: 'manual' } };
    const { page, h } = await start(browser, store('lauf', { entries: [entry] }));
    const before = await containerText(page);
    check('Lauf vorher: Original "Ersetzt durch Vorschlag"', before.includes('Ersetzt durch Vorschlag'), before.slice(0, 400));
    await page.click('#training-plan-container button:has-text("In Plan übernehmen")');
    await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
    await pick(page, 'Nur diese Woche');
    const after = await containerText(page);
    check('Lauf nachher: Einheit erledigt (erfasst), nicht ersetzt/extra, 1/2 erledigt', after.includes('erfasst') && !after.includes('Ersetzt') && !after.includes('+\n') && after.includes('1/2'), after.slice(0, 500));
    errors.push(...h.consoleErrors);
    await page.close();
  }
  {
    const entry = { id: 'e_zirkel', data: { datum: TODAY, typ: 'zirkel', runden: 2, zeit: '00:03', source: 'plan', planUnitId: 'u_zirkel_do', suggestionApplied: true } };
    const { page, h } = await start(browser, store('zirkel', { entries: [entry] }));
    const before = await containerText(page);
    check('Zirkel vorher: Original "Ersetzt durch Vorschlag"', before.includes('Ersetzt durch Vorschlag'), before.slice(0, 400));
    await page.click('#training-plan-container button:has-text("In Plan übernehmen")');
    await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
    await pick(page, 'Ab dieser Woche dauerhaft');
    const after = await containerText(page);
    check('Zirkel nachher: Einheit abgehakt, nicht ersetzt/extra, 1/2 erledigt', after.includes('abgehakt') && !after.includes('Ersetzt') && after.includes('1/2'), after.slice(0, 500));
    errors.push(...h.consoleErrors);
    await page.close();
  }

  await browser.close();
  check('Keine Konsolenfehler/Exceptions', errors.length === 0, errors);
  if (process.argv.includes('--payloads')) console.log('\nPAYLOADS ' + JSON.stringify(payloadLog));
  if (!ok) { console.error('\nFEHLER: mindestens eine Erwartung nicht erfuellt.'); process.exit(1); }
  console.log('\nOK: 034 Vorschlag als Planversion uebernehmen wie erwartet.');
}
main().catch(e => { console.error(e); process.exit(1); });

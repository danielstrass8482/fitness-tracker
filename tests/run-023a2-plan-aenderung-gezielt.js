#!/usr/bin/env node
// 023a2 - Plan-Aenderungen gezielt (nur diese Woche / ab dieser Woche dauerhaft / nur heute).
// Siehe tasks/023a2-plan-aenderung-gezielt.md und Bericht 023a2. Playwright gegen die ECHTE
// index.html (Auth/Firestore gestubbt, Viewport 360). setDoc/deleteDoc persistieren im Stub NICHT
// in den Store (nur Protokoll in window.__TEST_WRITES__, siehe tests/stubs/firebase-stub.mjs) -
// die Kernaussagen werden deshalb ueber die PROTOKOLLIERTEN Schreibzugriffe (welches Dokument mit
// welchem Inhalt geschrieben/geloescht wird) und den gerenderten Plan-Tab geprueft, nicht ueber ein
// erneutes Lesen nach dem Schreiben.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // Montag 08:00 Europe/Berlin, KW47
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };
const CUR_MONDAY = '2026-11-16';   // aktuelle Woche (KW47)
const NEXT_MONDAY = '2026-11-23';  // KW48
const NEXT2_MONDAY = '2026-11-30'; // KW49

function unit(id, notiz) {
  return { id, typ: 'laufen', typLabel: '', variant: '', distanzKm: 5, dauerMin: null, sets: null, pauseSec: null, notiz };
}

// 2026-11-02 (BASE, gilt ab KW44) + 2026-11-16 (CUR, eigene Version fuer die aktuelle Woche) -
// KW48/KW49 haben noch KEINE eigene Version und erben von CUR (groesstes datum <= Woche).
function buildStore(extra) {
  return {
    [`users/${TEST_UID}/settings`]: [{ id: 'main', data: SETTINGS }],
    [`users/${TEST_UID}/trainingplans`]: [
      { id: '2026-11-02', data: { datum: '2026-11-02', mo: [unit('u_base_mo', 'BASE-MO')], di: [unit('u_base_di', 'BASE-DI')], mi: [], do: [], fr: [], sa: [], so: [] } },
      { id: CUR_MONDAY, data: { datum: CUR_MONDAY, mo: [unit('u_cur_mo', 'CUR-MO')], di: [unit('u_cur_di', 'CUR-DI')], mi: [], do: [], fr: [], sa: [], so: [] } },
      ...(extra || []),
    ],
  };
}

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

async function writes(page) { return page.evaluate(() => window.__TEST_WRITES__ || []); }
function setWrites(ws, path) { return ws.filter(w => w.type === 'set' && w.path === path); }
function delWrites(ws, path) { return ws.filter(w => w.type === 'delete' && w.path === path); }
function planCol(monday) { return `users/${TEST_UID}/trainingplans/${monday}`; }

async function clearWrites(page) { await page.evaluate(() => { window.__TEST_WRITES__ = []; }); }

async function openEditorForWeek(page, offset) {
  await page.evaluate((o) => window.shiftPlanWeek(o === 0 ? 0 : o), offset);
  await page.waitForTimeout(80);
  await page.evaluate(() => window.openPlanEditor());
}

async function pickScope(page, label) {
  await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
  await page.click(`#plan-scope-options button:has-text("${label}")`);
  await page.waitForTimeout(80);
}

function containerText(page) {
  return page.evaluate(() => document.getElementById('training-plan-container').innerText);
}

// 1) Editor in KW+1 (KW48), "Nur diese Woche": KW48 geaendert, aktuelle Woche + KW49 unveraendert.
// Rueckgaengig: beide angelegten Dokumente (KW48 + Kontinuitaet KW49) wieder geloescht.
async function scenario1(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await openEditorForWeek(page, 1); // KW48
  await page.evaluate(() => window.planEditField('mo', 0, 'notiz', 'KW48-NUR-DIESE-WOCHE'));
  const optionCountBefore = await page.evaluate(async () => {
    window.planEditorSave();
    for (let i = 0; i < 50 && document.getElementById('plan-scope-modal').style.display !== 'flex'; i++) await new Promise(r => setTimeout(r, 10));
    return document.querySelectorAll('#plan-scope-options button').length;
  });
  check('KW48 (kuenftige Woche): Dialog zeigt 2 Optionen (kein "Nur heute")', optionCountBefore === 2, optionCountBefore);
  await pickScope(page, 'Nur diese Woche');

  const ws = await writes(page);
  const w48 = setWrites(ws, planCol(NEXT_MONDAY));
  const w49 = setWrites(ws, planCol(NEXT2_MONDAY));
  check('Genau 1 Schreibzugriff auf KW48 (die geaenderte Woche)', w48.length === 1, w48.length);
  check('KW48 enthaelt die neue Notiz', w48[0]?.data?.mo?.[0]?.notiz === 'KW48-NUR-DIESE-WOCHE', w48[0]?.data?.mo);
  check('Genau 1 Kontinuitaets-Schreibzugriff auf KW49 (noch keine eigene Version)', w49.length === 1, w49.length);
  check('KW49 bekommt den BISHERIGEN Inhalt (CUR-MO/CUR-DI), nicht die Aenderung', w49[0]?.data?.mo?.[0]?.notiz === 'CUR-MO' && w49[0]?.data?.di?.[0]?.notiz === 'CUR-DI', w49[0]?.data);

  await page.evaluate(() => window.shiftPlanWeek(0));
  await page.waitForTimeout(60);
  const curText = await containerText(page);
  check('Aktuelle Woche (KW47) zeigt weiterhin CUR-MO (unveraendert)', curText.includes('CUR-MO'), curText.includes('CUR-MO'));

  await page.evaluate(() => window.shiftPlanWeek(1));
  await page.waitForTimeout(60);
  const kw48Text = await containerText(page);
  check('KW48 zeigt die neue Notiz', kw48Text.includes('KW48-NUR-DIESE-WOCHE'), kw48Text.includes('KW48-NUR-DIESE-WOCHE'));

  // Rueckgaengig: beide (neu angelegten) Dokumente wieder geloescht.
  await clearWrites(page);
  await page.evaluate(() => window.undoPlanSave());
  await page.waitForTimeout(80);
  const undoWrites = await writes(page);
  check('Rueckgaengig: KW48-Dokument geloescht (war neu angelegt)', delWrites(undoWrites, planCol(NEXT_MONDAY)).length === 1, undoWrites);
  check('Rueckgaengig: KW49-Dokument geloescht (war neu angelegt)', delWrites(undoWrites, planCol(NEXT2_MONDAY)).length === 1, undoWrites);

  await page.close();
  return { name: '1) Editor KW48 "Nur diese Woche" + Rueckgaengig', consoleErrors };
}

// 2) Editor in KW+1 (KW48), "Ab dieser Woche dauerhaft": nur EIN Schreibzugriff (keine
// Kontinuitaets-Version), aktuelle Woche bleibt unveraendert. Zusaetzlich: existiert bereits eine
// spaetere Version (hier KW54, 2026-12-28), zeigt der Dialog den Hinweis darauf.
async function scenario2(browser) {
  const page = await browser.newPage();
  const laterMonday = '2026-12-28';
  const store = buildStore([{ id: laterMonday, data: { datum: laterMonday, mo: [], di: [], mi: [], do: [], fr: [], sa: [], so: [] } }]);
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store });

  await openEditorForWeek(page, 1); // KW48
  await page.evaluate(() => window.planEditField('mo', 0, 'notiz', 'KW48-AB-DAUERHAFT'));
  await page.evaluate(() => { window.planEditorSave(); }); // fire-and-forget: haengt bis planAskScope() per Klick aufgeloest wird
  await page.waitForSelector('#plan-scope-modal', { state: 'visible' });
  const note = await page.$eval('#plan-scope-note', el => el.textContent);
  check('Hinweis auf bereits existierende spaetere Version wird angezeigt', /KW/.test(note) && note.length > 0, note);
  await page.click('#plan-scope-options button:has-text("Ab dieser Woche dauerhaft")');
  await page.waitForTimeout(80);

  const ws = await writes(page);
  const planWrites = ws.filter(w => w.path.includes('/trainingplans/'));
  check('Genau 1 Plan-Schreibzugriff insgesamt (keine Kontinuitaets-Version)', planWrites.length === 1, planWrites);
  check('Der eine Schreibzugriff betrifft KW48', setWrites(ws, planCol(NEXT_MONDAY)).length === 1, planWrites);

  await page.evaluate(() => window.shiftPlanWeek(0));
  await page.waitForTimeout(60);
  const curText = await containerText(page);
  check('Aktuelle Woche (KW47) bleibt unveraendert (CUR-MO)', curText.includes('CUR-MO'), curText.includes('CUR-MO'));

  await page.close();
  return { name: '2) Editor KW48 "Ab dieser Woche dauerhaft" + Hinweis auf spaetere Version', consoleErrors };
}

// 3) Aktuelle Woche, "Nur heute" (heute = Montag): NUR der heutige Tag (mo) uebernimmt die
// Aenderung, ein zusaetzlich im Draft geaenderter anderer Tag (di) bleibt wie vorher - sowohl im
// aktuellen Dokument als auch in der Kontinuitaets-Version fuer KW48. Danach Rueckgaengig (deckt
// den "ueberschrieben"-Undo-Zweig ab: KW47 existierte schon, KW48 war neu).
async function scenario3(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await openEditorForWeek(page, 0); // aktuelle Woche
  await page.evaluate(() => { window.planEditField('mo', 0, 'notiz', 'HEUTE-GEAENDERT'); window.planEditField('di', 0, 'notiz', 'DI-SOLLTE-VERWORFEN-WERDEN'); });
  const optionCount = await page.evaluate(async () => {
    window.planEditorSave();
    for (let i = 0; i < 50 && document.getElementById('plan-scope-modal').style.display !== 'flex'; i++) await new Promise(r => setTimeout(r, 10));
    return document.querySelectorAll('#plan-scope-options button').length;
  });
  check('Aktuelle Woche: Dialog zeigt 3 Optionen (inkl. "Nur heute")', optionCount === 3, optionCount);
  await pickScope(page, 'Nur heute');

  const ws = await writes(page);
  const wCur = setWrites(ws, planCol(CUR_MONDAY));
  const wNext = setWrites(ws, planCol(NEXT_MONDAY));
  check('KW47-Dokument: mo geaendert', wCur[0]?.data?.mo?.[0]?.notiz === 'HEUTE-GEAENDERT', wCur[0]?.data?.mo);
  check('KW47-Dokument: di NICHT geaendert (nur heute = nur Montag)', wCur[0]?.data?.di?.[0]?.notiz === 'CUR-DI', wCur[0]?.data?.di);
  check('KW48-Kontinuitaet: mo UND di wie vor der Aenderung (CUR-MO/CUR-DI)',
    wNext[0]?.data?.mo?.[0]?.notiz === 'CUR-MO' && wNext[0]?.data?.di?.[0]?.notiz === 'CUR-DI', wNext[0]?.data);

  const curText = await containerText(page);
  check('Gerenderte aktuelle Woche zeigt HEUTE-GEAENDERT (mo)', curText.includes('HEUTE-GEAENDERT'), curText.includes('HEUTE-GEAENDERT'));
  check('Gerenderte aktuelle Woche zeigt weiterhin CUR-DI (di unveraendert)', curText.includes('CUR-DI'), curText.includes('CUR-DI'));

  // Rueckgaengig: KW47 (ueberschrieben) zurueckgesetzt, KW48 (neu) geloescht.
  await clearWrites(page);
  await page.evaluate(() => window.undoPlanSave());
  await page.waitForTimeout(80);
  const undoWrites = await writes(page);
  const undoCur = setWrites(undoWrites, planCol(CUR_MONDAY));
  check('Rueckgaengig: KW47 zurueckgeschrieben (ueberschrieben, kein Loeschen)', undoCur.length === 1, undoWrites);
  check('Rueckgaengig: KW47-Inhalt wieder CUR-MO/CUR-DI', undoCur[0]?.data?.mo?.[0]?.notiz === 'CUR-MO' && undoCur[0]?.data?.di?.[0]?.notiz === 'CUR-DI', undoCur[0]?.data);
  check('Rueckgaengig: KW48-Kontinuitaet geloescht (war neu angelegt)', delWrites(undoWrites, planCol(NEXT_MONDAY)).length === 1, undoWrites);
  const afterUndoText = await containerText(page);
  check('Nach Rueckgaengig: gerenderte aktuelle Woche wieder CUR-MO', afterUndoText.includes('CUR-MO') && !afterUndoText.includes('HEUTE-GEAENDERT'), afterUndoText.includes('CUR-MO'));

  await page.close();
  return { name: '3) Aktuelle Woche "Nur heute" (anderer Tag bleibt) + Rueckgaengig', consoleErrors };
}

// 4) Workout-Builder: gueltigkeit "nur_diese_woche" vom Modell -> dieselbe Speicherlogik wie der
// Editor (Kontinuitaets-Version bei KW49). Payload enthaelt ziel_woche/heute.
async function scenario4(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await page.evaluate(() => window.shiftPlanWeek(1)); // KW48 als Zielwoche
  await page.waitForTimeout(60);
  await page.evaluate(() => window.openWorkoutBuilder());
  const targetLabel = await page.$eval('#workout-builder-target-label', el => el.textContent);
  check('Zielwoche-Label zeigt KW48', /KW\s*48/.test(targetLabel), targetLabel);

  await page.evaluate(() => {
    window.__TEST_AI_RESPONSE__ = {
      content: [{ type: 'text', text: JSON.stringify({
        summary: 'Ruhetag Mittwoch (nur diese Woche)',
        changes: [{ op: 'add', day: 'Mi', unitId: null, unit: { typ: 'ruhetag' } }],
        gueltigkeit: 'nur_diese_woche',
        questions: []
      }) }],
      stop_reason: 'end_turn'
    };
  });
  await page.fill('#workout-builder-text', 'Nur diese Woche Mittwoch Ruhetag');
  await page.evaluate(() => window.generateWorkoutBuilderSuggestion());
  await page.waitForTimeout(80);

  const call = await page.evaluate(() => window.__TEST_AI_CALLS__[0].data);
  const payload = JSON.parse(call.messages[0].content);
  check('Payload enthaelt ziel_woche.montag = KW48-Montag', payload.ziel_woche?.montag === NEXT_MONDAY, payload.ziel_woche);
  check('Payload enthaelt heute (Europe/Berlin, FIXED_TIME)', payload.heute === CUR_MONDAY, payload.heute);

  const foreverBtnBg = await page.$eval('#workout-builder-validity-week', el => el.style.background);
  check('Gueltigkeit "Nur diese Woche" aus dem Modellvorschlag ist vorbelegt (Button markiert)', foreverBtnBg.includes('var(--fo-primary)') || foreverBtnBg !== '', foreverBtnBg);

  await page.click('#workout-builder-apply-btn');
  await page.waitForTimeout(80);

  const ws = await writes(page);
  const w48 = setWrites(ws, planCol(NEXT_MONDAY));
  const w49 = setWrites(ws, planCol(NEXT2_MONDAY));
  check('Workout-Builder "nur_diese_woche": KW48 geschrieben (Ruhetag Mittwoch = Tag ohne Einheiten, 051)', w48.length === 1 && Array.isArray(w48[0]?.data?.mi) && w48[0].data.mi.length === 0, w48[0]?.data?.mi);
  check('Workout-Builder "nur_diese_woche": KW49-Kontinuitaet mit bisherigem Inhalt angelegt', w49.length === 1 && !w49[0]?.data?.mi?.some(u => u.typ === 'ruhetag'), w49[0]?.data?.mi);

  await page.close();
  return { name: '4) Workout-Builder gueltigkeit "nur_diese_woche"', consoleErrors };
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  results.push(await scenario1(browser));
  results.push(await scenario2(browser));
  results.push(await scenario3(browser));
  results.push(await scenario4(browser));
  await browser.close();

  for (const r of results) {
    check(`${r.name}: keine Konsolenfehler/Exceptions`, r.consoleErrors.length === 0, r.consoleErrors);
  }

  if (!ok) { console.error('\nFEHLER: mindestens eine Erwartung nicht erfuellt (Details oben).'); process.exit(1); }
  console.log('\nOK: Plan-Aenderung gezielt (023a2) wie erwartet.');
})();

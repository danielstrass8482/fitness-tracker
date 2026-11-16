#!/usr/bin/env node
// 016 Teil A (S4 Stufe 1) - Beleg: loadAllData()/refreshGarminData() laden unabhaengige
// Firestore-Abfragen per Promise.all parallel statt nacheinander. Playwright gegen die ECHTE
// index.html (Auth/Firestore gestubbt, synthetische Daten, Viewport 360). Kuenstliche Latenz
// (150ms je Abfrage) ueber window.__TEST_LATENCY_MS__ im Firebase-Stub (tests/stubs/
// firebase-stub.mjs, simulateReadLatency) - siehe Bericht 016.
//
// Kein page.clock.install hier (anders als run-012d.js/run-015-...): die kuenstliche Latenz
// nutzt echtes setTimeout, eine eingefrorene Fake-Clock wuerde die Timer nie feuern lassen.
// Datums-Cutoff arbeitet deshalb mit der echten aktuellen Zeit - synthetische Daten sind relativ
// zu "heute" (Node: new Date()) geseedet, keine Zeitzonen-Kante wird hier geprueft (das deckt
// run-015 ab).
//
// Vergleich VORHER/NACHHER: HEAD-Version (sequentiell, vor Aufgabe 016) vs. Arbeitskopie
// (parallel). Beide laufen gegen denselben Seed, dieselbe Latenz - gemessen wird die Zeit vom
// Navigations-Start bis zur Konsolenzeile "Loaded: ..." (Ende von loadAllData, vor renderAll).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const REPO_ROOT = path.join(__dirname, '..');
const STUB_PATH = path.join(__dirname, 'stubs', 'firebase-stub.mjs');
const TEST_UID = 'TESTUID0000000000000001';
const LATENCY_MS = 150;
const REPEATS = 3;
// "vorher" = letzter Stand VOR der Parallelisierung (Aufgabe 016 Teil A, S4 Stufe 1).
// Per Konstante/Env fest, NICHT mehr HEAD - sonst vergleicht das Skript nach dem Commit der
// Parallelisierung sich selbst mit sich selbst (Bericht 016 Punkt 3 / Nachprüfung 016b Teil A).
const BEFORE_SHA = process.env.FUELOFIT_016_BEFORE_SHA || 'a40d9dd';

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Grobe Extraktion von loadAllData() aus HTML-Quelltext, um Promise.all-Vorkommen innerhalb der
// Funktion zu zaehlen (Plausibilitaetscheck, kein echter Parser - reicht fuer den Vergleich zweier
// bekannter Versionen).
function countPromiseAllInLoadAllData(html) {
  const startIdx = html.indexOf('async function loadAllData(');
  if (startIdx < 0) throw new Error('loadAllData nicht gefunden');
  const nextFnIdx = html.indexOf('\n    function calcAgeAtDate(', startIdx);
  const body = nextFnIdx > startIdx ? html.slice(startIdx, nextFnIdx) : html.slice(startIdx, startIdx + 8000);
  return (body.match(/Promise\.all\s*\(/g) || []).length;
}

function localDateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildStore() {
  const today = new Date();
  const todayStr = localDateStr(today);
  const store = {};

  store['foods'] = Array.from({ length: 40 }, (_, i) => ({
    id: 'food' + i, data: { id: 'food' + i, name: 'Testfood ' + i, kcal: 100 + i, protein: 5, carbs: 10, fat: 3 }
  }));
  store['trainingTypes'] = [
    { id: 'custom_gerade_planks', data: { id: 'custom_gerade_planks', label: 'Gerade Planks', addedBy: TEST_UID } },
    { id: 'custom_seitliche_planks', data: { id: 'custom_seitliche_planks', label: 'Seitliche Planks', addedBy: TEST_UID } },
    { id: 'custom_glute_bridges', data: { id: 'custom_glute_bridges', label: 'Glute Bridges', addedBy: TEST_UID } },
    { id: 'custom_bird_dog', data: { id: 'custom_bird_dog', label: 'Bird Dog', addedBy: TEST_UID } },
    { id: 'custom_split_squats', data: { id: 'custom_split_squats', label: 'Split Squats', addedBy: TEST_UID } },
    { id: 'custom_bulgarian_split_squats', data: { id: 'custom_bulgarian_split_squats', label: 'Bulgarian Split Squats', addedBy: TEST_UID } },
  ];

  const u = (p) => `users/${TEST_UID}/${p}`;
  store[u('recipes')] = Array.from({ length: 10 }, (_, i) => ({ id: 'recipe' + i, data: { id: 'recipe' + i, name: 'Rezept ' + i } }));

  const diary = [];
  const training = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    diary.push({ id: 'log' + i, data: { datum: ds, date: ds, foodId: 'food' + (i % 40), menge: 100 } });
    training.push({ id: 'train' + i, data: { typ: 'tageslog', datum: ds, date: ds, weight: 80, schritte: 5000 + i } });
  }
  store[u('logEntries')] = diary;
  store[u('entries')] = training;

  store[u('settings')] = [
    { id: 'main', data: { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700, detailDays: 31 } },
    { id: 'favorites', data: { ids: ['food1', 'food2'] } },
    { id: 'subjectiveStatus', data: { history: [] } },
    { id: 'exercises', data: {
      custom_gerade_planks: { metClass: 'mittel', perSideDefault: false },
      custom_seitliche_planks: { metClass: 'mittel', perSideDefault: true },
      custom_glute_bridges: { metClass: 'leicht', perSideDefault: false },
      custom_bird_dog: { metClass: 'leicht', perSideDefault: true },
      lunges: { metClass: 'mittel', perSideDefault: true },
      custom_split_squats: { metClass: 'intensiv', perSideDefault: true },
      custom_bulgarian_split_squats: { metClass: 'intensiv', perSideDefault: true },
      pullups: { metClass: 'intensiv', perSideDefault: false },
      pushups: { metClass: 'intensiv', perSideDefault: false },
      terraband_knie: { metClass: 'mittel', perSideDefault: true },
    } },
  ];

  store[u('intervalTemplates')] = [
    { id: 'tmpl1', data: { id: 'tmpl1', name: 'Vorlage 1', runden: 3, pauseSec: 60, prepSec: 10, sideSwitchSec: 5, uebungen: [] } },
  ];

  const ouraDaily = [];
  for (let i = 0; i < 20; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i - 1);
    const ds = localDateStr(d);
    ouraDaily.push({ id: ds, data: { date: ds, steps: 6000 + i } });
  }
  store[u('oura_daily')] = ouraDaily;

  store[u('garminDaily')] = [{ id: todayStr, data: { date: todayStr, steps: 7000 } }];
  store[u('garminActivities')] = [{ id: 'act1', data: { startLocal: todayStr + 'T07:00:00+01:00', garminType: 'running', steps: 2000, durationSec: 1800, distanceM: 4000, avgHr: 140, maxHr: 160 } }];
  store[u('garminHidden')] = [];
  store[u('garminLinks')] = [];
  store[u('ciqSteps')] = [{ id: todayStr, data: { steps: 7200, receivedAt: Date.now() } }];

  store[u('trainingplans')] = [{ id: 'plan1', data: { datum: '2020-01-06', uebungen: [] } }];

  return store;
}

async function installMinimalHarness(page, { store, latencyMs }) {
  await page.setViewportSize({ width: 360, height: 800 });
  const stubSrc = fs.readFileSync(STUB_PATH, 'utf8');
  await page.route('https://www.gstatic.com/firebasejs/**', route => {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stubSrc });
  });
  await page.route('https://cdnjs.cloudflare.com/**', route => {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stub */' });
  });
  await page.route(/^https:\/\/(?!www\.gstatic\.com|cdnjs\.cloudflare\.com)/, route => route.abort());

  await page.addInitScript(({ store, latencyMs }) => {
    window.__TEST_STORE__ = store;
    window.__TEST_WRITES__ = [];
    window.__TEST_LATENCY_MS__ = latencyMs;
  }, { store, latencyMs });

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(String(err)));

  return { consoleErrors };
}

async function runOnce(indexHtmlPath, label) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const store = buildStore();
  const ctx = await installMinimalHarness(page, { store, latencyMs: LATENCY_MS });

  // "Daten geladen" = die Konsolenzeile "Loaded: ..." am Ende von loadAllData (vor renderAll) -
  // nicht die DOM (#daily-kcal-goal startet schon mit dem Platzhaltertext "kcal", also length>0,
  // BEVOR irgendwelche Daten geladen sind - mit kuenstlicher Latenz waere das ein Fehlsignal).
  const loadedPromise = page.waitForEvent('console', { predicate: msg => msg.text().startsWith('Loaded:'), timeout: 20000 });
  const navStart = Date.now();
  await page.goto('file://' + indexHtmlPath);
  await loadedPromise;
  const elapsedMs = Date.now() - navStart;
  // kurz nachwarten, bis renderAll()/saveToCache() nach dem Loaded-Log durchgelaufen sind
  await page.waitForTimeout(50);

  const state = await page.evaluate(() => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const logEntriesTotal = Object.values(window.foodLog || {}).reduce((s, arr) => s + arr.length, 0);
    const intakeToday = window.getDayIntakeTotals ? window.getDayIntakeTotals(todayStr) : null;
    const goalToday = window.calcHistoricalKcalGoal ? window.calcHistoricalKcalGoal(todayStr) : null;
    return {
      foodDB: (window.foodDB || []).length,
      recipes: (window.recipes || []).length,
      foodLogDays: Object.keys(window.foodLog || {}).length,
      logEntriesTotal,
      trainingEntries: (window.trainingEntries || []).length,
      dayLogs: (window.dayLogs || []).length,
      garminDailyByDate: Object.keys(window.garminDailyByDate || {}).length,
      garminActivitiesAll: (window.garminActivitiesAll || []).length,
      garminHiddenIds: (window.garminHiddenIds ? window.garminHiddenIds.size : 0),
      garminUnlinkedIds: (window.garminUnlinkedIds ? window.garminUnlinkedIds.size : 0),
      ciqStepsToday: window.ciqStepsToday ? window.ciqStepsToday.steps : null,
      ouraDailyKeys: Object.keys(window.ouraDaily || {}).length,
      dailyKcalGoalText: document.getElementById('daily-kcal-goal')?.textContent?.trim() || null,
      intakeKcalToday: intakeToday ? intakeToday.kcal : null,
      intakeProteinToday: intakeToday ? intakeToday.protein : null,
      goalToday,
      writesCount: (window.__TEST_WRITES__ || []).length,
      maxInflight: window.__TEST_MAX_INFLIGHT__ || 0,
    };
  });

  await browser.close();
  return { label, elapsedMs, state, consoleErrors: ctx.consoleErrors };
}

async function main() {
  // "vorher": fester Stand VOR der Parallelisierung (BEFORE_SHA, Default a40d9dd) aus einer
  // temporaeren Datei. "nachher": die Arbeitskopie (index.html im Repo, aktueller Stand).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuelofit-016-'));
  const oldHtmlPath = path.join(tmpDir, 'index-vorher.html');
  const oldContent = execFileSync('git', ['show', `${BEFORE_SHA}:index.html`], { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 50 }).toString('utf8');
  fs.writeFileSync(oldHtmlPath, oldContent);
  const newHtmlPath = path.join(REPO_ROOT, 'index.html');
  const newContent = fs.readFileSync(newHtmlPath, 'utf8');

  console.log(`BEFORE_SHA = ${BEFORE_SHA}`);
  const promiseAllBefore = countPromiseAllInLoadAllData(oldContent);
  const promiseAllAfter = countPromiseAllInLoadAllData(newContent);
  console.log(`Promise.all in loadAllData: vorher=${promiseAllBefore} nachher=${promiseAllAfter}`);
  if (!(promiseAllAfter > promiseAllBefore)) {
    console.error('STOPP: vorher/nachher-HTML unterscheiden sich in loadAllData NICHT wie erwartet (kein Beleg fuer Parallelisierung) - Messung wird nicht durchgefuehrt.');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(2);
  }

  const beforeRuns = [];
  const afterRuns = [];
  for (let i = 0; i < REPEATS; i++) {
    console.log(`=== VORHER Lauf ${i + 1}/${REPEATS} (${BEFORE_SHA}, sequentiell) ===`);
    const r = await runOnce(oldHtmlPath, 'vorher');
    console.log(JSON.stringify(r, null, 2));
    beforeRuns.push(r);
  }
  for (let i = 0; i < REPEATS; i++) {
    console.log(`=== NACHHER Lauf ${i + 1}/${REPEATS} (Arbeitskopie, parallel) ===`);
    const r = await runOnce(newHtmlPath, 'nachher');
    console.log(JSON.stringify(r, null, 2));
    afterRuns.push(r);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const before = beforeRuns[0];
  const after = afterRuns[0];
  const beforeMedianMs = median(beforeRuns.map(r => r.elapsedMs));
  const afterMedianMs = median(afterRuns.map(r => r.elapsedMs));
  const beforeMaxInflightMedian = median(beforeRuns.map(r => r.state.maxInflight));
  const afterMaxInflightMedian = median(afterRuns.map(r => r.state.maxInflight));

  console.log('\n=== Vergleich (Median ueber', REPEATS, 'Laeufe) ===');
  console.log('Zeit vorher (ms):', beforeMedianMs, ' / nachher (ms):', afterMedianMs, ' Einzelwerte vorher:', beforeRuns.map(r => r.elapsedMs), ' nachher:', afterRuns.map(r => r.elapsedMs));
  console.log('max. gleichzeitig offene Reads vorher (Median):', beforeMaxInflightMedian, ' / nachher (Median):', afterMaxInflightMedian, ' Einzelwerte vorher:', beforeRuns.map(r => r.state.maxInflight), ' nachher:', afterRuns.map(r => r.state.maxInflight));

  const stateKeys = Object.keys(before.state).filter(k => k !== 'maxInflight');
  let stateIdentical = true;
  for (const k of stateKeys) {
    if (JSON.stringify(before.state[k]) !== JSON.stringify(after.state[k])) {
      stateIdentical = false;
      console.log(`ABWEICHUNG bei ${k}: vorher=${JSON.stringify(before.state[k])} nachher=${JSON.stringify(after.state[k])}`);
    }
  }
  console.log('Endzustand identisch (ohne maxInflight):', stateIdentical);
  console.log('Konsolenfehler vorher:', beforeRuns.map(r => r.consoleErrors));
  console.log('Konsolenfehler nachher:', afterRuns.map(r => r.consoleErrors));

  const consoleErrorsAny = beforeRuns.some(r => r.consoleErrors.length) || afterRuns.some(r => r.consoleErrors.length);

  if (!stateIdentical) {
    console.error('ABWEICHUNG: Endzustand vorher != nachher - siehe oben. KEIN automatischer Rueckbau. WARTE auf Entscheidung.');
    process.exitCode = 3;
    return;
  }
  if (consoleErrorsAny) { console.error('FAIL: Konsolenfehler aufgetreten'); process.exitCode = 1; return; }
  if (!(afterMaxInflightMedian > beforeMaxInflightMedian)) {
    console.error(`AUFFAELLIG: maxInflight (Median) nachher (${afterMaxInflightMedian}) nicht groesser als vorher (${beforeMaxInflightMedian}) - Ursache belegen, nicht automatisch werten.`);
  }
  console.log('\nOK: Endzustand identisch, keine Konsolenfehler.');
}

main().catch(err => { console.error(err); process.exit(1); });

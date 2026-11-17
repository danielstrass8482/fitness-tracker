#!/usr/bin/env node
// 016f - Analyse-Tab komplett entfernen (inkl. Chart.js). Playwright gegen die ECHTE index.html
// (Auth/Firestore gestubbt, synthetische Daten, Viewport 360, siehe tests/README.md). Prueft:
// (1) kein Request mehr an cdnjs.cloudflare.com/Chart.js, keine Konsolenfehler beim Start,
// (2) nur noch 4 Haupt-Tabs, alle rendern, kein leerer Bereich wo der Analyse-Button war,
// (3) alte Tab-Werte "analyse"/"dashboard" (Deeplink ?tab=... und switchTab()) fallen auf
//     "uebersicht" zurueck, kein Fehler - es gibt KEINEN persistenten "letzter Tab"-Wert in
//     localStorage/IndexedDB (grep-geprueft, siehe Bericht); der Deeplink-Mechanismus ist das
//     naechstliegende reale Aequivalent zu einem "alten gespeicherten Wert" und wird hier geprueft,
// (4) Lebensmittel loggen / Training loggen / Plan abhaken / Einstellungen speichern -> keine
//     Konsolenfehler (frueher wurde danach renderDashboard() aufgerufen, jetzt entfernt).
// Zusaetzlich (separate Messung unten): Zeilenzahl und Startzeit vorher (Commit BEFORE_SHA, der
// letzte Stand VOR dieser Aufgabe) / nachher (Arbeitskopie), gleiches Setup wie run-016-start-parallel.js.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const REPO_ROOT = path.join(__dirname, '..');
const STUB_PATH = path.join(__dirname, 'stubs', 'firebase-stub.mjs');
const BEFORE_SHA = process.env.FUELOFIT_016F_BEFORE_SHA || '70e06a7'; // letzter Commit vor 016f (016e)
const REPEATS = 3;

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // 08:00 Europe/Berlin, Montag (fuer Plan-Woche)
const TODAY = '2026-11-16';
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700, protein: 150, carbs: 325, fat: 95 };

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildStore() {
  const u = (p) => `users/${TEST_UID}/${p}`;
  return {
    'foods': [
      { id: 'food0', data: { id: 'food0', name: 'Testfood 0', kcal: 150, protein: 10, carbs: 15, fat: 4 } },
    ],
    [u('settings')]: [{ id: 'main', data: SETTINGS }],
    [u('trainingplans')]: [{
      id: TODAY,
      data: {
        datum: TODAY,
        mo: [{ typ: 'laufen', distanzKm: 5, dauerMin: 30 }],
        di: [], mi: [], do: [], fr: [], sa: [], so: [],
      },
    }],
  };
}

async function scenarioAppStart(browser) {
  const page = await browser.newPage();
  const externalRequests = [];
  page.on('request', req => { if (/cdnjs\.cloudflare\.com/.test(req.url())) externalRequests.push(req.url()); });
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  const navState = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#bottom-nav .tab')).map(b => b.dataset.tab);
    const nav = document.getElementById('bottom-nav');
    return { btns, navChildCount: nav.children.length, chartGlobal: typeof window.Chart };
  });

  await page.close();
  return { name: '1) App-Start: Nav/Netzwerk/Konsole', externalRequests, navState, consoleErrors };
}

async function scenarioAllTabsRender(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });
  const results = {};
  for (const tab of ['uebersicht', 'ernaehrung', 'training', 'einstellungen']) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForTimeout(80);
    results[tab] = await page.evaluate((t) => {
      const panel = document.querySelector('.tab-content.active');
      return {
        activeBtn: document.querySelector('.tab.active')?.dataset.tab,
        panelId: panel?.id || null,
        panelHasContent: (panel?.textContent || '').trim().length > 0,
      };
    }, tab);
  }
  await page.close();
  return { name: '2) Alle 4 Tabs rendern', results, consoleErrors };
}

async function scenarioOldTabFallback(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });
  // Erst einen anderen Tab aktivieren, damit der Rueckfall auf "uebersicht" sichtbar eine
  // tatsaechliche Umschaltung ist (nicht einfach der ohnehin schon aktive Start-Tab).
  await page.click('.tab[data-tab="training"]');
  await page.waitForTimeout(50);
  const afterAnalyse = await page.evaluate(() => { window.switchTab('analyse'); return document.querySelector('.tab.active')?.dataset.tab; });
  await page.waitForTimeout(50);
  await page.click('.tab[data-tab="training"]');
  await page.waitForTimeout(50);
  const afterDashboard = await page.evaluate(() => { window.switchTab('dashboard'); return document.querySelector('.tab.active')?.dataset.tab; });
  await page.close();
  return { name: '3) Alte Tab-Werte analyse/dashboard fallen auf uebersicht zurueck', afterAnalyse, afterDashboard, consoleErrors };
}

async function scenarioDeeplinkFallback(browser) {
  // Simuliert einen alten Bookmark/Link ?tab=analyse (naechstliegendes Aequivalent zu einem alten
  // gespeicherten Tab-Wert - es gibt keine echte Tab-Persistenz in localStorage/IndexedDB).
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(String(err)));
  await page.setViewportSize({ width: 360, height: 800 });
  const stubSrc = fs.readFileSync(STUB_PATH, 'utf8');
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: stubSrc }));
  await page.route(/^https:\/\/(?!www\.gstatic\.com)/, route => route.abort());
  await page.addInitScript(({ store }) => { window.__TEST_STORE__ = store; window.__TEST_WRITES__ = []; }, { store: buildStore() });
  await page.clock.install({ time: new Date(FIXED_TIME_ISO) });
  await page.goto('file://' + path.join(REPO_ROOT, 'index.html') + '?tab=analyse');
  await page.waitForSelector('#app-container.show', { timeout: 15000 });
  await page.waitForTimeout(700); // Deeplink-Handler wartet 500ms (setTimeout)
  const activeTab = await page.evaluate(() => document.querySelector('.tab.active')?.dataset.tab);
  await page.close();
  return { name: '4) Deeplink ?tab=analyse faellt auf uebersicht zurueck', activeTab, consoleErrors };
}

async function scenarioGoldenPathActions(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  // Lebensmittel loggen
  await page.evaluate(() => window.openAddFood());
  await page.evaluate(() => window.selectFood('food0'));
  await page.fill('#food-amount', '150');
  await page.evaluate(() => window.saveFood());
  await page.waitForTimeout(80);
  await page.evaluate(() => window.closeAddFood()); // saveFood() schliesst das Modal bei neuen Eintraegen nicht selbst

  // Training loggen (ueber training-sets direkt, umgeht das vorbestehende, 016e-unabhaengige
  // updateHiddenSets-Problem der einzelnen set-reps-Felder - siehe tests/README.md 016e)
  await page.click('.tab[data-tab="training"]');
  await page.waitForTimeout(80);
  await page.click('[data-subtab="training-log"]');
  await page.evaluate((today) => {
    document.getElementById('training-date').value = today;
    document.getElementById('training-type').value = 'pullups';
    document.getElementById('training-sets').value = '12-10-8';
  }, TODAY);
  await page.evaluate(() => window.saveTrainingEntry());
  await page.waitForTimeout(80);

  // Plan abhaken (Training-Tab aktiviert "Plan" als Unter-Tab immer selbst, siehe 016e)
  await page.click('[data-subtab="training-plan"]');
  await page.waitForTimeout(80);
  const abhakenClicked = await page.evaluate(() => {
    const btn = document.querySelector('#training-plan-subtab .fo-checkhit[aria-label="Abhaken"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(80);
  const planCompleteModalVisible = await page.evaluate(() => document.getElementById('plan-complete-modal').style.display === 'flex');
  if (planCompleteModalVisible) {
    await page.click('#plan-complete-save');
    await page.waitForTimeout(80);
  }

  // Einstellungen speichern (gleiches Muster wie run-012d.js)
  await page.evaluate(() => window.switchTab('einstellungen'));
  await page.waitForTimeout(80);
  await page.evaluate(() => window.saveSettings());
  await page.waitForTimeout(80);

  await page.close();
  return {
    name: '5) Lebensmittel/Training/Plan/Einstellungen - keine Konsolenfehler',
    abhakenClicked, planCompleteModalVisible, consoleErrors,
  };
}

async function countReferences(html, term) {
  return (html.match(new RegExp(term, 'g')) || []).length;
}

async function installMinimalTimingHarness(page, { store }) {
  await page.setViewportSize({ width: 360, height: 800 });
  const stubSrc = fs.readFileSync(STUB_PATH, 'utf8');
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: stubSrc }));
  await page.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stub */' }));
  await page.route(/^https:\/\/(?!www\.gstatic\.com|cdnjs\.cloudflare\.com)/, route => route.abort());
  await page.addInitScript(({ store }) => { window.__TEST_STORE__ = store; window.__TEST_WRITES__ = []; }, { store });
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(String(err)));
  return { consoleErrors };
}

async function timingRun(indexHtmlPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const ctx = await installMinimalTimingHarness(page, { store: buildStore() });
  const loadedPromise = page.waitForEvent('console', { predicate: msg => msg.text().startsWith('Loaded:'), timeout: 20000 });
  const navStart = Date.now();
  await page.goto('file://' + indexHtmlPath);
  await loadedPromise;
  const elapsedMs = Date.now() - navStart;
  await browser.close();
  return { elapsedMs, consoleErrors: ctx.consoleErrors };
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  results.push(await scenarioAppStart(browser));
  results.push(await scenarioAllTabsRender(browser));
  results.push(await scenarioOldTabFallback(browser));
  results.push(await scenarioDeeplinkFallback(browser));
  results.push(await scenarioGoldenPathActions(browser));
  await browser.close();

  let ok = true;
  console.log('=== 016f Playwright-Lauf (funktional) ===');

  const r1 = results[0];
  console.log(r1.name + ':', JSON.stringify(r1.navState), 'externe Chart.js-Requests:', r1.externalRequests);
  const r1ok = JSON.stringify(r1.navState.btns) === JSON.stringify(['uebersicht', 'ernaehrung', 'training', 'einstellungen'])
    && r1.navState.navChildCount === 4 && r1.navState.chartGlobal === 'undefined'
    && r1.externalRequests.length === 0 && r1.consoleErrors.length === 0;
  console.log(r1ok ? '  OK' : '  ABWEICHUNG');
  ok = ok && r1ok;

  const r2 = results[1];
  console.log(r2.name + ':', JSON.stringify(r2.results));
  const r2ok = Object.values(r2.results).every(s => s.panelHasContent) && r2.consoleErrors.length === 0
    && r2.results.uebersicht.panelId === 'uebersicht-tab' && r2.results.einstellungen.panelId === 'einstellungen-tab';
  console.log(r2ok ? '  OK' : '  ABWEICHUNG');
  ok = ok && r2ok;

  const r3 = results[2];
  console.log(r3.name + ': afterAnalyse=' + r3.afterAnalyse, 'afterDashboard=' + r3.afterDashboard);
  const r3ok = r3.afterAnalyse === 'uebersicht' && r3.afterDashboard === 'uebersicht' && r3.consoleErrors.length === 0;
  console.log(r3ok ? '  OK' : '  ABWEICHUNG');
  ok = ok && r3ok;

  const r4 = results[3];
  console.log(r4.name + ': activeTab=' + r4.activeTab);
  const r4ok = r4.activeTab === 'uebersicht' && r4.consoleErrors.length === 0;
  console.log(r4ok ? '  OK' : '  ABWEICHUNG');
  ok = ok && r4ok;

  const r5 = results[4];
  console.log(r5.name + ': abhakenClicked=' + r5.abhakenClicked, 'planCompleteModalVisible=' + r5.planCompleteModalVisible);
  if (r5.consoleErrors.length) console.log('  Konsolenfehler:', r5.consoleErrors);
  const r5ok = r5.abhakenClicked === true && r5.planCompleteModalVisible === true && r5.consoleErrors.length === 0;
  console.log(r5ok ? '  OK' : '  ABWEICHUNG');
  ok = ok && r5ok;

  if (!ok) {
    console.log('\nFEHLER: mindestens ein funktionales Szenario entsprach nicht der Erwartung oder hatte Konsolenfehler.');
    process.exit(1);
  }
  console.log('\nOK: alle funktionalen Szenarien wie erwartet, keine Konsolenfehler.');

  // ── Zeilenzahl + Startzeit vorher/nachher ──────────────────────────────────────────────────
  console.log('\n=== Zeilenzahl + Startzeit vorher/nachher (BEFORE_SHA=' + BEFORE_SHA + ') ===');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuelofit-016f-'));
  const oldHtmlPath = path.join(tmpDir, 'index-vorher.html');
  const oldContent = execFileSync('git', ['show', `${BEFORE_SHA}:index.html`], { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 50 }).toString('utf8');
  fs.writeFileSync(oldHtmlPath, oldContent);
  const newHtmlPath = path.join(REPO_ROOT, 'index.html');
  const newContent = fs.readFileSync(newHtmlPath, 'utf8');

  const linesBefore = oldContent.split('\n').length - 1;
  const linesAfter = newContent.split('\n').length - 1;
  console.log('Zeilenzahl index.html: vorher=' + linesBefore + ' nachher=' + linesAfter + ' (Differenz ' + (linesAfter - linesBefore) + ')');

  for (const term of ['renderDashboard', 'renderWorkoutChart', 'aggregateData', 'new Chart\\(', 'data-tab="analyse"']) {
    const before = await countReferences(oldContent, term);
    const after = await countReferences(newContent, term);
    console.log(`grep "${term}": vorher=${before} nachher=${after}`);
  }

  const beforeRuns = [], afterRuns = [];
  for (let i = 0; i < REPEATS; i++) { const r = await timingRun(oldHtmlPath); console.log('vorher Lauf ' + (i + 1) + ':', r.elapsedMs + 'ms', r.consoleErrors.length ? 'Konsolenfehler: ' + JSON.stringify(r.consoleErrors) : ''); beforeRuns.push(r); }
  for (let i = 0; i < REPEATS; i++) { const r = await timingRun(newHtmlPath); console.log('nachher Lauf ' + (i + 1) + ':', r.elapsedMs + 'ms', r.consoleErrors.length ? 'Konsolenfehler: ' + JSON.stringify(r.consoleErrors) : ''); afterRuns.push(r); }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('Startzeit Median (bis Konsolenzeile "Loaded: ..."): vorher=' + median(beforeRuns.map(r => r.elapsedMs)) + 'ms nachher=' + median(afterRuns.map(r => r.elapsedMs)) + 'ms');
  console.log('Einzelwerte vorher:', beforeRuns.map(r => r.elapsedMs), ' nachher:', afterRuns.map(r => r.elapsedMs));
})();

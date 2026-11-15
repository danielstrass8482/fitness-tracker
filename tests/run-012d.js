#!/usr/bin/env node
// 012d - Platzhalter "Angenommene Alltagsschritte" raus. Charakterisierungstest: misst das
// Kalorienziel in drei Faellen gegen die ECHTE index.html (Auth/Firestore gestubbt, feste Uhr,
// nur synthetische Daten, Viewport 360). Vor dem Umbau (VORHER): Fall 1 zeigt den Platzhalter-
// Anteil (+400 kcal). Nach dem Umbau (NACHHER, --after): Fall 1 ohne Platzhalter, Fall 2+3
// exakt wie vorher (siehe Bericht 012d fuer die Zahlen).
//
// Feste Uhr: 2026-11-16 07:00 Europe/Berlin (CET, UTC+1) - absichtlich ein Tag NACH
// STEPS_OURA_FALLBACK_FROM ("2026-11-15"), damit Fall 3 ("gestern" = 2026-11-15) den
// Oura-Rueckfall nimmt und nicht den alten Google-Fit-Rueckfall (date < STEPS_OURA_FALLBACK_FROM).
const { chromium } = require('playwright');
const { installHarness } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T06:00:00.000Z'; // 07:00 Europe/Berlin
const TODAY = '2026-11-16';
const YESTERDAY = '2026-11-15';

const BASE_SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

function buildStore({ todaySteps, yesterdayOuraSteps, assumedDailySteps }) {
  const settingsData = { ...BASE_SETTINGS };
  if (assumedDailySteps !== undefined) settingsData.assumedDailySteps = assumedDailySteps;
  const store = {
    'users/TESTUID0000000000000001/settings': [
      { id: 'main', data: settingsData },
    ],
  };
  if (todaySteps !== undefined) {
    store['users/TESTUID0000000000000001/garminDaily'] = [
      { id: TODAY, data: { steps: todaySteps } },
    ];
  }
  if (yesterdayOuraSteps !== undefined) {
    store['users/TESTUID0000000000000001/oura_daily'] = [
      { id: YESTERDAY, data: { date: YESTERDAY, steps: yesterdayOuraSteps } },
    ];
  }
  return store;
}

async function readGoal(page) {
  return page.evaluate(() => {
    const text = document.getElementById('daily-kcal-goal').textContent.trim();
    // fmt() nutzt deutsche Tausendertrennung ("2.908 kcal") - Punkte vor dem Parsen entfernen
    const m = text.match(/([\d.]+)\s*kcal/);
    return m ? parseInt(m[1].replace(/\./g, ''), 10) : null;
  });
}

async function readProvisionalHidden(page) {
  return page.evaluate(() => {
    const el = document.getElementById('daily-kcal-provisional');
    return el ? el.hidden : null;
  });
}

async function scenario1(browser, after) {
  const page = await browser.newPage();
  const store = buildStore({ assumedDailySteps: after ? undefined : 10000 }); // heute: keine echten Schritte
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store });
  const goal = await readGoal(page);
  const provisionalHidden = await readProvisionalHidden(page);
  await page.close();
  return { name: 'Fall 1: heute 0 Schritte', goal, provisionalHidden, consoleErrors };
}

async function scenario2(browser, after) {
  const page = await browser.newPage();
  const store = buildStore({ todaySteps: 3000 });
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store });
  const goal = await readGoal(page);
  await page.close();
  return { name: 'Fall 2: heute 3000 echte Schritte', goal, consoleErrors };
}

async function scenario3(browser, after) {
  const page = await browser.newPage();
  const store = buildStore({ yesterdayOuraSteps: 7000 }); // gestern kein Garmin, nur Oura
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store });
  await page.evaluate(() => window.changeDate(-1));
  await page.waitForTimeout(100);
  const goal = await readGoal(page);
  await page.close();
  return { name: 'Fall 3: gestern nur Oura-Schritte', goal, consoleErrors };
}

async function settingsTest(browser) {
  const page = await browser.newPage();
  const store = buildStore({ todaySteps: 3000 });
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store });
  const hadInputBefore = await page.evaluate(() => !!document.getElementById('settings-assumed-steps'));
  await page.evaluate(() => window.switchTab('einstellungen'));
  await page.waitForTimeout(100);
  const hasInputAfterOpen = await page.evaluate(() => !!document.getElementById('settings-assumed-steps'));
  await page.evaluate(() => window.saveSettings());
  await page.waitForTimeout(100);
  const writes = await page.evaluate(() => window.__TEST_WRITES__);
  const settingsWrite = writes.find(w => w.path === 'users/TESTUID0000000000000001/settings/main');
  const wroteAssumedSteps = !!(settingsWrite && Object.prototype.hasOwnProperty.call(settingsWrite.data, 'assumedDailySteps'));
  await page.close();
  return { hadInputBefore, hasInputAfterOpen, wroteAssumedSteps, consoleErrors };
}

async function main() {
  const after = process.argv.includes('--after');
  const browser = await chromium.launch();
  const results = [];
  results.push(await scenario1(browser, after));
  results.push(await scenario2(browser, after));
  results.push(await scenario3(browser, after));
  const settings = await settingsTest(browser);
  await browser.close();

  console.log(`\n=== 012d Playwright-Lauf (${after ? 'NACHHER' : 'VORHER'}) ===`);
  for (const r of results) {
    console.log(`${r.name}: Ziel = ${r.goal} kcal${r.provisionalHidden !== undefined ? `, vorlaeufig-hidden=${r.provisionalHidden}` : ''}`);
    if (r.consoleErrors.length) console.log('  Konsolenfehler:', r.consoleErrors);
  }
  console.log('Einstellungen: Eingabefeld vor Oeffnen vorhanden =', settings.hadInputBefore, ', nach Oeffnen vorhanden =', settings.hasInputAfterOpen);
  console.log('Einstellungen: Speichern schreibt assumedDailySteps =', settings.wroteAssumedSteps);
  if (settings.consoleErrors.length) console.log('  Konsolenfehler (Einstellungen):', settings.consoleErrors);

  const anyErrors = results.some(r => r.consoleErrors.length) || settings.consoleErrors.length;
  if (anyErrors) {
    console.error('\nFEHLER: mindestens ein Testlauf hatte Konsolenfehler.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// 016e - Training-Tab: "Plan" ist erster Unter-Tab und wird bei jedem Oeffnen des Training-Tabs
// aktiviert (Klick auf Haupt-Tab, programmatische Navigation ueber switchTab/openPlanToday).
// Playwright gegen die ECHTE index.html (Auth/Firestore gestubbt, Viewport 360, nur synthetische
// Daten). Siehe tests/README.md fuer die Harness.
const { chromium } = require('playwright');
const { installHarness } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-17T07:00:00.000Z'; // 08:00 Europe/Berlin
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

// Vorbestehender, von 016e unabhaengiger Fehler (belegt auch auf unveraendertem HEAD ee15164,
// ohne jede Sub-Tab-Interaktion): updateHiddenSets() ist nicht auf window exponiert, obwohl
// index.html als <script type="module"> laeuft und oninput="updateHiddenSets()" im globalen
// Scope ausgefuehrt wird -> ReferenceError bei jeder Eingabe im Wdh.-Feld. Ausserhalb des
// Auftrags 016e, wird hier nur herausgefiltert, damit er dieses Testergebnis nicht verfaelscht.
const KNOWN_PREEXISTING_ERROR = 'ReferenceError: updateHiddenSets is not defined';
const filterKnown = errs => errs.filter(e => e !== KNOWN_PREEXISTING_ERROR);

function buildStore() {
  return {
    'users/TESTUID0000000000000001/settings': [{ id: 'main', data: SETTINGS }],
  };
}

async function subtabOrderAndState(page) {
  return page.evaluate(() => {
    const seg = document.querySelector('#training-tab .fo-seg');
    const btns = Array.from(seg.querySelectorAll('.sub-tab')).map(b => b.dataset.subtab);
    const planActive = document.getElementById('training-plan-subtab').classList.contains('active');
    const logActive = document.getElementById('training-log-subtab').classList.contains('active');
    const planHasContent = document.getElementById('training-plan-container').innerHTML.trim().length > 0;
    return { btns, planActive, logActive, planHasContent };
  });
}

async function scenario1(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });
  await page.click('.tab[data-tab="training"]');
  await page.waitForTimeout(100);
  const state = await subtabOrderAndState(page);
  await page.close();
  return { name: '1) App start, Training-Tab oeffnen', state, consoleErrors };
}

async function scenario2(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });
  await page.click('.tab[data-tab="training"]');
  await page.waitForTimeout(100);
  // Auf Loggen wechseln, Wiederholungen eintragen
  await page.click('[data-subtab="training-log"]');
  await page.fill('#set-reps-0', '12');
  const afterLogSwitch = await subtabOrderAndState(page);
  // Anderer Haupt-Tab -> zurueck zu Training
  await page.click('.tab[data-tab="uebersicht"]');
  await page.waitForTimeout(50);
  await page.click('.tab[data-tab="training"]');
  await page.waitForTimeout(100);
  const afterReturn = await subtabOrderAndState(page);
  // Erneut Loggen: eingetragener Wert noch da?
  await page.click('[data-subtab="training-log"]');
  const repsValue = await page.inputValue('#set-reps-0');
  await page.close();
  return {
    name: '2) Loggen -> Wert eintragen -> Tab wechseln -> zurueck -> Plan aktiv -> Loggen -> Wert erhalten',
    afterLogSwitch, afterReturn, repsValue, consoleErrors,
  };
}

async function scenario3(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });
  // Startet in Uebersicht; openPlanToday() simuliert den Link "Planvorschlag fuer heute"
  await page.evaluate(() => window.openPlanToday());
  await page.waitForTimeout(100);
  const trainingActive = await page.evaluate(() => document.querySelector('.tab[data-tab="training"]').classList.contains('active'));
  const state = await subtabOrderAndState(page);
  await page.close();
  return { name: '3) openPlanToday() von der Uebersicht', trainingActive, state, consoleErrors };
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  results.push(await scenario1(browser));
  results.push(await scenario2(browser));
  results.push(await scenario3(browser));
  await browser.close();

  let ok = true;
  console.log('=== 016e Playwright-Lauf ===');

  const r1 = results[0];
  console.log(r1.name + ':', JSON.stringify(r1.state));
  const r1ok = JSON.stringify(r1.state.btns) === JSON.stringify(['training-plan', 'training-log'])
    && r1.state.planActive === true && r1.state.logActive === false && r1.state.planHasContent === true
    && r1.consoleErrors.length === 0;
  console.log(r1ok ? '  OK' : '  ABWEICHUNG');
  ok = ok && r1ok;

  const r2 = results[1];
  console.log(r2.name + ':');
  console.log('  nach Wechsel auf Loggen:', JSON.stringify(r2.afterLogSwitch));
  console.log('  nach Rueckkehr zu Training:', JSON.stringify(r2.afterReturn));
  console.log('  Wdh.-Wert nach erneutem Loggen-Wechsel:', r2.repsValue);
  const r2ok = r2.afterLogSwitch.logActive === true && r2.afterLogSwitch.planActive === false
    && r2.afterReturn.planActive === true && r2.afterReturn.logActive === false
    && r2.repsValue === '12' && filterKnown(r2.consoleErrors).length === 0;
  console.log(r2ok ? '  OK' : '  ABWEICHUNG');
  ok = ok && r2ok;

  const r3 = results[2];
  console.log(r3.name + ':', 'trainingActive=' + r3.trainingActive, JSON.stringify(r3.state));
  const r3ok = r3.trainingActive === true && r3.state.planActive === true && r3.state.logActive === false
    && r3.consoleErrors.length === 0;
  console.log(r3ok ? '  OK' : '  ABWEICHUNG');
  ok = ok && r3ok;

  if (!ok) {
    console.log('\nFEHLER: mindestens ein Szenario entsprach nicht der Erwartung oder hatte Konsolenfehler.');
    process.exit(1);
  }
  console.log('\nOK: alle Szenarien wie erwartet, keine Konsolenfehler.');
})();

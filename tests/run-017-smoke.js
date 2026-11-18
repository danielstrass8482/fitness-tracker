#!/usr/bin/env node
// 017 - Smoke-Tests (Auftrag 017 Punkt 5). Playwright gegen die ECHTE index.html (Auth/Firestore
// gestubbt, synthetische Daten, Viewport 360, feste Uhr). Seit 016f nur noch 4 Haupt-Tabs
// (Uebersicht, Ernaehrung, Training, Einstellungen).
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // 08:00 Europe/Berlin
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

function buildStore() {
  return {
    'foods': [{ id: 'food0', data: { id: 'food0', name: 'Testfood Smoke', kcal: 150, protein: 10, carbs: 15, fat: 4 } }],
    [`users/${TEST_UID}/settings`]: [{ id: 'main', data: SETTINGS }],
  };
}

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

// 1) App startet ohne Konsolenfehler, alle 4 Tabs rendern
async function testAppStartAndTabs(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  const results = {};
  for (const tab of ['uebersicht', 'ernaehrung', 'training', 'einstellungen']) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForTimeout(80);
    results[tab] = await page.evaluate((t) => {
      const panel = document.querySelector('.tab-content.active');
      return { activeBtn: document.querySelector('.tab.active')?.dataset.tab, panelHasContent: (panel?.textContent || '').trim().length > 0 };
    }, tab);
  }
  await page.close();

  check('App-Start ohne Konsolenfehler', consoleErrors.length === 0, consoleErrors);
  for (const tab of ['uebersicht', 'ernaehrung', 'training', 'einstellungen']) {
    check(`Tab "${tab}" rendert mit Inhalt`, results[tab].activeBtn === tab && results[tab].panelHasContent === true, results[tab]);
  }
}

// 2) Ein Lebensmittel loggen: protokollierter Write hat korrekte Felder datum UND date (Fallstrick
// aus CLAUDE.md: logEntries tragen beide Felder gleichen Werts, Lesecode nutzt datum||date)
async function testLogFoodWritesDatumAndDate(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await page.evaluate(() => window.openAddFood());
  await page.evaluate(() => window.selectFood('food0'));
  await page.fill('#food-amount', '200');
  await page.evaluate(() => window.saveFood());
  await page.waitForTimeout(100);
  const writes = await page.evaluate(() => window.__TEST_WRITES__);
  await page.close();

  const logWrite = writes.find(w => w.path.includes('/logEntries/'));
  check('Lebensmittel-Write protokolliert', !!logWrite, writes);
  check('Write hat Feld "datum"', !!(logWrite && logWrite.data.datum), logWrite && logWrite.data);
  check('Write hat Feld "date" (gleicher Wert wie "datum")', !!(logWrite && logWrite.data.date && logWrite.data.date === logWrite.data.datum), logWrite && logWrite.data);
  check('foodId korrekt (food0)', logWrite?.data.foodId === 'food0', logWrite && logWrite.data);
  check('amount korrekt (200)', logWrite?.data.amount === 200, logWrite && logWrite.data);
  check('keine Konsolenfehler (Lebensmittel loggen)', consoleErrors.length === 0, consoleErrors);
}

// 3) Modal oeffnen + Zurueck-Taste schliesst es (MODAL_IDS/pushModalState, siehe CLAUDE.md-Fallstrick)
async function testModalBackButtonCloses(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await page.evaluate(() => window.openAddFood());
  await page.waitForTimeout(80);
  const openDisplay = await page.evaluate(() => document.getElementById('add-food-modal').style.display);
  await page.goBack(); // echter Browser-Back -> popstate -> MODAL_IDS-Handler schliesst add-food-modal
  await page.waitForTimeout(80);
  const closedDisplay = await page.evaluate(() => document.getElementById('add-food-modal').style.display);
  await page.close();

  check('Modal nach openAddFood() sichtbar (display != "none")', openDisplay !== 'none', openDisplay);
  check('Modal nach Zurueck-Taste (popstate) geschlossen (display == "none")', closedDisplay === 'none', closedDisplay);
  check('keine Konsolenfehler (Modal/Zurueck-Taste)', consoleErrors.length === 0, consoleErrors);
}

// 4) editFoodDB() oeffnet edit-fooddb-modal, Zurueck-Taste schliesst es (Aufgabe 021 Punkt 6 -
// editFoodDB fehlte bisher der pushModalState()-Aufruf, obwohl das Modal in MODAL_IDS steht)
async function testEditFoodDBBackButtonCloses(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await page.evaluate(() => window.editFoodDB('food0'));
  await page.waitForTimeout(80);
  const openDisplay = await page.evaluate(() => document.getElementById('edit-fooddb-modal').style.display);
  await page.goBack(); // echter Browser-Back -> popstate -> MODAL_IDS-Handler schliesst edit-fooddb-modal
  await page.waitForTimeout(80);
  const closedDisplay = await page.evaluate(() => document.getElementById('edit-fooddb-modal').style.display);
  await page.close();

  check('edit-fooddb-modal nach editFoodDB() sichtbar (display != "none")', openDisplay !== 'none', openDisplay);
  check('edit-fooddb-modal nach Zurueck-Taste (popstate) geschlossen (display == "none")', closedDisplay === 'none', closedDisplay);
  check('keine Konsolenfehler (editFoodDB/Zurueck-Taste)', consoleErrors.length === 0, consoleErrors);
}

// 5) "selected-food-source"-Label (Aufgabe 021 Punkt 7, "OFF-Label-Reset"): openAddFood()/
// selectFood()/editEntry() muessen den Quelle-Tag ("Open Food Facts"/"BLS" einer vorherigen Auswahl)
// zuruecksetzen - sonst zeigt die App bei einer normalen Lebensmittel-Auswahl weiterhin die falsche
// Quelle an (Befund: vorher fehlte dieser Reset komplett).
async function testOFFLabelResets(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await page.evaluate(() => window.openAddFood());
  // OFF-/BLS-Auswahl simulieren (ohne echten Netzwerk-Request): Label wie in searchOpenFoodFacts()/
  // lookupBarcode() nach einem Treffer gesetzt wird.
  await page.evaluate(() => { document.getElementById('selected-food-source').textContent = 'Open Food Facts'; });
  await page.evaluate(() => window.selectFood('food0')); // normale Auswahl aus der eigenen Datenbank
  const afterSelectFood = await page.evaluate(() => document.getElementById('selected-food-source').textContent);

  await page.evaluate(() => { document.getElementById('selected-food-source').textContent = 'BLS'; });
  await page.evaluate(() => window.closeAddFood());
  await page.evaluate(() => window.openAddFood()); // Modal frisch oeffnen
  const afterReopen = await page.evaluate(() => document.getElementById('selected-food-source').textContent);

  await page.close();

  check('selectFood() setzt das Quelle-Label zurueck (kein "Open Food Facts" mehr nach normaler Auswahl)', afterSelectFood === '', afterSelectFood);
  check('openAddFood() setzt das Quelle-Label beim frischen Oeffnen zurueck (kein "BLS" mehr sichtbar)', afterReopen === '', afterReopen);
  check('keine Konsolenfehler (OFF-Label-Reset)', consoleErrors.length === 0, consoleErrors);
}

async function main() {
  const browser = await chromium.launch();
  console.log('\n=== 017 Smoke-Tests ===');
  await testAppStartAndTabs(browser);
  await testLogFoodWritesDatumAndDate(browser);
  await testModalBackButtonCloses(browser);
  await testEditFoodDBBackButtonCloses(browser);
  await testOFFLabelResets(browser);
  await browser.close();

  if (!ok) { console.error('\nFEHLER: mindestens ein Smoke-Test entsprach nicht der Erwartung.'); process.exit(1); }
  console.log('\nOK: alle Smoke-Tests wie erwartet.');
}

main().catch(e => { console.error(e); process.exit(1); });

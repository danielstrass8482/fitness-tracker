#!/usr/bin/env node
// 017 Punkt 9 - saveSettings() Charakterisierungstests (NICHT bewertet/geaendert, haelt den
// heutigen Stand fest). saveSettings() (index.html ~7607) schreibt users/{uid}/settings/main per
// setDoc OHNE merge, mit genau 11 Feldern: tdee, proteinGoal, carbsGoal, fatGoal, gender, age,
// height, weight, activityLevel, detailDays, recipeDisplay. Jedes andere Feld im Dokument würde
// beim nächsten Speichern verschwinden (siehe Bericht 017, Punkt 9).
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // 08:00 Europe/Berlin
const SETTINGS_PATH = `users/${TEST_UID}/settings/main`;
const EXPECTED_11_FIELDS = ['tdee', 'proteinGoal', 'carbsGoal', 'fatGoal', 'gender', 'age', 'height', 'weight', 'activityLevel', 'detailDays', 'recipeDisplay'];

function buildStore(settingsData) {
  return { [`users/${TEST_UID}/settings`]: [{ id: 'main', data: settingsData }] };
}

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

// (c) Normale Speicherung: protokollierter Payload enthaelt GENAU die 11 Felder, kein merge.
async function testNormalSavePayload(browser) {
  const existing = { tdee: 2700, proteinGoal: 150, carbsGoal: 325, fatGoal: 95, gender: 'male', age: 35, height: 180, weight: 80, activityLevel: 1.55, detailDays: 31, recipeDisplay: 'block' };
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore(existing) });

  await page.evaluate(() => window.switchTab('einstellungen'));
  await page.waitForTimeout(80);
  // Koerperdaten ZUERST aendern (age/height/gender haben oninput/onchange="calcTDEE()", das den
  // tdee-Wert automatisch neu berechnet und ueberschreibt) - tdee/protein/carbs/fat erst DANACH
  // setzen, sonst wuerde calcTDEE() den hier manuell gesetzten tdee-Wert wieder ueberschreiben.
  await page.fill('#settings-age', '36');
  await page.fill('#settings-height', '181');
  await page.fill('#settings-weight', '79.5');
  await page.selectOption('#settings-gender', 'female');
  await page.selectOption('#settings-detail-days', '60');
  await page.selectOption('#settings-recipe-display', 'expanded');
  await page.fill('#settings-tdee', '2600');
  await page.fill('#settings-protein', '160');
  await page.fill('#settings-carbs', '300');
  await page.fill('#settings-fat', '90');
  await page.evaluate(() => window.saveSettings());
  await page.waitForTimeout(100);

  const writes = await page.evaluate(() => window.__TEST_WRITES__);
  await page.close();

  const settingsWrites = writes.filter(w => w.path === SETTINGS_PATH);
  const fullWrite = settingsWrites.find(w => !w.merge);
  // saveSettings() selbst schreibt settings/main GENAU EINMAL (voll, ohne merge). Der zweite Writer
  // aus Punkt 9a ({weight}-merge auf settings/main, ~7179) sitzt NICHT in saveSettings(), sondern in
  // einer anderen Funktion (window.saveDayLog, Tageslog-Gewicht) - saveSettings() ruft bei weight!=null
  // stattdessen upsertTodayWeightLog(weight) auf, das auf users/{uid}/entries/log_YYYYMMDD
  // (merge:true) schreibt, NICHT auf settings/main.
  const todayId = 'log_' + FIXED_TIME_ISO.slice(0, 10).replace(/-/g, '');
  const weightLogWrite = writes.find(w => w.path === `users/${TEST_UID}/entries/${todayId}`);

  check('settings/main GENAU EINMAL geschrieben (kein zweiter Write auf diesen Pfad)', settingsWrites.length === 1, settingsWrites);
  check('setDoc OHNE merge gefunden (saveSettings)', !!fullWrite, settingsWrites);
  check('Payload hat GENAU die 11 erwarteten Felder, keine weiteren, keine fehlenden', fullWrite && JSON.stringify(Object.keys(fullWrite.data).sort()) === JSON.stringify([...EXPECTED_11_FIELDS].sort()), fullWrite && Object.keys(fullWrite.data));
  check('tdee = 2600 (neuer Formularwert)', fullWrite?.data.tdee === 2600, fullWrite?.data);
  check('proteinGoal = 160', fullWrite?.data.proteinGoal === 160, fullWrite?.data);
  check('carbsGoal = 300', fullWrite?.data.carbsGoal === 300, fullWrite?.data);
  check('fatGoal = 90', fullWrite?.data.fatGoal === 90, fullWrite?.data);
  check('gender = female', fullWrite?.data.gender === 'female', fullWrite?.data);
  check('age = 36', fullWrite?.data.age === 36, fullWrite?.data);
  check('height = 181', fullWrite?.data.height === 181, fullWrite?.data);
  check('weight = 79.5', fullWrite?.data.weight === 79.5, fullWrite?.data);
  check('activityLevel unveraendert aus settings.activityLevel (1.55, kein Dropdown mehr)', fullWrite?.data.activityLevel === 1.55, fullWrite?.data);
  check('detailDays = 60', fullWrite?.data.detailDays === 60, fullWrite?.data);
  check('recipeDisplay = expanded', fullWrite?.data.recipeDisplay === 'expanded', fullWrite?.data);
  check('saveSettings() schreibt den Gewichtswert zusaetzlich als Tageslog (entries/log_..., merge:true), NICHT auf settings/main', !!weightLogWrite && weightLogWrite.merge === true && weightLogWrite.data.weight === 79.5, weightLogWrite);
  check('keine Konsolenfehler (normale Speicherung)', consoleErrors.length === 0, consoleErrors);
}

// (d) loadSettings() schlaegt fehl (Firestore-Lesefehler simuliert) -> leeres Formular ->
// saveSettings() schreibt Standardwerte/null und UEBERSCHREIBT damit die echten Werte (kein merge).
async function testSaveAfterLoadFailure(browser) {
  const existing = { tdee: 2700, proteinGoal: 150, carbsGoal: 325, fatGoal: 95, gender: 'female', age: 42, height: 165, weight: 60, activityLevel: 1.55, detailDays: 31, recipeDisplay: 'block' };
  const page = await browser.newPage();
  await page.addInitScript(({ p }) => { window.__TEST_FAIL_PATHS__ = [p]; }, { p: SETTINGS_PATH });
  // installHarness wartet auf #daily-kcal-goal mit Inhalt - das klappt auch ohne geladene Settings
  // (calcHistoricalKcalGoal() faellt ohne height auf {base:0,...} zurueck, Text wird trotzdem gesetzt).
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore(existing) });

  const loadFailed = await page.evaluate(() => {
    // loadSettings() faengt den Fehler intern ab (try/catch) - Beleg, dass der simulierte
    // Lesefehler tatsaechlich griff: das Eingabefeld "Alter" ist LEER (loadSettings() hat das
    // Formular nie befuellt), statt mit dem echten Wert 42.
    return document.getElementById('settings-age').value === '';
  });
  await page.evaluate(() => window.switchTab('einstellungen'));
  await page.waitForTimeout(80);
  await page.evaluate(() => window.saveSettings());
  await page.waitForTimeout(100);
  const writes = await page.evaluate(() => window.__TEST_WRITES__);
  await page.close();

  const fullWrite = writes.find(w => w.path === SETTINGS_PATH && !w.merge);
  const expectedDefaults = { tdee: 2700, proteinGoal: 150, carbsGoal: 325, fatGoal: 95, gender: 'male', age: null, height: null, weight: null, activityLevel: 1.55, detailDays: 31, recipeDisplay: 'block' };

  check('simulierter Lesefehler griff (Formular "Alter" leer statt 42)', loadFailed === true, loadFailed);
  check('setDoc OHNE merge trotz fehlgeschlagenem Laden (volles Ueberschreiben)', !!fullWrite, writes);
  check('Payload = Standardwerte/null (tdee 2700, Protein 150, KH 325, Fett 95, gender male, age/height/weight null) - ueberschreibt Daniels echte Werte (42/165/60/female)', JSON.stringify(fullWrite?.data) === JSON.stringify(expectedDefaults), fullWrite?.data);
  console.log('RISIKO: Speichert jemand die Einstellungen nach einem fehlgeschlagenen Laden (z.B. kurzer Netzausfall beim App-Start), werden Alter/Groesse/Gewicht auf null gesetzt und Kalorien-/Makro-Ziele auf die Standardwerte zurueckgesetzt - OHNE Warnung. Vorschlag (NICHT umgesetzt, nur Befund): saveSettings() koennte bei fehlendem geladenem Zustand (z.B. ein Flag "settingsLoaded") das Speichern verweigern/warnen, statt stillschweigend zu ueberschreiben.');
}

async function main() {
  const browser = await chromium.launch();
  console.log('\n=== 017 Punkt 9: saveSettings() Charakterisierungstests ===');
  await testNormalSavePayload(browser);
  await testSaveAfterLoadFailure(browser);
  await browser.close();

  if (!ok) { console.error('\nFEHLER: mindestens eine saveSettings-Erwartung nicht erfuellt.'); process.exit(1); }
  console.log('\nOK: saveSettings() verhaelt sich wie im Bericht 017 Punkt 9 beschrieben.');
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// 017 Punkt 9 - saveSettings() Charakterisierungstests. saveSettings() (index.html ~7607) schreibt
// users/{uid}/settings/main per setDoc OHNE merge, mit genau 10 Feldern: tdee, proteinGoal,
// carbsGoal, fatGoal, gender, age, height, weight, activityLevel, recipeDisplay (detailDays entfernt,
// Aufgabe 021 Punkt 1 - nirgends ausgewertet). Jedes andere Feld im Dokument würde beim nächsten
// Speichern verschwinden (siehe Bericht 017, Punkt 9).
// Aufgabe 020 Teil 1 (Befund 017 9d): settingsLoaded-Flag, NUR nach erfolgreichem getDoc() gesetzt
// (auch wenn kein Dokument existiert - Neuinstallation). Ohne das Flag verweigert saveSettings() das
// Schreiben und zeigt showConfirm() statt stillschweigend zu ueberschreiben (Szenario d unten, jetzt
// NICHT mehr nur eine Charakterisierung/ein Befund, sondern die behobene Erwartung). Szenario (e)
// neu: kein Dokument vorhanden (Neuinstallation) -> Speichern bleibt erlaubt.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // 08:00 Europe/Berlin
const SETTINGS_PATH = `users/${TEST_UID}/settings/main`;
const EXPECTED_10_FIELDS = ['tdee', 'proteinGoal', 'carbsGoal', 'fatGoal', 'gender', 'age', 'height', 'weight', 'activityLevel', 'recipeDisplay'];

function buildStore(settingsData) {
  return { [`users/${TEST_UID}/settings`]: [{ id: 'main', data: settingsData }] };
}

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

// (c) Normale Speicherung: protokollierter Payload enthaelt GENAU die 10 Felder, kein merge.
async function testNormalSavePayload(browser) {
  const existing = { tdee: 2700, proteinGoal: 150, carbsGoal: 325, fatGoal: 95, gender: 'male', age: 35, height: 180, weight: 80, activityLevel: 1.55, recipeDisplay: 'block' };
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
  await page.selectOption('#settings-recipe-display', 'expanded');
  await page.fill('#settings-tdee', '2600');
  await page.fill('#settings-protein', '160');
  // 027: KH-Feld ist nur Anzeige "automatisch (Rest)" (readonly) - kein Eintippen mehr moeglich
  const carbsField = await page.$eval('#settings-carbs', e => ({ tag: e.tagName, v: e.textContent.trim() }));
  check('027: KH-Feld ist reine Anzeige "automatisch (Rest)" (kein Eingabefeld)', carbsField.tag === 'DIV' && carbsField.v === 'automatisch (Rest)', carbsField);
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
  check('Payload hat GENAU die 10 erwarteten Felder, keine weiteren, keine fehlenden', fullWrite && JSON.stringify(Object.keys(fullWrite.data).sort()) === JSON.stringify([...EXPECTED_10_FIELDS].sort()), fullWrite && Object.keys(fullWrite.data));
  check('tdee = 2600 (neuer Formularwert)', fullWrite?.data.tdee === 2600, fullWrite?.data);
  check('proteinGoal = 160', fullWrite?.data.proteinGoal === 160, fullWrite?.data);
  check('027: carbsGoal = gespeicherter Altwert 325 (unveraendert, kein Loeschen)', fullWrite?.data.carbsGoal === 325, fullWrite?.data);
  check('fatGoal = 90', fullWrite?.data.fatGoal === 90, fullWrite?.data);
  check('gender = female', fullWrite?.data.gender === 'female', fullWrite?.data);
  check('age = 36', fullWrite?.data.age === 36, fullWrite?.data);
  check('height = 181', fullWrite?.data.height === 181, fullWrite?.data);
  check('weight = 79.5', fullWrite?.data.weight === 79.5, fullWrite?.data);
  check('activityLevel unveraendert aus settings.activityLevel (1.55, kein Dropdown mehr)', fullWrite?.data.activityLevel === 1.55, fullWrite?.data);
  check('recipeDisplay = expanded', fullWrite?.data.recipeDisplay === 'expanded', fullWrite?.data);
  check('saveSettings() schreibt den Gewichtswert zusaetzlich als Tageslog (entries/log_..., merge:true), NICHT auf settings/main', !!weightLogWrite && weightLogWrite.merge === true && weightLogWrite.data.weight === 79.5, weightLogWrite);
  check('keine Konsolenfehler (normale Speicherung)', consoleErrors.length === 0, consoleErrors);
}

// (d) loadSettings() schlaegt fehl (Firestore-Lesefehler simuliert) -> settingsLoaded bleibt false ->
// saveSettings() schreibt NICHT (kein setDoc auf settings/main) und zeigt showConfirm() statt
// stillschweigend zu ueberschreiben (020 Teil 1, Befund 017 9d behoben).
async function testSaveAfterLoadFailure(browser) {
  const existing = { tdee: 2700, proteinGoal: 150, carbsGoal: 325, fatGoal: 95, gender: 'female', age: 42, height: 165, weight: 60, activityLevel: 1.55, recipeDisplay: 'block' };
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
  // saveSettings() haengt am offenen showConfirm()-Dialog (Promise loest erst beim Klick auf) -
  // NICHT awaiten, sonst blockiert dieser Aufruf fuer immer.
  page.evaluate(() => { window.saveSettings(); });
  await page.waitForTimeout(100);
  const writesAfterSave = await page.evaluate(() => window.__TEST_WRITES__);
  const dialogVisible = await page.evaluate(() => {
    const d = document.getElementById('confirm-dialog');
    return { display: d?.style.display, message: document.getElementById('confirm-message')?.textContent };
  });
  // "Erneut laden" klicken (confirmDialogResolve(true)) - loadSettings() erneut aufrufen; da
  // __TEST_FAIL_PATHS__ weiterhin greift, schlaegt der Retry ebenfalls fehl, settingsLoaded bleibt
  // false. In BEIDEN Faellen (OK oder Abbrechen) darf saveSettings() in diesem Aufruf nicht
  // geschrieben haben - das pruefen wir bereits oben vor dem Klick.
  await page.evaluate(() => window.confirmDialogResolve && window.confirmDialogResolve(true));
  await page.waitForTimeout(80);
  const writesAfterRetry = await page.evaluate(() => window.__TEST_WRITES__);
  await page.close();

  const settingsWrites = writesAfterRetry.filter(w => w.path === SETTINGS_PATH);

  check('simulierter Lesefehler griff (Formular "Alter" leer statt 42)', loadFailed === true, loadFailed);
  check('saveSettings() schreibt NICHT auf settings/main (Flag settingsLoaded fehlt)', writesAfterSave.filter(w => w.path === SETTINGS_PATH).length === 0, writesAfterSave);
  check('Dialog (showConfirm) erscheint statt stillschweigendem Ueberschreiben', dialogVisible.display === 'flex', dialogVisible);
  check('Dialogtext warnt vor dem Ueberschreiben', (dialogVisible.message || '').includes('nicht geladen werden'), dialogVisible.message);
  check('auch nach "Erneut laden" (Retry schlaegt wieder fehl) weiterhin KEIN Write auf settings/main', settingsWrites.length === 0, settingsWrites);
  console.log('Befund 017 9d behoben (020 Teil 1): settingsLoaded-Flag verhindert, dass ein fehlgeschlagenes Laden Alter/Groesse/Gewicht auf null und die Ziele auf die Standardwerte zurueckschreibt.');
}

// (e) Kein Dokument vorhanden (Neuinstallation): getDoc() liefert exists():false, aber KEINE
// Exception - settingsLoaded wird trotzdem gesetzt (020 Teil 1, Punkt 1), Speichern bleibt erlaubt.
async function testSaveWithoutExistingDocument(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: { [`users/${TEST_UID}/settings`]: [] } });

  await page.evaluate(() => window.switchTab('einstellungen'));
  await page.waitForTimeout(80);
  await page.fill('#settings-age', '30');
  await page.fill('#settings-height', '175');
  await page.fill('#settings-weight', '70');
  await page.evaluate(() => window.saveSettings());
  await page.waitForTimeout(100);
  const writes = await page.evaluate(() => window.__TEST_WRITES__);
  const dialogVisible = await page.evaluate(() => document.getElementById('confirm-dialog')?.style.display === 'flex');
  await page.close();

  const fullWrite = writes.find(w => w.path === SETTINGS_PATH && !w.merge);
  check('kein Dialog (Laden war erfolgreich, auch ohne vorhandenes Dokument)', dialogVisible === false, dialogVisible);
  check('saveSettings() schreibt trotz fehlendem Vorgaenger-Dokument (Neuinstallation, Speichern erlaubt)', !!fullWrite, writes);
  check('keine Konsolenfehler (Neuinstallation)', consoleErrors.length === 0, consoleErrors);
}

async function main() {
  const browser = await chromium.launch();
  console.log('\n=== 017 Punkt 9 / 020 Teil 1: saveSettings()-Schutz ===');
  await testNormalSavePayload(browser);
  await testSaveAfterLoadFailure(browser);
  await testSaveWithoutExistingDocument(browser);
  await browser.close();

  if (!ok) { console.error('\nFEHLER: mindestens eine saveSettings-Erwartung nicht erfuellt.'); process.exit(1); }
  console.log('\nOK: saveSettings() verhaelt sich wie im Bericht 017 Punkt 9 beschrieben.');
}

main().catch(e => { console.error(e); process.exit(1); });

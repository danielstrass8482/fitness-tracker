#!/usr/bin/env node
// 017 - Formel-Charakterisierungstests (Testsammlung, Aufgabe 017 Punkt 4). Werte = heutiger
// Ist-Stand (17./18.11.2026), NICHT bewertet - Formeln werden hier nicht geaendert. Playwright
// gegen die ECHTE index.html (Auth/Firestore gestubbt, synthetische Daten, Viewport 360,
// feste Uhr). Alle geprueften Funktionen sind auf window exponiert (grep-geprueft):
// calcActivityKcal, calcBmrForDate, calcHistoricalKcalGoal, getActivityStepsForDate,
// getStepsSourceForDate, zirkelPulseBreakdown. Rezept-Nährwerte (recipeNutritionFromIngredients,
// NICHT auf window) werden über den echten UI-Pfad geprüft: openRecipeModal/searchRecipeIngredient/
// addIngredientToRecipe/saveRecipeModal, Beleg über den protokollierten setDoc-Payload.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // 08:00 Europe/Berlin
const DATE = '2026-11-16';
// height=180,age=35,weight=80,gender=male (gleiche Werte wie run-012d.js/run-016f, 012c-Bericht).
// BMR (mifflinStJeorBmr, index.html ~2977): male -> 10*80 + 6.25*180 - 5*35 + 5 = 800+1125-175+5 = 1755.
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };
const BMR_EXPECTED = 1755;

function buildStore(extra) {
  const u = (p) => `users/${TEST_UID}/${p}`;
  return {
    [u('settings')]: [{ id: 'main', data: SETTINGS }],
    ...extra,
  };
}

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

// ── calcActivityKcal: Laufen (1,04) / Intervall/Tempo (1,1) / Gehen/Wandern (MET 3,5) ──────────
// parseHours (index.html ~4119) liest "zeit" als MM:SS, NICHT HH:MM - "60:00" = 1h, "120:00" = 2h.
async function testCalcActivityKcalBasic(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  const r = await page.evaluate(() => ({
    laufenNormal: window.calcActivityKcal({ typ: 'laufen', datum: '2026-11-16', distanz: '10', zeit: '60:00' }),
    laufenIntervall: window.calcActivityKcal({ typ: 'laufen', datum: '2026-11-16', distanz: '10', zeit: '60:00', notiz: 'Intervalltraining' }),
    laufenTempo: window.calcActivityKcal({ typ: 'laufen', datum: '2026-11-16', distanz: '10', zeit: '60:00', notiz: 'Tempolauf' }),
    gehen: window.calcActivityKcal({ typ: 'gehen', datum: '2026-11-16', zeit: '120:00' }),
    wandern: window.calcActivityKcal({ typ: 'wandern', datum: '2026-11-16', zeit: '180:00' }),
  }));
  await page.close();

  // round(1.04*10*80)=832, round(1.1*10*80)=880, round(3.5*80*2)=560, round(3.5*80*3)=840
  check('calcActivityKcal laufen (Faktor 1,04)', r.laufenNormal === 832, r);
  check('calcActivityKcal laufen Intervall (Faktor 1,1, "Intervalltraining")', r.laufenIntervall === 880, r);
  check('calcActivityKcal laufen Tempo (Faktor 1,1, "Tempolauf")', r.laufenTempo === 880, r);
  check('calcActivityKcal gehen (MET 3,5)', r.gehen === 560, r);
  check('calcActivityKcal wandern (MET 3,5)', r.wandern === 840, r);
  check('keine Konsolenfehler (calcActivityKcal Basis)', consoleErrors.filter(e => !e.includes('bls-makros.json')).length === 0, consoleErrors);
}

// ── calcActivityKcal: Zirkel mit Puls-Mischung (zirkelPulseBreakdown) ──────────────────────────
// 1 Runde, 1 Übung (metClass intensiv=5,5), workSec=60s über details[].exIdx (deterministisch,
// keine Schätzung). formelKcal = round(5.5*80*(60/3600)) = round(7.333) = 7.
// Mit linkedGarmin (garminKcal 50, durationSec 300): bmr=1755, durationMin=5,
// garminNetto = 50 - (1755/1440)*5 = 50 - 6.09375 = 43.90625,
// gewichtet = round(7*0.5 + 43.90625*0.5) = round(25.453) = 25, deckel = round(7*1.5) = 11,
// gezaehlt = min(25,11) = 11 (Deckel greift).
// Ohne linkedGarmin: zirkelPulseBreakdown liefert null (kein g.garminKcal) -> calcActivityKcal
// faellt auf formelKcal (7) zurueck.
async function testCalcActivityKcalZirkel(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  const baseEntry = {
    source: 'plan', typ: 'zirkel', datum: '2026-11-16',
    runden: 1, pauseSec: 0, prepSec: 0, sideSwitchSec: 0,
    uebungen: [{ typ: 'pullups', metClass: 'intensiv' }],
    details: [{ round: 1, exIdx: 0, sec: 60 }],
  };
  const r = await page.evaluate((base) => {
    const ohneGarmin = window.calcActivityKcal({ ...base });
    const mitGarmin = window.calcActivityKcal({ ...base, linkedGarmin: { garminKcal: 50, durationSec: 300 } });
    const breakdown = window.zirkelPulseBreakdown({ ...base, linkedGarmin: { garminKcal: 50, durationSec: 300 } }, 7);
    return { ohneGarmin, mitGarmin, breakdown };
  }, baseEntry);
  await page.close();

  check('calcActivityKcal Zirkel ohne Garmin-Verknuepfung = Formel (7 kcal)', r.ohneGarmin === 7, r);
  check('zirkelPulseBreakdown.garminNetto (43,90625)', Math.abs(r.breakdown.garminNetto - 43.90625) < 1e-6, r.breakdown);
  check('zirkelPulseBreakdown.gezaehlt = Deckel (11 kcal, Deckel < Mittelwert)', r.breakdown.gezaehlt === 11, r.breakdown);
  check('calcActivityKcal Zirkel MIT Garmin-Verknuepfung = Puls-Mischung (11 kcal)', r.mitGarmin === 11, r);
  check('keine Konsolenfehler (calcActivityKcal Zirkel/Puls)', consoleErrors.filter(e => !e.includes('bls-makros.json')).length === 0, consoleErrors);
}

// ── BMR (mifflinStJeorBmr ueber calcBmrForDate) ─────────────────────────────────────────────────
async function testBmr(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });
  const bmr = await page.evaluate((d) => window.calcBmrForDate(d), DATE);
  await page.close();
  check('calcBmrForDate (Mifflin-St Jeor, male/80kg/180cm/35J = 1755)', bmr === BMR_EXPECTED, bmr);
  check('keine Konsolenfehler (BMR)', consoleErrors.filter(e => !e.includes('bls-makros.json')).length === 0, consoleErrors);
}

// ── calcHistoricalKcalGoal: liefert IMMER {base, activity, daily, total} ────────────────────────
async function testCalcHistoricalKcalGoalShape(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });
  const r = await page.evaluate((d) => {
    const normal = window.calcHistoricalKcalGoal(d);
    const ohneKoerperdaten = (() => {
      // Zweiter Aufruf mit Datum weit in der Zukunft aendert settings nicht - stattdessen direkt
      // pruefen: Rueckgabeform bleibt gleich, auch im eigenen catch-Zweig (hier nicht auslösbar
      // ohne echten Fehler, daher nur Form-Check auf den Normalfall + Feldtypen).
      return window.calcHistoricalKcalGoal('1999-01-01');
    })();
    return { normal, ohneKoerperdaten, keysNormal: Object.keys(normal).sort(), keysAlt: Object.keys(ohneKoerperdaten).sort() };
  }, DATE);
  await page.close();

  const expectedKeys = ['activity', 'base', 'daily', 'total'];
  check('calcHistoricalKcalGoal Rueckgabe hat genau {base, activity, daily, total}', JSON.stringify(r.keysNormal) === JSON.stringify(expectedKeys), r.keysNormal);
  check('... auch fuer ein Datum ohne eigene Tageslogs (gleiche Form)', JSON.stringify(r.keysAlt) === JSON.stringify(expectedKeys), r.keysAlt);
  check('base = round(BMR * ACTIVITY_FACTOR 1,375) = round(1755*1.375) = 2413', r.normal.base === Math.round(BMR_EXPECTED * 1.375), r.normal);
  check('total = base + activity + daily', r.normal.total === r.normal.base + r.normal.activity + r.normal.daily, r.normal);
  check('keine Konsolenfehler (calcHistoricalKcalGoal)', consoleErrors.filter(e => !e.includes('bls-makros.json')).length === 0, consoleErrors);
}

// ── getActivityStepsForDate / getStepsSourceForDate: Quelle entscheidet Abzugsliste, NIE gemischt ─
// STEPS_OURA_FALLBACK_FROM = '2026-11-15' (index.html ~2559). garminActivityCutoff (erstes Datum
// mit einer echten Garmin-Aktivitaet, hier 2026-11-18 - die fruehere der beiden unten gesetzten
// Aktivitaeten) erzwingt fuer JEDES Datum DAVOR "googlefit", unabhaengig von Oura - deshalb liegt
// der "none"-Testtag (2026-11-20) bewusst NACH dem Cutoff. Feste Uhr: 2026-11-22 08:00 Berlin.
async function testStepsSource(browser) {
  const FIXED = '2026-11-22T07:00:00.000Z'; // 08:00 Europe/Berlin
  const page = await browser.newPage();
  const u = (p) => `users/${TEST_UID}/${p}`;
  const store = buildStore({
    [u('garminDaily')]: [{ id: '2026-11-19', data: { steps: 8000 } }],
    [u('garminActivities')]: [
      { id: 'act_garmin', data: { startLocal: '2026-11-19T07:00:00+01:00', garminType: 'running', steps: 1500 } },
      { id: 'act_oura_day', data: { startLocal: '2026-11-18T07:00:00+01:00', garminType: 'running', steps: 500 } },
    ],
    [u('oura_daily')]: [{ id: '2026-11-18', data: { date: '2026-11-18', steps: 6000 } }],
    [u('entries')]: [
      { id: 'gfit1', data: { typ: 'laufen', datum: '2026-11-10', date: '2026-11-10', schritte: 2000 } },
    ],
  });
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED, store });

  const r = await page.evaluate(() => ({
    garmin: { source: window.getStepsSourceForDate('2026-11-19'), activitySteps: window.getActivityStepsForDate('2026-11-19') },
    googlefit: { source: window.getStepsSourceForDate('2026-11-10'), activitySteps: window.getActivityStepsForDate('2026-11-10') },
    oura: { source: window.getStepsSourceForDate('2026-11-18'), activitySteps: window.getActivityStepsForDate('2026-11-18') },
    none: { source: window.getStepsSourceForDate('2026-11-20'), activitySteps: window.getActivityStepsForDate('2026-11-20') },
  }));
  await page.close();

  check('2026-11-19 (Garmin-Schritte vorhanden) -> Quelle "garmin"', r.garmin.source === 'garmin', r.garmin);
  check('... Abzugsliste = sichtbare Garmin-Aktivitaeten dieses Tages (1500)', r.garmin.activitySteps === 1500, r.garmin);
  check('2026-11-10 (vor Oura-Fallback 15.11., kein Garmin) -> Quelle "googlefit"', r.googlefit.source === 'googlefit', r.googlefit);
  check('... Abzugsliste = Trainingseintraege mit Schritten (2000), NICHT Garmin-Aktivitaeten', r.googlefit.activitySteps === 2000, r.googlefit);
  check('2026-11-18 (kein Garmin, Oura-Schritte, Vergangenheit) -> Quelle "oura"', r.oura.source === 'oura', r.oura);
  check('... Abzugsliste bei "oura" ebenfalls Garmin-Aktivitaeten (500), wie bei "garmin"/"none" (nie gemischt mit googlefit)', r.oura.activitySteps === 500, r.oura);
  check('2026-11-20 (keine Daten, nach dem Cutoff) -> Quelle "none"', r.none.source === 'none', r.none);
  check('... Abzugsliste 0 (keine Garmin-Aktivitaet an diesem Tag)', r.none.activitySteps === 0, r.none);
  check('keine Konsolenfehler (Schritt-Quelle)', consoleErrors.filter(e => !e.includes('bls-makros.json')).length === 0, consoleErrors);
}

// ── Rezept-Naehrwerte aus Zutaten (recipeNutritionFromIngredients, ueber den echten UI-Pfad) ───
async function testRecipeNutrition(browser) {
  const page = await browser.newPage();
  const u = (p) => `users/${TEST_UID}/${p}`;
  const store = buildStore({
    'foods': [
      { id: 'pasta', data: { id: 'pasta', name: 'Testpasta', kcal: 350, protein: 12, carbs: 70, fat: 2 } },
      { id: 'sauce', data: { id: 'sauce', name: 'Testsauce', kcal: 90, protein: 2, carbs: 8, fat: 5 } },
    ],
    [u('recipes')]: [],
  });
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store });

  await page.evaluate(() => window.openRecipeModal());
  await page.fill('#recipe-modal-name', 'Testrezept 017');
  await page.fill('#recipe-ingred-search', 'pasta');
  await page.evaluate(() => window.searchRecipeIngredient());
  await page.evaluate(() => window.addIngredientToRecipe('pasta'));
  await page.fill('#recipe-ingred-search', 'sauce');
  await page.evaluate(() => window.searchRecipeIngredient());
  await page.evaluate(() => window.addIngredientToRecipe('sauce'));
  await page.evaluate(() => window.saveRecipeModal());
  await page.waitForTimeout(80);

  const writes = await page.evaluate(() => window.__TEST_WRITES__);
  await page.close();

  const recipeWrite = writes.find(w => w.path.startsWith(`users/${TEST_UID}/recipes/`));
  const d = recipeWrite && recipeWrite.data;
  // 2x100g Standardmenge je Zutat: totalWeight=200, kcal=350+90=440, protein=12+2=14,
  // carbs=70+8=78, fat=2+5=7 (recipeNutritionFromIngredients, Summe der kopierten Zutaten-Werte).
  check('Rezept-setDoc gefunden (ohne merge, siehe saveRecipeModal)', !!recipeWrite, writes);
  check('Rezept totalWeight = 200g (2x100g)', d?.totalWeight === 200, d);
  check('Rezept kcal = Summe der Zutaten (440)', d?.kcal === 440, d);
  check('Rezept protein = Summe der Zutaten (14)', d?.protein === 14, d);
  check('Rezept carbs = Summe der Zutaten (78)', d?.carbs === 78, d);
  check('Rezept fat = Summe der Zutaten (7)', d?.fat === 7, d);
  check('keine Konsolenfehler (Rezept-Naehrwerte)', consoleErrors.filter(e => !e.includes('bls-makros.json')).length === 0, consoleErrors);
}

async function main() {
  const browser = await chromium.launch();
  console.log('\n=== 017 Formel-Charakterisierungstests ===');
  await testCalcActivityKcalBasic(browser);
  await testCalcActivityKcalZirkel(browser);
  await testBmr(browser);
  await testCalcHistoricalKcalGoalShape(browser);
  await testStepsSource(browser);
  await testRecipeNutrition(browser);
  await browser.close();

  if (!ok) { console.error('\nFEHLER: mindestens eine Formel-Erwartung nicht erfuellt.'); process.exit(1); }
  console.log('\nOK: alle Formel-Charakterisierungstests wie erwartet.');
}

main().catch(e => { console.error(e); process.exit(1); });

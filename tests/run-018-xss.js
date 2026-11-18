#!/usr/bin/env node
// 018 - Zentrales HTML-Escaping (Review S5). Teil A/B: Playwright-Beleg, dass Namen aus
// Open Food Facts/BLS/Rezepten ungefiltert in innerHTML landen (vor dem Fix) bzw. sicher als
// Text erscheinen (nach dem Fix). Zwei Payloads (Auftrag 018 Teil A.1):
//   XSS_HTML:   <img src=x onerror="window.__xss=1">      - HTML/Tag-Injektion in innerHTML
//   XSS_QUOTE:  '); window.__xss2=1; ('                    - Ausbruch aus onclick="...('${name}')"
// Geprueft werden alle Stellen, an denen ein (gestubbtes) Lebensmittel mit einem dieser Namen
// angelegt/gesucht/geloggt/in einem Rezept/im Tagebuch ("Plan") angezeigt wird:
//   - Einstellungen/Ernaehrung > Lebensmittel: fooddb-list (Suche)
//   - Ernaehrung > Tagebuch: meals-container (Loggen + Tagesuebersicht/"Plan")
//   - Tagebuch: Bulk-Zeit-Modal (bulk-time-entry-list)
//   - Rezept anlegen: recipe-ingred-results (Zutatensuche), recipe-modal-ingredients (Zutatenliste)
//   - Ernaehrung > Rezepte: recipe-list (nach dem Speichern)
//   - Essen hinzufuegen > Modus Rezept: recipe-search-results (Rezept auswaehlen)
// window.__xss/__xss2 werden NIE gesetzt (keine Ausfuehrung); die Namen selbst muessen trotzdem
// unveraendert als Text sichtbar sein (textContent), inkl. Sonderzeichen/Umlaute.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // 08:00 Europe/Berlin -> Meal "Morgens"
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

const XSS_HTML = '<img src=x onerror="window.__xss=1">';
const XSS_QUOTE = "'); window.__xss2=1; ('";
const UMLAUT_NAME = 'Müller’s „Bio“ & Co <3'; // Teil B Punkt 4: Sonderzeichen muessen korrekt angezeigt werden

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

function buildStore(foodName, foodId) {
  return {
    'foods': [{ id: foodId, data: { id: foodId, name: foodName, kcal: 150, protein: 10, carbs: 15, fat: 4 } }],
    [`users/${TEST_UID}/settings`]: [{ id: 'main', data: SETTINGS }],
  };
}

// Prueft eine Stelle: liest innerHTML + textContent eines Containers, meldet aber NUR ueber
// window.__xss/__xss2 (echte Codeausfuehrung) als FAIL - roh angezeigtes "<img...>" als Text ist
// nach dem Fix korrekt (escHtml zeigt es sichtbar an, OHNE es auszufuehren).
async function snapshot(page, elId) {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { exists: false };
    return { exists: true, innerHTML: el.innerHTML, textContent: el.textContent, xss: !!window.__xss, xss2: !!window.__xss2 };
  }, elId);
}

async function runFlow(browser, foodName, foodId, label) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore(foodName, foodId) });
  const results = {};

  // 1) Suchen: Einstellungen/Ernaehrung > Lebensmittel (fooddb-list)
  await page.click('.tab[data-tab="ernaehrung"]');
  await page.waitForTimeout(60);
  await page.click('[data-subtab="lebensmittel"]');
  await page.evaluate(() => window.renderFoodDB());
  await page.waitForTimeout(60);
  results.fooddbList = await snapshot(page, 'fooddb-list');

  // 2) Loggen: echter Pfad openAddFood -> selectFood -> saveFood
  await page.click('[data-subtab="tagebuch"]');
  await page.evaluate(() => window.openAddFood());
  await page.evaluate((id) => window.selectFood(id), foodId);
  await page.fill('#food-amount', '150');
  await page.evaluate(() => window.saveFood());
  await page.waitForTimeout(80);
  await page.evaluate(() => window.closeAddFood());
  results.mealsContainerAfterLog = await snapshot(page, 'meals-container');

  // 3) "Plan" / Tagesuebersicht: Tagebuch-Subtab erneut ansehen (gleicher Container, nach Reload der Ansicht)
  await page.click('[data-subtab="lebensmittel"]');
  await page.click('[data-subtab="tagebuch"]');
  await page.waitForTimeout(60);
  results.mealsContainerPlan = await snapshot(page, 'meals-container');

  // 4) Bulk-Zeit-Modal (Teil A Fundliste, Zeile ~6166)
  await page.evaluate(() => window.openBulkTimeEdit('Morgens'));
  await page.waitForTimeout(60);
  results.bulkTimeModal = await snapshot(page, 'bulk-time-entry-list');
  await page.evaluate(() => { const m = document.getElementById('bulk-time-modal'); if (m) m.style.display = 'none'; });

  // 5) Rezept anlegen: Zutat suchen + hinzufuegen, Rezeptname = Payload, speichern
  await page.click('[data-subtab="rezepte"]');
  await page.evaluate(() => window.openAddRecipe());
  await page.fill('#recipe-modal-name', foodName);
  await page.fill('#recipe-ingred-search', foodName.slice(0, 6));
  await page.evaluate(() => window.searchRecipeIngredient());
  await page.waitForTimeout(60);
  results.recipeIngredSearch = await snapshot(page, 'recipe-ingred-results');
  await page.evaluate((id) => window.addIngredientToRecipe(id), foodId);
  await page.waitForTimeout(60);
  results.recipeModalIngredients = await snapshot(page, 'recipe-modal-ingredients');
  await page.evaluate(() => window.saveRecipeModal());
  await page.waitForTimeout(80);
  results.recipeList = await snapshot(page, 'recipe-list');

  // 6) Essen hinzufuegen > Modus Rezept: gespeichertes Rezept suchen (recipe-search-results)
  await page.click('[data-subtab="tagebuch"]');
  await page.evaluate(() => window.openAddFood());
  await page.evaluate(() => window.setAddFoodMode('recipe'));
  await page.fill('#recipe-search-modal', foodName.slice(0, 6));
  await page.evaluate(() => window.searchRecipeModal());
  await page.waitForTimeout(60);
  results.recipeSearchModal = await snapshot(page, 'recipe-search-results');

  await page.close();
  return { results, consoleErrors };
}

function reportFlow(label, foodName, flowResult) {
  console.log(`\n=== Payload ${label}: ${JSON.stringify(foodName)} ===`);
  const { results, consoleErrors } = flowResult;
  let anyExec = false;
  for (const [stelle, r] of Object.entries(results)) {
    if (!r.exists) { check(`${stelle} vorhanden`, false); continue; }
    if (r.xss || r.xss2) anyExec = true;
    const rawTagVisible = /<img\b/i.test(r.innerHTML);
    const textVisible = r.textContent.includes(foodName) || r.textContent.replace(/\s+/g, ' ').includes(foodName.replace(/\s+/g, ' '));
    check(`${stelle}: window.__xss/__xss2 NICHT gesetzt (keine Ausfuehrung)`, !r.xss && !r.xss2, { xss: r.xss, xss2: r.xss2 });
    check(`${stelle}: kein rohes <img onerror> im innerHTML (escaped)`, !rawTagVisible);
    check(`${stelle}: Name als Text sichtbar`, textVisible);
  }
  check('keine Konsolenfehler/Exceptions waehrend des gesamten Durchlaufs', consoleErrors.length === 0, consoleErrors);
  return anyExec;
}

async function testUmlaut(browser) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore(UMLAUT_NAME, 'foodU') });
  await page.click('.tab[data-tab="ernaehrung"]');
  await page.click('[data-subtab="lebensmittel"]');
  await page.evaluate(() => window.renderFoodDB());
  await page.waitForTimeout(60);
  const snap = await snapshot(page, 'fooddb-list');
  await page.close();
  console.log(`\n=== Teil B Punkt 4: Umlaute/Sonderzeichen ${JSON.stringify(UMLAUT_NAME)} ===`);
  check('Name mit Umlauten/Sonderzeichen korrekt als Text sichtbar (fooddb-list)', snap.exists && snap.textContent.includes(UMLAUT_NAME), snap.textContent);
  check('keine Konsolenfehler (Umlaute/Sonderzeichen)', consoleErrors.length === 0, consoleErrors);
}

async function main() {
  const browser = await chromium.launch();
  console.log('\n=== 018 - XSS-Test: Lebensmittelname wird ungefiltert angezeigt? ===');

  const flowHtml = await runFlow(browser, XSS_HTML, 'foodHtml', 'XSS_HTML');
  const execHtml = reportFlow('XSS_HTML (<img onerror>)', XSS_HTML, flowHtml);

  const flowQuote = await runFlow(browser, XSS_QUOTE, 'foodQuote', 'XSS_QUOTE');
  const execQuote = reportFlow("XSS_QUOTE ('); window.__xss2=1; ('", XSS_QUOTE, flowQuote);

  await testUmlaut(browser);

  await browser.close();

  console.log(`\nZusammenfassung Codeausfuehrung: XSS_HTML ${execHtml ? 'AUSGEFUEHRT' : 'nicht ausgefuehrt'}, XSS_QUOTE ${execQuote ? 'AUSGEFUEHRT' : 'nicht ausgefuehrt'}`);
  if (!ok) { console.error('\nFEHLER: mindestens eine Erwartung nicht erfuellt (Details oben).'); process.exit(1); }
  console.log('\nOK: kein XSS - Namen werden sicher als Text angezeigt.');
}

main().catch(e => { console.error(e); process.exit(1); });

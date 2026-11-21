#!/usr/bin/env node
// 026 - Neues Lebensmittel: Kategorie vorschlagen + bestaetigen. Synthetische Daten, Auth/Firestore
// gestubbt, OFF-Suche per page.route gestubbt, Schreibzugriffe nur protokolliert.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };
const KNOWN = { id: 'f_known', name: 'Haferflocken Test', kcal: 370, protein: 13, carbs: 59, fat: 7, kategorie: 'getreide_brot' };
const NOCAT = { id: 'f_nocat', name: 'Mystery Snack', kcal: 400, protein: 5, carbs: 50, fat: 20 };
let ok = true;
function check(n, c, d) { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; }
const writes = p => p.evaluate(() => window.__TEST_WRITES__ || []);
const foodWrites = async p => (await writes(p)).filter(w => w.type === 'set' && String(w.path).startsWith('foods/'));

async function logFood(page, id) {
  await page.evaluate(() => window.openAddFood());
  await page.evaluate(i => window.selectFood(i), id);
  await page.evaluate(() => window.saveFood());
  await page.waitForTimeout(150);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const store = {
    [`users/${TEST_UID}/settings`]: [{ id: 'main', data: SETTINGS }],
    foods: [{ id: KNOWN.id, data: KNOWN }, { id: NOCAT.id, data: NOCAT }],
  };
  const h = await installHarness(page, { fixedTimeIso: '2026-11-16T07:00:00.000Z', store });
  await page.route(/world\.openfoodfacts\.org\/cgi\/search\.pl/, route => route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ products: [{ code: '4001', product_name: 'Test Schoko Riegel', product_name_de: 'Test Schoko Riegel',
      nutriments: { 'energy-kcal_100g': 520, proteins_100g: 6, carbohydrates_100g: 55, fat_100g: 30 },
      categories_tags: ['en:snacks', 'en:sweet-snacks', 'en:chocolates'] }] }) }));

  // 1) bekanntes Lebensmittel mit Kategorie -> kein Dialog
  await logFood(page, KNOWN.id);
  check('bekannt mit Kategorie: kein Dialog', await page.isHidden('#kategorie-confirm-modal'));

  // 2) Katalog ohne Kategorie, kein OFF-Hint, KI gestubbt -> Vorschlag KI
  await page.evaluate(() => { window.__TEST_AI_RESPONSE__ = { content: [{ type: 'text', text: 'suesswaren' }], stop_reason: 'end_turn' }; });
  await logFood(page, NOCAT.id);
  await page.waitForSelector('#kategorie-confirm-modal', { state: 'visible' });
  check('KI-Vorschlag vorausgewaehlt', (await page.inputValue('#kat-confirm-select')) === 'suesswaren');
  check('9 Kategorien + Platzhalter', (await page.$$('#kat-confirm-select option')).length === 10);
  const ai = await page.evaluate(() => window.__TEST_AI_CALLS__);
  check('KI-Call klein (max_tokens <= 100)', ai && ai.length === 1 && ai[0].data.max_tokens <= 100, ai && ai[0].data.max_tokens);
  const before = (await foodWrites(page)).length;
  await page.click('#kat-confirm-later');
  check('Später schliesst Dialog', await page.isHidden('#kategorie-confirm-modal'));
  check('Später: kein foods-Write', (await foodWrites(page)).length === before);
  await logFood(page, NOCAT.id);
  await page.waitForSelector('#kategorie-confirm-modal', { state: 'visible' });
  check('naechstes Loggen: Dialog wieder da', true);
  await page.selectOption('#kat-confirm-select', 'sonstiges');
  await page.click('#kat-confirm-ok');
  await page.waitForTimeout(150);
  let fw = await foodWrites(page);
  const last = fw[fw.length - 1];
  check('Bestaetigen: foods/f_nocat mit Kategorie, Naehrwerte erhalten', last && last.path === 'foods/f_nocat' && last.data.kategorie === 'sonstiges' && last.data.kcal === 400, last && last.data);
  await logFood(page, NOCAT.id);
  check('danach kein Dialog mehr', await page.isHidden('#kategorie-confirm-modal'));

  // 3) OFF-Treffer: Vorschlag aus OFF-Kategorien (kein KI-Call), foods-Dokument angelegt
  await page.evaluate(() => { window.__TEST_AI_CALLS__ = []; });
  await page.evaluate(() => window.openAddFood());
  await page.fill('#food-search', 'schoko');
  await page.evaluate(() => window.searchOpenFoodFacts());
  await page.waitForSelector('[data-off-row]', { timeout: 5000 });
  await page.click('[data-off-row]');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.saveFood());
  await page.waitForSelector('#kategorie-confirm-modal', { state: 'visible' });
  check('OFF: Vorschlag suesswaren aus categories_tags', (await page.inputValue('#kat-confirm-select')) === 'suesswaren');
  check('OFF: kein KI-Call', (await page.evaluate(() => window.__TEST_AI_CALLS__.length)) === 0);
  await page.click('#kat-confirm-ok');
  await page.waitForTimeout(150);
  fw = await foodWrites(page);
  const offw = fw.filter(w => w.path.startsWith('foods/off_'));
  const o = offw[offw.length - 1];
  check('OFF: foods-Dokument mit Kategorie + Naehrwerten', o && o.data.kategorie === 'suesswaren' && o.data.kcal === 520 && o.data.source === 'openfoodfacts', o && o.data);
  const logs = (await writes(page)).filter(w => w.type === 'set' && String(w.path).includes('logEntries'));
  check('Log-Eintrag mit foodId des OFF-Lebensmittels', logs.some(w => w.data && String(w.data.foodId).startsWith('off_')), logs.length);

  // 4) Zuordnungstabelle
  const m = await page.evaluate(() => [window.suggestKategorieFromOFF(['en:dairies', 'en:yogurts']), window.suggestKategorieFromOFF(['en:beverages', 'en:waters']), window.suggestKategorieFromOFF(['en:foo']), window.suggestKategorieFromOFF([]), window.suggestKategorieFromOFF(['en:plant-based-foods-and-beverages', 'en:breads'])]);
  check('Mapping Joghurt/Wasser/unbekannt/leer', JSON.stringify(m) === JSON.stringify(['milchprodukte', 'getraenke', null, null, 'getreide_brot']), m);

  const ce = h.consoleErrors.filter(e => !e.includes('bls-makros.json')); // file://-Ladefehler der BLS-Datei, kein App-Fehler
  check('keine Konsolenfehler', ce.length === 0, ce.slice(0, 3));
  await browser.close();
  process.exit(ok ? 0 : 1);
})();

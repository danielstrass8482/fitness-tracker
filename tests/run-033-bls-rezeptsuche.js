#!/usr/bin/env node
// 033 - BLS-Treffer in der Rezept-Zutatensuche. Synthetische Daten, Auth/Firestore gestubbt,
// BLS-Datei (echte data/bls-makros.json) per fetch-Override geliefert (file://), Writes nur protokolliert. 360 px.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const OWN = { id: 'f_hafer', name: 'Haferflocken Eigen', kcal: 370, protein: 13, carbs: 59, fat: 7, kategorie: 'getreide_brot' };
let ok = true;
function check(n, c, d) { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; }
const foodWrites = async p => (await p.evaluate(() => window.__TEST_WRITES__ || [])).filter(w => w.type === 'set' && String(w.path).startsWith('foods/'));

(async () => {
  const blsText = fs.readFileSync(path.join(__dirname, '..', 'data', 'bls-makros.json'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
  await page.addInitScript(txt => {
    const orig = window.fetch.bind(window);
    window.fetch = (u, o) => String(u).includes('bls-makros.json')
      ? Promise.resolve(new Response(txt, { status: 200, headers: { 'content-type': 'application/json' } }))
      : orig(u, o);
  }, blsText);
  const store = {
    [`users/${TEST_UID}/settings`]: [{ id: 'main', data: { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 } }],
    foods: [{ id: OWN.id, data: OWN }],
  };
  const h = await installHarness(page, { fixedTimeIso: '2026-11-16T07:00:00.000Z', store });

  await page.evaluate(() => window.openRecipeModal(null));
  await page.fill('#recipe-ingred-search', 'Haferflocken');
  await page.waitForSelector('#recipe-bls-slot .bls-recipe-item', { timeout: 5000 });
  const order = await page.evaluate(() =>
    [...document.getElementById('recipe-ingred-results').children].map(k => k.id === 'recipe-bls-slot' ? 'SLOT' : 'own'));
  check('eigene Treffer zuerst, danach BLS-Slot', order[0] === 'own' && order[order.length - 1] === 'SLOT', order);
  const nBls = await page.$$eval('.bls-recipe-item', e => e.length);
  const tag = await page.$eval('.bls-recipe-item .fo-tag', e => e.textContent);
  check('BLS-Treffer mit Label BLS', nBls > 0 && tag === 'BLS', { nBls, tag });
  const w0 = (await foodWrites(page)).length;

  await page.click('.bls-recipe-item');
  await page.waitForTimeout(300);
  const fw = (await foodWrites(page)).slice(w0);
  check('ein foods-Write mit id bls_*', fw.length === 1 && /^foods\/bls_/.test(fw[0].path) && fw[0].data.source === 'bls', fw.map(w => w.path));
  const ingText = await page.evaluate(() => document.getElementById('recipe-modal-ingredients').innerText);
  check('Zutat hinzugefuegt (100 g, kcal = Wert je 100 g)', ingText.includes(fw[0].data.name) && ingText.includes(String(fw[0].data.kcal)), ingText.slice(0, 80));

  // zweites Mal derselbe BLS-Treffer: jetzt eigenes Lebensmittel, nicht mehr in der BLS-Liste, kein neuer Write
  const blsId = fw[0].path.split('/')[1];
  await page.fill('#recipe-ingred-search', 'Haferflocken');
  await page.waitForTimeout(400);
  const dup = await page.$$eval('.bls-recipe-item', (els, name) => els.filter(e => e.innerText.includes(name)).length, fw[0].data.name);
  check('adoptierter BLS-Treffer nicht mehr in BLS-Liste', dup === 0, dup);
  await page.evaluate(id => window.addIngredientToRecipe(id), blsId);
  check('zweites Mal: kein neuer foods-Write', (await foodWrites(page)).length === w0 + 1);

  // Lebensmittelsuche unveraendert
  await page.evaluate(() => window.closeRecipeModal());
  await page.evaluate(() => window.openAddFood());
  await page.fill('#food-search', 'haferflocken');
  await page.evaluate(() => window.searchFood && window.searchFood());
  await page.waitForSelector('#bls-results-slot .bls-suggestion-item', { timeout: 5000 });
  check('Lebensmittelsuche: BLS-Treffer weiterhin', (await page.$$('#bls-results-slot .bls-suggestion-item')).length > 0);
  const w2 = (await foodWrites(page)).length;
  await page.click('#bls-results-slot .bls-suggestion-item');
  await page.waitForTimeout(300);
  check('Lebensmittelsuche: Klick adoptiert (1 Write)', (await foodWrites(page)).length === w2 + 1);

  check('keine Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
  await browser.close();
  process.exit(ok ? 0 : 1);
})();

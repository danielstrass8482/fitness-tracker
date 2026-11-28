#!/usr/bin/env node
// 056a - Tagebuch-Zeile: Portions-Eintraege (unit 'portions' bzw. Rezeptblock ohne unit, den
// recipeEntryAmountUnit als Portionen deutet) zeigen "1 Portion"/"<n> Portionen" statt "<amount>g".
// Nur Anzeige: Tagessumme (getDayIntakeTotals) und Mahlzeit-kcal bleiben unveraendert.
// Nur synthetische Daten. Schreibzugriffe muessen 0 sein.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T11:00:00.000Z'; // 12:00 Europe/Berlin
const DAY = '2026-11-16';
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

const E = (id, name, foodId, amount, kcal, extra = {}) => ({ id, data: { id, name, foodId, amount, kcal, protein: 10, carbs: 20, fat: 5, meal: 'Mittags', time: '12:00', datum: DAY, date: DAY, ...extra } });
function buildStore(recipeDisplay) {
  return {
    'foods': [
      { id: 'f_haferflocken', data: { id: 'f_haferflocken', name: 'Testflocken', kcal: 370, protein: 13, carbs: 59, fat: 7, kategorie: 'getreide_brot' } },
      { id: 'f_ruehrei', data: { id: 'f_ruehrei', name: 'Testrührei', kcal: 160, protein: 11, carbs: 1, fat: 12, kategorie: 'sonstiges' } },
    ],
    [`users/${TEST_UID}/settings`]: [{ id: 'main', data: { ...SETTINGS, recipeDisplay } }],
    [`users/${TEST_UID}/recipes`]: [
      { id: 'recipe_quark', data: { id: 'recipe_quark', name: 'Testquark', kcal: 400, protein: 30, carbs: 40, fat: 10, portions: 1, totalWeight: 500,
        ingredients: [{ foodId: 'f_haferflocken', amount: 100 }] } },
    ],
    [`users/${TEST_UID}/logEntries`]: [
      E('e1', 'Testflocken', 'f_haferflocken', 150, 555),                   // Lebensmittel, Gramm
      E('e2', 'Testrührei', 'f_ruehrei', 1, 633.4, { unit: 'portions' }),   // Lebensmittel mit unit portions
      E('e3', 'Testquark', 'recipe_quark', 2, 800),                         // Rezeptblock ohne unit -> Portionen (Heuristik)
      E('e4', 'Testquark', 'recipe_quark', 250, 200, { time: '12:01' }),    // Rezeptblock ohne unit -> Gramm (Heuristik)
      E('e5', 'Testquark', 'recipe_quark', 300, 240, { unit: 'grams', time: '12:02' }), // Rezeptblock unit grams
      E('e6', 'Testquark', 'recipe_quark', 0.5, 200, { unit: 'portions', time: '12:03' }), // halbe Portion
    ],
  };
}

async function rows(page) {
  return page.evaluate(() => [...document.querySelectorAll('#meals-container .fo-diary-row')].map(r => ({
    title: r.querySelector('.fo-row__title').textContent.trim(),
    sub: r.querySelector('.fo-row__sub').textContent.trim(),
    kcal: r.querySelector('.fo-row__end').textContent.trim(),
  })));
}

async function openDiary(browser, recipeDisplay) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore(recipeDisplay) });
  await page.click('.tab[data-tab="ernaehrung"]');
  await page.click('[data-subtab="tagebuch"]');
  await page.evaluate(() => { document.querySelectorAll('#meals-container .meal-entries').forEach(u => u.style.display = 'block'); });
  await page.waitForTimeout(80);
  return { page, consoleErrors };
}

(async () => {
  const browser = await chromium.launch();
  // A) Standardanzeige (Rezeptbloecke)
  {
    const { page, consoleErrors } = await openDiary(browser, 'block');
    const r = await rows(page);
    console.log(JSON.stringify(r));
    const subOf = t => r.filter(x => x.title.includes(t)).map(x => x.sub.replace(/^\d\d:\d\d\s*/, ''));
    check('Gramm-Lebensmittel zeigt "150g"', subOf('Testflocken')[0] === '150g', subOf('Testflocken'));
    check('Lebensmittel unit portions zeigt "1 Portion"', subOf('Testrührei')[0] === '1 Portion', subOf('Testrührei'));
    const q = subOf('Testquark');
    check('Rezeptbloecke: 2 Portionen / 250g / 300g / 0,5 Portionen', JSON.stringify(q) === JSON.stringify(['2 Portionen', '250g', '300g', '0,5 Portionen']), q);
    const tot = await page.evaluate((d) => window.getDayIntakeTotals ? getDayIntakeTotals(d) : null, DAY).catch(() => null);
    const sumRows = r.reduce((s, x) => s + parseFloat(x.kcal.replace(/\./g, '').replace(',', '.')), 0);
    check('Zeilen-kcal (gerundet angezeigt) Summe 2628', sumRows === 2628, sumRows);
    const head = await page.evaluate(() => [...document.querySelectorAll('#meals-container .fo-meal')].find(m => m.textContent.includes('Mittags'))?.querySelector('.fo-meal__kcal')?.textContent || '');
    check('Mahlzeit-kcal unveraendert (2.628)', /^2\.628 kcal/.test(head), head);
    if (tot) check('getDayIntakeTotals kcal 2628,4', Math.abs(tot.kcal - 2628.4) < 1e-9, tot);
    // Schreibzugriffe (geblockt, protokolliert): nur Start-Snapshots der App, keine logEntries/foods/recipes
    const writes = await page.evaluate(() => window.__TEST_WRITES__.map(w => w.path.replace(/\/[^/]+$/, '/*')));
    console.log('blockierte Writes:', JSON.stringify([...new Set(writes)]));
    check('keine Writes auf logEntries/foods/recipes', !writes.some(p => /logEntries|foods|recipes/.test(p)), writes);
    check('keine Konsolenfehler', consoleErrors.length === 0, consoleErrors);
    await page.screenshot({ path: '/tmp/run-056a-tagebuch.png', fullPage: true });
    await page.close();
  }
  // B) Aufgeklappte Rezeptanzeige: Zutatenzeilen bleiben unveraendert (Gramm im Namen, kein "Portion")
  {
    const { page, consoleErrors } = await openDiary(browser, 'expanded');
    const r = await rows(page);
    const ing = r.filter(x => x.title.startsWith('Testflocken (100g)'));
    check('expanded: Zutatenzeilen ohne Portion-Text', ing.length === 4 && ing.every(x => !/Portion/.test(x.sub)), ing.map(x => x.sub));
    const rr = r.filter(x => x.title.includes('Testrührei'));
    check('expanded: Lebensmittel unit portions zeigt "1 Portion"', rr.length === 1 && /1 Portion$/.test(rr[0].sub), rr);
    check('expanded: keine Konsolenfehler', consoleErrors.length === 0, consoleErrors);
    await page.close();
  }
  await browser.close();
  console.log(ok ? '\nALLE OK' : '\nFEHLER');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

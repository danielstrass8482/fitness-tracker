#!/usr/bin/env node
// 015 - Datumsberechnung: UTC-Fehler (new Date().toISOString() statt lokalem Datum) belegen.
// Playwright gegen die ECHTE index.html (Auth/Firestore gestubbt, feste Uhr per page.clock,
// Zeitzone Europe/Berlin, Viewport 360, nur synthetische Daten).
//
// Gepruefte Stelle: loadAllData() 365-Tage-Cutoff (index.html ~3001-3003):
//   const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 365);
//   const cutoffStr = cutoff.toISOString().split('T')[0];
// cutoff.toISOString() wandelt die lokale Uhrzeit nach UTC um. Liegt die lokale Uhrzeit
// zwischen 00:00 und UTC-Versatz-1 Stunden (CET: 00:00-00:59, CEST: 00:00-01:59), zeigt
// toISOString() noch den VORTAG -> cutoffStr ist einen Tag zu frueh -> ein 366 statt 365
// Tage alter logEntries-Eintrag wird zusaetzlich geladen (where('date','>=',cutoffStr)).
//
// Vier Szenarien aus Aufgabe 015 (Europe/Berlin): (a) 00:30 normal, (b) 23:30 normal,
// (c) Woche der Zeitumstellung (Mo 30.03.2026 00:30, Tag nach Sommerzeit-Beginn),
// (d) Montag 00:30 (16.11.2026, keine Zeitumstellungswoche).
// Erwartung je Szenario vorher per Node nachgerechnet (siehe Bericht 015): Abweichung bei
// (a),(c),(d) - jeweils 00:xx-01:xx lokal -, NICHT bei (b) (23:30, kein UTC-Ruecksprung).
//
// Nach dem Fix (Teil B, --after): kein Szenario mehr weicht ab (localDateStr() statt
// toISOString()).
const { chromium } = require('playwright');
const { installHarness } = require('./stubs/harness.js');

const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

// { fixedTimeIso (UTC!), localLabel, exclStr (Eintrag, der bei KORREKTEM Cutoff NICHT geladen
// werden duerfte - 366 Tage vor dem lokalen "heute"), expectDeviation (vorher per Node belegt) }
const SCENARIOS = [
  {
    name: 'a) Mi 18.11.2026 00:30 Berlin (CET)',
    fixedTimeIso: '2026-11-17T23:30:00.000Z',
    exclStr: '2025-11-17',
    expectDeviation: true,
  },
  {
    name: 'b) Mi 18.11.2026 23:30 Berlin (CET)',
    fixedTimeIso: '2026-11-18T22:30:00.000Z',
    exclStr: '2025-11-17',
    expectDeviation: false,
  },
  {
    name: 'c) Mo 30.03.2026 00:30 Berlin (CEST, Tag nach Zeitumstellung 29.03.)',
    fixedTimeIso: '2026-03-29T22:30:00.000Z',
    exclStr: '2025-03-29',
    expectDeviation: true,
  },
  {
    name: 'd) Mo 16.11.2026 00:30 Berlin (CET, normale Woche)',
    fixedTimeIso: '2026-11-15T23:30:00.000Z',
    exclStr: '2025-11-15',
    expectDeviation: true,
  },
];

function buildStore(exclStr) {
  return {
    'users/TESTUID0000000000000001/settings': [{ id: 'main', data: SETTINGS }],
    'users/TESTUID0000000000000001/logEntries': [
      {
        id: 'synthetic_excl_1',
        data: {
          id: 'synthetic_excl_1', name: 'Testeintrag 365/366-Tage-Grenze',
          foodId: 'synthetic_food_1', date: exclStr, datum: exclStr,
          meal: 'Morgens', amount: 100, kcal: 0, protein: 0, carbs: 0, fat: 0, time: '08:00',
        },
      },
    ],
  };
}

async function runScenario(browser, scenario) {
  const page = await browser.newPage({ timezoneId: 'Europe/Berlin' });
  const store = buildStore(scenario.exclStr);
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: scenario.fixedTimeIso, store });
  const loaded = await page.evaluate((d) => !!(window.foodLog && window.foodLog[d]), scenario.exclStr);
  await page.close();
  return { ...scenario, loaded, consoleErrors };
}

async function main() {
  const after = process.argv.includes('--after');
  const browser = await chromium.launch();
  const results = [];
  for (const s of SCENARIOS) results.push(await runScenario(browser, s));
  await browser.close();

  console.log(`\n=== 015 Playwright-Lauf (${after ? 'NACHHER' : 'VORHER'}) ===`);
  let anyMismatch = false;
  let anyErrors = false;
  for (const r of results) {
    const expectedLoaded = after ? false : r.expectDeviation; // nach dem Fix nie mehr geladen
    const ok = r.loaded === expectedLoaded;
    if (!ok) anyMismatch = true;
    if (r.consoleErrors.length) anyErrors = true;
    console.log(`${r.name}: 366-Tage-Eintrag (${r.exclStr}) geladen = ${r.loaded} (erwartet ${expectedLoaded}) ${ok ? 'OK' : 'ABWEICHUNG VON ERWARTUNG!'}`);
    if (r.consoleErrors.length) console.log('  Konsolenfehler:', r.consoleErrors);
  }
  if (anyMismatch || anyErrors) {
    console.error('\nFEHLER: mindestens ein Szenario entsprach nicht der Erwartung oder hatte Konsolenfehler.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

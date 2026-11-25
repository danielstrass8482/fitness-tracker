#!/usr/bin/env node
// 047 - Garmin-Waage mit Vorrang (Daniel 25.11.2026: "A"). Playwright gegen die ECHTE index.html,
// Auth/Firestore gestubbt, NUR synthetische Daten, Viewport 360, feste Uhr. Prueft:
// weightForDate-Prioritaet (Waage vor Handeintrag je Tag), Kalorienziel-Basis nutzt dasselbe Gewicht,
// Anzeige "Waage 76,1 kg (24.11. 05:47)", saveDayLog schreibt merge (Waagen-Felder bleiben),
// saveSettings kopiert einen unveraenderten Waagenwert NICHT als Handeintrag.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-25T07:00:00.000Z'; // 08:00 Berlin
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };
const u = p => `users/${TEST_UID}/${p}`;
const g = (date, kg, hhmm) => ({ weightGarmin: kg, weightGarminTs: `${date}T${hhmm}:00+01:00`, weighInsGarmin: 1, weightSource: 'garmin_scale' });
const LOGS = [
  // nur manuell
  { id: 'log_20261101', data: { id: 'log_20261101', datum: '2026-11-01', typ: 'tageslog', weight: 77.0 } },
  // Waage + manuell am selben Tag -> Waage
  { id: 'log_20261118', data: { id: 'log_20261118', datum: '2026-11-18', typ: 'tageslog', weight: 75.0, steps: 1234, ...g('2026-11-18', 75.4, '05:29') } },
  // nur Waage
  { id: 'log_20261120', data: { id: 'log_20261120', datum: '2026-11-20', typ: 'tageslog', ...g('2026-11-20', 76.33, '05:26') } },
  // Handeintrag an einem spaeteren Tag als die letzte Waage -> Handeintrag
  { id: 'log_20261121', data: { id: 'log_20261121', datum: '2026-11-21', typ: 'tageslog', weight: 74.0 } },
  { id: 'log_20261124', data: { id: 'log_20261124', datum: '2026-11-24', typ: 'tageslog', ...g('2026-11-24', 76.14, '05:47') } },
];

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

async function main() {
  const browser = await chromium.launch();
  // ── Prioritaet + Kalorienziel + Anzeige ────────────────────────────────────
  {
    const page = await browser.newPage();
    const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: {
      [u('settings')]: [{ id: 'main', data: SETTINGS }], [u('entries')]: LOGS } });
    const r = await page.evaluate(() => ({
      d1031: weightForDate('2026-10-31'), d1101: weightForDate('2026-11-01'), d1118: weightForDate('2026-11-18'),
      d1119: weightForDate('2026-11-19'), d1120: weightForDate('2026-11-20'), d1121: weightForDate('2026-11-21'),
      d1123: weightForDate('2026-11-23'), d1124: weightForDate('2026-11-24'), d1125: weightForDate('2026-11-25'),
      base1124: calcHistoricalKcalGoal('2026-11-24').base, bmr1124: calcBmrForDate('2026-11-24'),
      base1121: calcHistoricalKcalGoal('2026-11-21').base,
      hint: document.getElementById('settings-weight-hint').textContent,
      field: document.getElementById('settings-weight').value,
    }));
    check('keine Waage/kein Log -> settings.weight', r.d1031 === 80, r.d1031);
    check('nur manuell -> manuell', r.d1101 === 77, r.d1101);
    check('Waage + manuell selber Tag -> Waage', r.d1118 === 75.4, r.d1118);
    check('Folgetag ohne Eintrag -> letzter Tag (Waage)', r.d1119 === 75.4, r.d1119);
    check('nur Waage -> Waage', r.d1120 === 76.33, r.d1120);
    check('Waage frueher + manuell spaeter -> manuell spaeter', r.d1121 === 74 && r.d1123 === 74, [r.d1121, r.d1123]);
    check('24.11. -> 76.14', r.d1124 === 76.14 && r.d1125 === 76.14, [r.d1124, r.d1125]);
    // Mifflin-St. Jeor unveraendert: 10*76.14 + 6.25*180 - 5*35 + 5 = 1716.4; base = round(1716.4*1.375) = 2360
    check('BMR 24.11. mit 76,14 kg', Math.abs(r.bmr1124 - 1716.4) < 1e-9, r.bmr1124);
    check('Kalorienziel-Basis 24.11. = round(1716,4*1,375) = 2360', r.base1124 === 2360, r.base1124);
    check('Kalorienziel-Basis 21.11. mit 74 kg = round(1695*1,375) = 2331', r.base1121 === 2331, r.base1121);
    check('Anzeige Einstellungen "Waage 76,1 kg (24.11. 05:47)"', r.hint.includes('Waage 76,1 kg (24.11. 05:47)') && r.hint.includes('Handeintrag zählt nur an Tagen ohne Wiegung'), r.hint);
    check('Einstellungsfeld = Gewicht von heute (Waage)', r.field === '76.14', r.field);

    // Tageslog-Hinweis fuer gewaehlten Tag
    await page.evaluate(() => { document.getElementById('log-date').value = '2026-11-20'; renderWeightHints(); });
    const lh = await page.textContent('#log-weight-hint');
    check('Tageslog-Hinweis 20.11.', lh.includes('Waage 76,3 kg (20.11. 05:26)') && lh.includes('Handeintrag wird nicht verwendet'), lh);
    await page.evaluate(() => { document.getElementById('log-date').value = '2026-11-21'; renderWeightHints(); });
    check('Tageslog-Hinweis leer ohne Wiegung', (await page.textContent('#log-weight-hint')) === '');

    // saveDayLog: merge, Waagen-Felder bleiben lokal erhalten
    await page.evaluate(() => { window.__TEST_WRITES__.length = 0; document.getElementById('log-date').value = '2026-11-18'; document.getElementById('log-weight').value = '75.2'; });
    await page.evaluate(() => saveDayLog());
    const w1 = await page.evaluate(() => window.__TEST_WRITES__.filter(w => w.path.includes('/entries/')));
    check('saveDayLog schreibt merge ohne Waagen-Felder', w1.length === 1 && w1[0].merge === true && w1[0].data.weight === 75.2 && !('weightGarmin' in w1[0].data), w1);
    const loc = await page.evaluate(() => ({ e: trainingEntries.find(e => e.id === 'log_20261118'), w: weightForDate('2026-11-18') }));
    check('lokal: weightGarmin bleibt, Waage zaehlt weiter', loc.e.weightGarmin === 75.4 && loc.e.weight === 75.2 && loc.w === 75.4, loc);

    // saveSettings mit unveraendertem Waagenwert: kein Tageslog-Handeintrag, settings.weight bleibt 80
    await page.evaluate(() => { window.__TEST_WRITES__.length = 0; });
    await page.evaluate(() => saveSettings());
    const w2 = await page.evaluate(() => window.__TEST_WRITES__);
    const sm = w2.find(w => w.path.endsWith('/settings/main'));
    check('saveSettings: settings.weight bleibt 80 (kein Waagenwert kopiert)', sm && sm.data.weight === 80, sm && sm.data.weight);
    check('saveSettings: kein Tageslog-Write', !w2.some(w => w.path.includes('/entries/')), w2.map(w => w.path));

    // saveSettings mit geaendertem Wert: Handeintrag fuer heute wie bisher
    await page.evaluate(() => { window.__TEST_WRITES__.length = 0; document.getElementById('settings-weight').value = '75.8'; });
    await page.evaluate(() => saveSettings());
    const w3 = await page.evaluate(() => window.__TEST_WRITES__);
    const t3 = w3.find(w => w.path.endsWith('/entries/log_20261125'));
    check('saveSettings geaendert: Handeintrag heute (merge, weight 75.8)', t3 && t3.merge && t3.data.weight === 75.8 && !('weightGarmin' in t3.data), t3);
    check('keine Konsolenfehler', consoleErrors.length === 0, consoleErrors);
    await page.screenshot({ path: '/tmp/run-047-settings.png' });
    await page.close();
  }
  await browser.close();
  console.log(ok ? '\nALLE OK' : '\nFEHLER');
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });

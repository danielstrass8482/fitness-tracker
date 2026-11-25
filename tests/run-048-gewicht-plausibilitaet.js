#!/usr/bin/env node
// 048 - Plausibilitaetsfilter Waage (Daniel 25.11.2026: "ja, bitte"). Playwright gegen die ECHTE
// index.html, Auth/Firestore gestubbt, NUR synthetische Daten, Viewport 360, feste Uhr. Prueft:
// Referenz = Median der genutzten Gewichte der 14 Tage davor (sonst letztes genutztes), > 5 kg -> verworfen,
// Handeintraege nie gefiltert, Grenze genau 5 kg gilt, Kalorienziel-Basis nutzt dasselbe Gewicht,
// Hinweise "Waage 61,4 kg verworfen (weicht > 5 kg ab)", kein Handeintrag beim unveraenderten Speichern.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-25T07:00:00.000Z'; // 08:00 Berlin
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };
const u = p => `users/${TEST_UID}/${p}`;
const g = (date, kg, hhmm = '05:30') => ({ weightGarmin: kg, weightGarminTs: `${date}T${hhmm}:00+02:00`, weighInsGarmin: 1, weightSource: 'garmin_scale' });
const log = (date, extra) => { const id = 'log_' + date.replace(/-/g, ''); return { id, data: { id, datum: date, typ: 'tageslog', ...extra } }; };
const LOGS = [
  log('2026-05-01', { weight: 74.0 }),                          // nur Hand
  log('2026-06-02', g('2026-06-02', 74.87)),                    // Ref = letztes davor 74,0 -> ok
  log('2026-06-09', { weight: 75.6, ...g('2026-06-09', 75.56) }), // ok, Waage vor Hand
  log('2026-06-16', g('2026-06-16', 61.42)),                    // Median(74,87; 75,56)=75,215 -> verworfen
  log('2026-06-17', g('2026-06-17', 61.46)),                    // Median(75,56) -> verworfen
  log('2026-06-20', g('2026-06-20', 73.07)),                    // ok
  log('2026-07-01', { weight: 75.0, ...g('2026-07-01', 85) }),  // verworfen, Handeintrag 75 zaehlt
  log('2026-07-05', g('2026-07-05', 80)),                       // Ref 75, genau 5 -> gilt
  log('2026-10-01', { weight: 72.0 }),                          // Hand, 8 kg unter Vortag -> nie gefiltert
  log('2026-11-24', g('2026-11-24', 76.14, '05:47')),           // Ref = letztes 72 -> 4,14 ok
  log('2026-11-25', g('2026-11-25', 61.4, '05:27')),            // heute, verworfen
];

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: {
    [u('settings')]: [{ id: 'main', data: SETTINGS }], [u('entries')]: LOGS } });
  const r = await page.evaluate(() => {
    const w = d => weightForDate(d);
    const p = Object.fromEntries([...weightPlausibility(trainingEntries)].map(([d, v]) => [d, v]));
    return {
      p, d0602: w('2026-06-02'), d0609: w('2026-06-09'), d0616: w('2026-06-16'), d0617: w('2026-06-17'), d0619: w('2026-06-19'),
      d0620: w('2026-06-20'), d0701: w('2026-07-01'), d0705: w('2026-07-05'), d1001: w('2026-10-01'),
      d1124: w('2026-11-24'), d1125: w('2026-11-25'),
      base0616: calcHistoricalKcalGoal('2026-06-16').base,
      hint: document.getElementById('settings-weight-hint').textContent,
      field: document.getElementById('settings-weight').value,
    };
  });
  check('02.06. Referenz = letztes Gewicht davor (74,0) -> gilt', r.p['2026-06-02'].ref === 74 && r.p['2026-06-02'].plausible === true && r.d0602 === 74.87, r.p['2026-06-02']);
  check('09.06. Waage vor Hand', r.d0609 === 75.56 && r.p['2026-06-09'].quelle === 'waage', r.d0609);
  check('16.06. Median 75,215 -> verworfen', Math.abs(r.p['2026-06-16'].ref - 75.215) < 1e-9 && r.p['2026-06-16'].plausible === false && r.p['2026-06-16'].quelle === 'waage_verworfen', r.p['2026-06-16']);
  check('17.06. verworfen (Ref 75,56)', r.p['2026-06-17'].ref === 75.56 && r.p['2026-06-17'].plausible === false, r.p['2026-06-17']);
  check('16.-19.06. genutzt = 75,56', [r.d0616, r.d0617, r.d0619].every(x => x === 75.56), [r.d0616, r.d0617, r.d0619]);
  check('20.06. 73,07 gilt', r.d0620 === 73.07 && r.p['2026-06-20'].plausible === true, r.p['2026-06-20']);
  check('01.07. Waage 85 verworfen, Handeintrag 75 zaehlt', r.d0701 === 75 && r.p['2026-07-01'].plausible === false && r.p['2026-07-01'].quelle === 'waage_verworfen' && r.p['2026-07-01'].used === 75, r.p['2026-07-01']);
  check('05.07. genau 5 kg Abweichung gilt', r.d0705 === 80 && r.p['2026-07-05'].plausible === true, r.p['2026-07-05']);
  check('01.10. Handeintrag nie gefiltert', r.d1001 === 72 && r.p['2026-10-01'].plausible === null, r.p['2026-10-01']);
  check('24.11. 76,14 (Ref 72)', r.d1124 === 76.14 && r.p['2026-11-24'].ref === 72, r.p['2026-11-24']);
  check('25.11. 61,4 verworfen -> 76,14', r.d1125 === 76.14 && r.p['2026-11-25'].plausible === false, r.p['2026-11-25']);
  // Mifflin unveraendert: 10*75.56 + 6.25*180 - 5*35 + 5 = 1710.6; round(1710.6*1.375) = 2352
  check('Kalorienziel-Basis 16.06. mit 75,56 = 2352', r.base0616 === 2352, r.base0616);
  check('Einstellungen-Hinweis verworfen', r.hint.includes('Waage 61,4 kg verworfen (weicht > 5 kg ab)') && !r.hint.includes('Handeintrag zählt nur'), r.hint);
  check('Einstellungsfeld = 76.14', r.field === '76.14', r.field);

  await page.evaluate(() => { document.getElementById('log-date').value = '2026-06-16'; renderWeightHints(); });
  const lh = await page.textContent('#log-weight-hint');
  check('Tageslog-Hinweis 16.06.', lh.startsWith('Waage 61,4 kg verworfen (weicht > 5 kg ab)') && lh.includes('zählt der Handeintrag'), lh);
  await page.evaluate(() => { document.getElementById('log-date').value = '2026-06-09'; renderWeightHints(); });
  const lh2 = await page.textContent('#log-weight-hint');
  check('Tageslog-Hinweis 09.06. normal', lh2.includes('Waage 75,6 kg (09.06. 05:30)') && lh2.includes('zählt die Waage'), lh2);

  // saveSettings unveraendert: Quelle heute = Waage 24.11. -> kein Handeintrag
  await page.evaluate(() => { window.__TEST_WRITES__.length = 0; });
  await page.evaluate(() => saveSettings());
  const w2 = await page.evaluate(() => window.__TEST_WRITES__);
  const sm = w2.find(w => w.path.endsWith('/settings/main'));
  check('saveSettings: settings.weight bleibt 80', sm && sm.data.weight === 80, sm && sm.data.weight);
  check('saveSettings: kein Tageslog-Write', !w2.some(w => w.path.includes('/entries/')), w2.map(w => w.path));

  // Handeintrag am verworfenen Tag zaehlt
  await page.evaluate(() => { window.__TEST_WRITES__.length = 0; document.getElementById('log-date').value = '2026-06-16'; document.getElementById('log-weight').value = '75.1'; });
  await page.evaluate(() => saveDayLog());
  const w3 = await page.evaluate(() => ({ writes: window.__TEST_WRITES__.filter(w => w.path.includes('/entries/')), w: weightForDate('2026-06-16'), w17: weightForDate('2026-06-17') }));
  check('saveDayLog 16.06.: merge, Handeintrag 75,1 zaehlt', w3.writes.length === 1 && w3.writes[0].merge === true && w3.w === 75.1 && w3.w17 === 75.1, w3);
  check('keine Konsolenfehler', consoleErrors.length === 0, consoleErrors);
  await page.screenshot({ path: '/tmp/run-048-settings.png' });
  await browser.close();
  console.log(ok ? '\nALLE OK' : '\nFEHLER');
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });

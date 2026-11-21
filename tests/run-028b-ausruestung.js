#!/usr/bin/env node
// 028b - Ausruestung (Laufschuhe): Standardschuh-Auto-Zuordnung neuer Laeufe (nie Altbestand, nie ueber
// ein bewusstes "Kein Schuh"), Lauf umhaengen (Auswahlfeld in "Letzte Einträge"), km-Summe inkl.
// start_km, Hinweis ab 85 %/100 %, Schuh anlegen + Standard (hoechstens einer), Rueckwirkend-zuordnen mit
// Vorschau + Bestaetigung (Abbrechen schreibt nichts), Ausmustern statt Loeschen, escHtml fuer Namen,
// kein window.alert/confirm/prompt. Synthetische Daten, Auth/Firestore gestubbt, Schreibzugriffe nur
// protokolliert (der Stub schreibt NICHT in den Store - die App fuehrt ihren Zustand selbst nach).
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-21T12:00:00.000Z'; // 13:00 Berlin
const U = `users/${TEST_UID}`;
const run = (id, startLocal, m, extra = {}) => ({ id, data: { startLocal, durationSec: 3600, distanceM: m, garminType: 'running', mappedTyp: 'laufen', steps: 9000, avgHr: 140, maxHr: 160, ...extra } });
const STORE = {
  [`${U}/settings`]: [{ id: 'main', data: { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 } }],
  [`${U}/garminActivities`]: [
    run('9001', '2026-11-01T07:00:00+01:00', 10000),                 // Altbestand, vor standard_seit
    run('9002', '2026-11-10T07:00:00+01:00', 12000),                 // manuell Schuh A
    run('9003', '2026-11-21T08:00:00+01:00', 8000),                  // NEU nach standard_seit -> auto A
    run('9004', '2026-11-20T07:00:00+01:00', 5000),                  // nach standard_seit, aber bewusst "Kein Schuh"
    run('9005', '2026-11-19T07:00:00+01:00', 7000),                  // nach standard_seit, ausgeblendet -> nie
    { id: '9006', data: { startLocal: '2026-11-20T15:00:00+01:00', durationSec: 1800, distanceM: 9000, garminType: 'e_bike_fitness', mappedTyp: 'rad_ebike', steps: 0 } }, // kein Lauf
  ],
  [`${U}/garminHidden`]: [{ id: '9005', data: { hiddenAt: '2026-11-19T10:00:00Z' } }],
  [`${U}/gear`]: [{ id: 'gear_A', data: { name: 'Schuh A', typ: 'laufschuh', start_km: 500, wechsel_km: 600, aktiv: true, standard: true, standard_seit: '2026-11-15T00:00:00', angelegt_am: '2026-11-15', ausgemustert_am: null } }],
  [`${U}/gearAssignments`]: [
    { id: '9002', data: { gearId: 'gear_A', quelle: 'manuell', at: '2026-11-10T09:00:00Z' } },
    { id: '9004', data: { gearId: null, quelle: 'manuell', at: '2026-11-20T09:00:00Z' } },
  ],
};
const XSS_NAME = 'Schuh B <img src=x onerror="window.__xss=1">';

let ok = true;
function check(n, c, d) { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; }
const writes = p => p.evaluate(() => window.__TEST_WRITES__ || []);
const gearWrites = async p => (await writes(p)).filter(w => w.path.startsWith(`${U}/gear`));
const itemText = (p, name) => p.evaluate(n => [...document.querySelectorAll('#gear-list .gear-item')].find(el => el.querySelector('.gear-name').textContent === n)?.innerText || null, name);
const itemWarn = (p, name) => p.evaluate(n => [...document.querySelectorAll('#gear-list .gear-item')].find(el => el.querySelector('.gear-name').textContent === n)?.querySelector('.gear-warn')?.dataset.level || null, name);
const selVal = (p, aid) => p.$eval(`select.gear-run-select[data-activity-id="${aid}"]`, s => s.value).catch(() => 'FEHLT');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const T0 = Date.now(); const lap = l => console.log(`  [${((Date.now() - T0) / 1000).toFixed(1)}s] ${l}`);
  await page.addInitScript(() => {
    window.__NATIVE_DIALOGS__ = [];
    window.alert = m => window.__NATIVE_DIALOGS__.push(['alert', m]);
    window.confirm = m => { window.__NATIVE_DIALOGS__.push(['confirm', m]); return false; };
    window.prompt = m => { window.__NATIVE_DIALOGS__.push(['prompt', m]); return null; };
  });
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: STORE });
  await page.evaluate(() => window.switchTab('training'));
  await page.click('button.sub-tab[data-subtab="training-log"]');
  await page.waitForTimeout(150);

  // 1) Start: neuer Lauf bekommt Standardschuh, sonst nichts
  let ws = await gearWrites(page);
  check('Auto: genau 1 Zuordnung geschrieben (9003 -> gear_A, quelle auto)', ws.length === 1 && ws[0].path === `${U}/gearAssignments/9003` && ws[0].data.gearId === 'gear_A' && ws[0].data.quelle === 'auto' && !ws[0].merge, ws);
  check('Auto: Altbestand 9001 (vor standard_seit) nicht zugeordnet', await selVal(page, '9001') === '');
  check('Auto: "Kein Schuh" (9004) nicht überschrieben', await selVal(page, '9004') === '');
  check('Auto: ausgeblendeter Lauf 9005 bekommt nichts', !ws.some(w => w.path.endsWith('/9005')));
  check('Auswahlfeld nur bei Läufen (E-Bike 9006 ohne)', await selVal(page, '9006') === 'FEHLT' && await selVal(page, '9003') === 'gear_A');
  let t = await itemText(page, 'Schuh A');
  check('km inkl. start_km: 500 + 12 + 8 = 520,0 km, 2 Läufe, letzter Lauf 21.11.2026', /520,0 km von 600,0 km · 2 Läufe · letzter Lauf 21\.11\.2026/.test(t), t);
  check('Hinweis 85 % (520/600 = 86,7 %)', await itemWarn(page, 'Schuh A') === '85' && /Wechsel bald prüfen \(87 %\)/.test(t), t);
  check('Anhaltspunkt-Satz sichtbar', /nur ein Anhaltspunkt – entscheidend sind Dämpfung, Sohle und Beschwerden/.test(await page.$eval('#gear-card', el => el.innerText)));

  lap('2) Neuer');
  // 2) Neuer Schuh (XSS-Name), Standard, rückwirkend ab 25.10. - erst Abbrechen, dann Bestätigen
  await page.click('#gear-add-btn');
  await page.fill('#gear-name', XSS_NAME);
  await page.fill('#gear-start-km', '50');
  check('Formular: Standard für neuen Schuh nicht vorausgewählt (A ist schon Standard)', !(await page.isChecked('#gear-standard')));
  await page.check('#gear-standard');
  await page.check('#gear-retro');
  await page.fill('#gear-retro-date', '2026-10-25');
  await page.dispatchEvent('#gear-retro-date', 'change');
  const prev = await page.textContent('#gear-retro-preview');
  check('Vorschau: 1 Lauf (9001), 10,0 km, 3 bereits zugeordnet/ohne Schuh', /1 Lauf ab 25\.10\.2026, 10,0 km · 3 bereits zugeordnet oder bewusst ohne Schuh/.test(prev), prev);
  check('Vorschau schreibt nichts', (await gearWrites(page)).length === 1);
  await page.click('#gear-save-btn');
  await page.waitForSelector('#confirm-dialog', { state: 'visible' });
  const msg = await page.textContent('#confirm-message');
  check('App-Dialog (showConfirm) mit Anzahl/km', /1 Lauf \(10,0 km\) zuordnen/.test(msg), msg);
  await page.click('#confirm-cancel');
  await page.waitForTimeout(100);
  check('Abbrechen: nichts geschrieben', (await gearWrites(page)).length === 1);
  await page.click('#gear-save-btn');
  await page.waitForSelector('#confirm-dialog', { state: 'visible' });
  await page.click('#confirm-ok');
  await page.waitForTimeout(150);
  ws = (await gearWrites(page)).slice(1);
  const newGear = ws.find(w => /\/gear\/gear_\d+$/.test(w.path) && w.data.typ === 'laufschuh');
  const bId = newGear && newGear.path.split('/').pop();
  check('Neuer Schuh: Dokument mit allen Feldern', newGear && newGear.data.name === XSS_NAME && newGear.data.start_km === 50 && newGear.data.wechsel_km === 600 && newGear.data.aktiv === true && newGear.data.standard === true && /^2026-11-21T13:0\d:\d\d$/.test(newGear.data.standard_seit) && newGear.data.angelegt_am === '2026-11-21' && newGear.data.ausgemustert_am === null, newGear);
  check('Höchstens ein Standard: A auf standard:false (merge)', ws.some(w => w.path === `${U}/gear/gear_A` && w.merge && w.data.standard === false));
  check('Rückwirkend: nur 9001 -> neuer Schuh (quelle rueckwirkend)', ws.filter(w => w.path.includes('/gearAssignments/')).length === 1 && ws.some(w => w.path === `${U}/gearAssignments/9001` && w.data.gearId === bId && w.data.quelle === 'rueckwirkend'), ws.filter(w => w.path.includes('/gearAssignments/')));
  t = await itemText(page, XSS_NAME);
  check('Neuer Schuh: 50 + 10 = 60,0 km, 1 Lauf, Standard-Tag', /Standard/.test(t) && /60,0 km von 600,0 km · 1 Lauf/.test(t), t);
  check('Schuh A kein Standard-Tag mehr', await page.$eval('#gear-list .gear-item[data-gear-id="gear_A"]', el => [...el.querySelectorAll('.fo-tag')].map(x => x.textContent).join()) === '');
  check('escHtml: kein XSS ausgelöst, Name als Text im Auswahlfeld', !(await page.evaluate(() => window.__xss)) && (await page.$$eval('select.gear-run-select[data-activity-id="9001"] option', o => o.map(x => x.textContent))).includes(XSS_NAME));

  lap('3) Lauf');
  // 3) Lauf umhängen: 9002 von A auf neuen Schuh
  await page.selectOption('select.gear-run-select[data-activity-id="9002"]', bId);
  await page.waitForTimeout(100);
  const mv = (await gearWrites(page)).filter(w => w.path === `${U}/gearAssignments/9002`).pop();
  check('Umhängen: Write gearAssignments/9002 (gearId neu, quelle manuell)', mv && mv.data.gearId === bId && mv.data.quelle === 'manuell', mv);
  check('Umhängen: A = 508,0 km (kein Hinweis, 84,7 %), neu = 72,0 km', /508,0 km/.test(await itemText(page, 'Schuh A')) && await itemWarn(page, 'Schuh A') === null && /72,0 km .* 2 Läufe/.test(await itemText(page, XSS_NAME)));

  lap('4) Wechse');
  // 4) Wechsel-km von A auf 500 -> 101,6 % -> Hinweis 100 %
  await page.evaluate(() => window.openGearForm('gear_A'));
  check('Bearbeiten: Standard/Rückwirkend ausgeblendet', await page.$eval('#gear-form-new-only', el => el.style.display) === 'none');
  await page.fill('#gear-wechsel-km', '500');
  await page.click('#gear-save-btn');
  await page.waitForTimeout(100);
  const ed = (await gearWrites(page)).filter(w => w.path === `${U}/gear/gear_A`).pop();
  check('Bearbeiten: merge-Write nur name/start_km/wechsel_km', ed && ed.merge && ed.data.wechsel_km === 500 && Object.keys(ed.data).sort().join() === 'name,start_km,wechsel_km', ed);
  t = await itemText(page, 'Schuh A');
  check('Hinweis 100 % (508/500)', await itemWarn(page, 'Schuh A') === '100' && /Wechselgrenze erreicht \(102 %\)/.test(t) && await page.$eval('#gear-list .gear-item[data-gear-id="gear_A"] .fo-bar', el => el.classList.contains('is-bad')), t);

  lap('5) Ausmus');
  // 5) Ausmustern (neuer Schuh): App-Dialog, merge aktiv:false, bleibt in Historie
  await page.evaluate(id => { window.retireGear(id); }, bId);
  await page.waitForSelector('#confirm-dialog', { state: 'visible' });
  await page.click('#confirm-ok');
  await page.waitForTimeout(100);
  const rt = (await gearWrites(page)).filter(w => w.path === `${U}/gear/${bId}`).pop();
  check('Ausmustern: merge aktiv:false, standard:false, ausgemustert_am heute', rt && rt.merge && rt.data.aktiv === false && rt.data.standard === false && rt.data.ausgemustert_am === '2026-11-21', rt);
  check('Kein Löschen (deleteDoc) auf gear/gearAssignments', !(await writes(page)).some(w => w.type === 'delete' && w.path.includes('/gear')));
  t = await itemText(page, XSS_NAME);
  check('Ausgemustert sichtbar mit km (Historie bleibt)', /Ausgemustert/.test(t) && /72,0 km/.test(t), t);
  const opts3 = await page.$$eval('select.gear-run-select[data-activity-id="9003"] option', o => o.map(x => x.textContent));
  const opts1 = await page.$$eval('select.gear-run-select[data-activity-id="9001"] option', o => o.map(x => x.textContent));
  check('Auswahl: ausgemusterter Schuh nur noch dort, wo er zugeordnet ist', !opts3.some(x => x.startsWith('Schuh B')) && opts1.includes(XSS_NAME + ' (ausgemustert)'), { opts3, opts1 });

  check('Kein window.alert/confirm/prompt', (await page.evaluate(() => window.__NATIVE_DIALOGS__)).length === 0);
  check('Keine unbekannten Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors);
  if (process.env.SHOT) { await page.locator('#gear-card').screenshot({ path: '/tmp/028b-gear.png' }); await page.locator('#training-history').screenshot({ path: '/tmp/028b-hist.png' }); }
  await browser.close();
  console.log(ok ? '\n028b: alle Prüfungen grün' : '\n028b: FEHLGESCHLAGEN');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

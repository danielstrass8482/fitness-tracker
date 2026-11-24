#!/usr/bin/env node
// 042 - Notiz + Sensor-Vermerk je Garmin-Aktivitaet (users/{uid}/activityNotes/{activityId}
// {text, ohneBrustgurt, ohnePod, updatedAt}): Button "Notiz" auf Garmin-Zeilen in "Letzte Einträge",
// Sheet mit Textfeld + 2 Schaltern, genau ein Write (set ohne merge), Anzeige der Notiz in der Zeile,
// vorhandene Notiz wird geladen/vorbelegt, Abbrechen/Zurueck schreibt nichts, escHtml, Kalorien
// unveraendert, kein window.alert/confirm/prompt. Synthetische Daten, Auth/Firestore gestubbt.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-24T20:00:00.000Z';
const U = `users/${TEST_UID}`;
const run = (id, startLocal, m, extra = {}) => ({ id, data: { startLocal, durationSec: 3600, distanceM: m, garminType: 'running', mappedTyp: 'laufen', steps: 9000, avgHr: 140, maxHr: 160, garminKcal: 700, ...extra } });
const STORE = {
  [`${U}/settings`]: [{ id: 'main', data: { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 } }],
  [`${U}/garminActivities`]: [
    run('7001', '2026-11-24T08:30:41+01:00', 12000),
    run('7002', '2026-11-19T11:02:33+01:00', 12500),
    { id: '7003', data: { startLocal: '2026-11-24T07:00:00+01:00', durationSec: 1800, distanceM: 9000, garminType: 'e_bike_fitness', mappedTyp: 'rad_ebike', steps: 0, avgHr: 100, maxHr: 120 } },
  ],
  [`${U}/activityNotes`]: [{ id: '7002', data: { text: 'Alt <b>fett</b>', ohneBrustgurt: false, ohnePod: true, updatedAt: '2026-11-19T12:00:00Z' } }],
};
const NOTE = 'Ohne Brustgurt und ohne Pod gelaufen – Puls (Handgelenk) und Laufdynamik nicht auswerten. <img src=x onerror="window.__xss=1">';

let ok = true;
function check(n, c, d) { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; }
const noteWrites = p => p.evaluate(u => (window.__TEST_WRITES__ || []).filter(w => w.path.startsWith(u + '/activityNotes')), U);
const lineText = (p, aid) => p.$eval(`.activity-note-line[data-activity-id="${aid}"]`, el => el.innerText).catch(() => null);
const goalText = p => p.$eval('#daily-kcal-goal', el => el.textContent.trim());

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__NATIVE_DIALOGS__ = [];
    window.alert = m => window.__NATIVE_DIALOGS__.push(['alert', m]);
    window.confirm = m => { window.__NATIVE_DIALOGS__.push(['confirm', m]); return false; };
    window.prompt = m => { window.__NATIVE_DIALOGS__.push(['prompt', m]); return null; };
  });
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: STORE });
  const goal0 = await goalText(page);
  await page.evaluate(() => window.switchTab('training'));
  await page.click('button.sub-tab[data-subtab="training-log"]');
  await page.waitForTimeout(150);

  check('Notiz-Button auf allen Garmin-Zeilen (Lauf + E-Bike)', (await page.$$eval('.activity-note-btn', b => b.map(x => x.dataset.activityId).sort())).join() === '7001,7002,7003');
  const l2 = await lineText(page, '7002');
  check('Vorhandene Notiz in Zeile (Flag + Text als Text, escHtml)', l2 && /ohne Pod – Alt <b>fett<\/b>/.test(l2) && !(await page.$('.activity-note-line[data-activity-id="7002"] b')), l2);
  check('Ohne Notiz keine Zeile (7001)', (await lineText(page, '7001')) === null);
  check('Modal initial versteckt, kein display:flex im Attribut', await page.$eval('#activity-note-modal', el => el.style.display === 'none' && !/display:\s*flex/.test(el.getAttribute('style'))));

  // Vorbelegung vorhandener Notiz + Zurueck-Taste schliesst ohne Write
  await page.click('.activity-note-btn[data-activity-id="7002"]');
  check('Vorbelegung 7002', await page.evaluate(() => [document.getElementById('activity-note-text').value, document.getElementById('activity-note-ohne-brustgurt').checked, document.getElementById('activity-note-ohne-pod').checked].join('|')) === 'Alt <b>fett</b>|false|true');
  await page.goBack();
  await page.waitForTimeout(150);
  check('Zurück-Taste schließt Modal', await page.$eval('#activity-note-modal', el => el.style.display) === 'none');
  check('Zurück: nichts geschrieben', (await noteWrites(page)).length === 0);

  // Abbrechen schreibt nichts
  await page.click('.activity-note-btn[data-activity-id="7001"]');
  check('Neu: leer vorbelegt, Unterzeile mit Datum', await page.evaluate(() => document.getElementById('activity-note-text').value === '' && !document.getElementById('activity-note-ohne-brustgurt').checked && !document.getElementById('activity-note-ohne-pod').checked) && /24\.11\.2026 · 08:30 · laufen/.test(await page.textContent('#activity-note-sub')), await page.textContent('#activity-note-sub'));
  await page.fill('#activity-note-text', 'x');
  await page.click('#activity-note-modal .fo-sheet__foot .fo-btn--secondary');
  check('Abbrechen: nichts geschrieben', (await noteWrites(page)).length === 0);

  // Speichern
  await page.click('.activity-note-btn[data-activity-id="7001"]');
  const box = await page.$eval('#activity-note-modal .fo-sheet', el => { const r = el.getBoundingClientRect(); return { w: r.width, sw: el.scrollWidth }; });
  check('360 px: Sheet passt (kein horizontaler Überlauf)', box.w <= 360 && box.sw <= 360, box);
  await page.fill('#activity-note-text', NOTE);
  await page.check('#activity-note-ohne-brustgurt');
  await page.check('#activity-note-ohne-pod');
  await page.click('#activity-note-modal .fo-btn--primary');
  await page.waitForTimeout(150);
  const ws = await noteWrites(page);
  const w = ws[0];
  check('Genau 1 Write activityNotes/7001, set ohne merge', ws.length === 1 && w.path === `${U}/activityNotes/7001` && !w.merge && w.type !== 'delete', ws);
  check('Payload: text, ohneBrustgurt, ohnePod, updatedAt (ISO)', w && Object.keys(w.data).sort().join() === 'ohneBrustgurt,ohnePod,text,updatedAt' && w.data.text === NOTE && w.data.ohneBrustgurt === true && w.data.ohnePod === true && /^2026-11-24T20:0\d:\d\d\.\d{3}Z$/.test(w.data.updatedAt), w && w.data);
  check('Modal zu nach Speichern', await page.$eval('#activity-note-modal', el => el.style.display) === 'none');
  const l1 = await lineText(page, '7001');
  check('Zeile zeigt Flags + Text', l1 && l1.includes('ohne Brustgurt · ohne Pod – Ohne Brustgurt und ohne Pod gelaufen'), l1);
  check('escHtml: kein XSS', !(await page.evaluate(() => window.__xss)) && !(await page.$('.activity-note-line img')));
  check('Kalorienziel unverändert', (await goalText(page)) === goal0, [goal0, await goalText(page)]);
  check('Nur activityNotes geschrieben (keine anderen Writes durch die Notiz)', (await page.evaluate(() => window.__TEST_WRITES__)).filter(x => /activityNotes/.test(x.path)).length === 1);

  check('Kein window.alert/confirm/prompt', (await page.evaluate(() => window.__NATIVE_DIALOGS__)).length === 0);
  check('Keine unbekannten Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors);
  if (process.env.SHOT) {
    await page.locator('#training-history').screenshot({ path: '/tmp/042-hist.png' });
    await page.click('.activity-note-btn[data-activity-id="7001"]');
    await page.screenshot({ path: '/tmp/042-modal.png' });
  }
  await browser.close();
  console.log(ok ? '\n042: alle Prüfungen grün' : '\n042: FEHLGESCHLAGEN');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

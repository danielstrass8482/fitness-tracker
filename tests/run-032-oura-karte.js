#!/usr/bin/env node
// 032 - Oura-Karte: 6 Kacheln (Ruhepuls, HRV, Tiefschlaf, Gesamtschlaf, Schlafeffizienz,
// Hauttemp.-Trend), Trend = Ø tempDeviation 3 Naechte minus Ø der 28 Naechte davor (>= 2 von 3 und
// >= 14 von 28, sonst "–"), "→" bei |Δ| < 0,1 °C; fehlende Effizienz -> "–". Synthetische Daten,
// Auth/Firestore gestubbt, Viewport 360 px (Harness).
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-22T08:00:00.000Z'; // So 22.11.2026 09:00 Berlin
const TODAY = '2026-11-22';
const U = p => `users/${TEST_UID}/${p}`;

let ok = true;
function check(n, c, d) { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; }

function dayStr(offset) { // TODAY minus offset Tage, lokale Kalenderarithmetik
  const [y, m, d] = TODAY.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - offset));
  return dt.toISOString().slice(0, 10);
}
// nights: offset -> tempDeviation; eff fuer TODAY optional
function oura({ recentTemp, baseTemp, baseNights, effToday }) {
  const rows = [];
  for (let i = 0; i < 3 + baseNights; i++) {
    const date = dayStr(i);
    const data = { date, sleepScore: 80, readinessScore: 78, sleepDurationSec: 7 * 3600, deepSleepSec: 3600,
      hrvAvg: 40, restingHr: 50, tempDeviation: i < 3 ? recentTemp : baseTemp, sleepEfficiency: 88 };
    if (i === 0) { if (effToday === undefined) delete data.sleepEfficiency; else data.sleepEfficiency = effToday; }
    rows.push({ id: date, data });
  }
  return rows;
}
function store(ouraRows) {
  return {
    [U('settings')]: [{ id: 'main', data: { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 } }],
    [U('integrations')]: [{ id: 'oura', data: { connected: true, lastSyncAt: null } }],
    [U('oura_daily')]: ouraRows,
  };
}
const cells = p => p.$$eval('#oura-daily-card .fo-rec__cell', els => els.map(e => ({
  label: e.querySelector('.fo-rec__label')?.textContent.trim(),
  value: e.querySelector('.fo-rec__value')?.textContent.replace(/\s+/g, ' ').trim(),
  trend: e.querySelector('.fo-rec__trend')?.textContent.trim() || null,
  box: (() => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })(),
})));

async function start(browser, s) {
  const page = await browser.newPage();
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: s });
  await page.waitForSelector('#oura-daily-card .fo-rec__cell', { timeout: 10000 });
  return { page, h };
}

(async () => {
  const browser = await chromium.launch();

  // 1) Genug Naechte: recent +0,30, Basis 0,00 -> ↑ +0,3 °C; Effizienz 91 %
  {
    const { page, h } = await start(browser, store(oura({ recentTemp: 0.3, baseTemp: 0, baseNights: 28, effToday: 91 })));
    const c = await cells(page);
    check('6 Kacheln', c.length === 6, c.map(x => x.label));
    check('Reihenfolge/Labels', JSON.stringify(c.map(x => x.label)) === JSON.stringify(['Ruhepuls (letzte Nacht)', 'HRV (letzte Nacht)', 'Tiefschlaf', 'Gesamtschlaf', 'Schlafeffizienz', 'Hauttemp.-Trend']), c.map(x => x.label));
    check('Schlafeffizienz 91 %', c[4].value === '91 %', c[4].value);
    check('Temp-Trend ↑ +0,3 °C', c[5].value === '↑ +0,3 °C', c[5].value);
    check('Kleintext "3 Nächte vs. 28"', c[5].trend === '3 Nächte vs. 28', c[5].trend);
    const xs = [...new Set(c.map(x => x.box.x))], ys = [...new Set(c.map(x => x.box.y))];
    check('Raster 2 Spalten × 3 Zeilen', xs.length === 2 && ys.length === 3, { xs, ys });
    const overflow = await page.evaluate(() => { const el = document.getElementById('oura-daily-card'); return el.scrollWidth > el.clientWidth || document.documentElement.scrollWidth > 360; });
    check('kein horizontaler Überlauf bei 360 px', !overflow);
    await page.$eval('#oura-daily-card', el => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => document.querySelectorAll('.toast,#toast').forEach(t => t.remove()));
    await page.screenshot({ path: '/tmp/run-032-oura-karte.png' });

    // Unit-Checks calcOuraTempTrend mit festen Zahlen (direkt auf window.ouraDaily)
    const u = await page.evaluate((T) => {
      const mk = (recent, base, nBase, nRecent = 3) => {
        const o = {};
        const [y, m, d] = T.split('-').map(Number);
        for (let i = 0; i < 3 + nBase; i++) {
          const key = new Date(y, m - 1, d - i).toLocaleDateString('sv-SE');
          if (i < 3 && i >= nRecent) continue;
          o[key] = { sleepScore: 80, readinessScore: 78, tempDeviation: i < 3 ? recent[i] : base };
        }
        return o;
      };
      // ouraDaily ist modul-lokal; window.ouraDaily ist dasselbe Objekt -> in place ersetzen
      const od = window.ouraDaily;
      const saved = { ...od };
      const setAll = o => { for (const k of Object.keys(od)) delete od[k]; Object.assign(od, o); };
      const res = {};
      const run = (name, o) => { setAll(o); res[name] = window.calcOuraTempTrend(T); };
      run('down', mk([-0.2, -0.3, -0.1], 0.05, 28));        // Ø -0,2 - 0,05 = -0,25
      run('flat', mk([0.1, 0.1, 0.1], 0.02, 28));          // 0,08 -> →
      run('base14', mk([0.4, 0.4, 0.4], 0, 14));           // genau 14 -> ok
      run('base13', mk([0.4, 0.4, 0.4], 0, 13));           // 13 -> null
      run('recent2', mk([0.4, 0.2, 0], 0, 28, 2));         // 2 von 3 -> ok, Ø 0,3
      run('recent1', mk([0.4, 0, 0], 0, 28, 1));           // 1 von 3 -> null
      setAll(saved);
      return res;
    }, TODAY);
    const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;
    check('Unit down: Δ -0,25, dir down', near(u.down.delta, -0.25) && u.down.dir === 'down', u.down);
    check('Unit flat: Δ 0,08, dir flat', near(u.flat.delta, 0.08) && u.flat.dir === 'flat', u.flat);
    check('Unit 14 Basisnächte reichen', near(u.base14.delta, 0.4) && u.base14.baseCount === 14, u.base14);
    check('Unit 13 Basisnächte -> null', u.base13.delta === null && u.base13.baseCount === 13, u.base13);
    check('Unit 2 von 3 reichen (Ø 0,3)', near(u.recent2.delta, 0.3) && u.recent2.recentCount === 2, u.recent2);
    check('Unit 1 von 3 -> null', u.recent1.delta === null, u.recent1);
    check('keine unbekannten Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors);
    const w = await page.evaluate(() => (window.__TEST_WRITES__ || []).filter(x => /oura/.test(x.path)));
    check('keine Oura-Schreibzugriffe', w.length === 0, w);
    await page.close();
  }

  // 2) Zu wenige Basisnaechte (10) -> "–"; Effizienz fehlt -> "–"
  {
    const { page } = await start(browser, store(oura({ recentTemp: 0.3, baseTemp: 0, baseNights: 10 })));
    const c = await cells(page);
    check('zu wenige Nächte: 6 Kacheln', c.length === 6);
    check('zu wenige Nächte: Temp-Trend "–"', c[5].value === '–', c[5].value);
    check('fehlende Effizienz: "–"', c[4].value === '–', c[4].value);
    await page.close();
  }

  // 3) Kleine Abweichung -> →
  {
    const { page } = await start(browser, store(oura({ recentTemp: 0.04, baseTemp: 0, baseNights: 28, effToday: 80 })));
    const c = await cells(page);
    check('|Δ| < 0,1: → ±0,0 °C', c[5].value === '→ ±0,0 °C', c[5].value);
    await page.close();
  }

  await browser.close();
  console.log(ok ? 'ALLE OK' : 'FEHLER');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

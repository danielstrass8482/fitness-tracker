#!/usr/bin/env node
// 038 - Zaehl-Labor (labor/zaehlen.html): Seite laedt, Modell kommt von gleicher Herkunft, Replay der synthetischen
// Keypoint-Aufnahmen zaehlt korrekt (alle 4 Uebungen + 2 Liegestuetz-Varianten), keine Fremd-Requests, keine
// CSP-Verletzung. Optional (--fps): Live-Schleife mit Chromium-Fake-Kamera, misst fps (keine Person im Bild).
// Kein Firestore, keine Auth - die Seite hat beides nicht. Statischer Server auf 127.0.0.1, 360 px.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WITH_FPS = process.argv.includes('--fps');
const DELEGATE = (process.argv.find(a => a.startsWith('--delegate=')) || '').split('=')[1] || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.png': 'image/png' };
let ok = true;
function check(n, c, d) { console.log(`${c ? 'OK  ' : 'FAIL'} ${n}` + (d !== undefined ? ` (${JSON.stringify(d)})` : '')); if (!c) ok = false; }

function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
  const srv = await serve();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const requests = [], errors = [], csp = [];
  page.on('request', r => requests.push(r.url()));
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 160)); if (m.type() === 'error' && !/^INFO: Created TensorFlow Lite XNNPACK delegate/.test(t)) errors.push(t.slice(0, 160)); });

  await page.goto(`${origin}/labor/zaehlen.html` + (DELEGATE ? `?delegate=${DELEGATE}` : ''));
  await page.waitForFunction(() => !!window.ZaehlLabor, null, { timeout: 10000 });
  check('Seite geladen, Hinweis gesetzt', (await page.textContent('#hint')).length > 20);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check('kein horizontales Scrollen bei 360 px', sw <= 360, sw);

  const m = await page.evaluate(() => window.ZaehlLabor.loadModel());
  const modelReq = requests.filter(u => /pose_landmarker_lite\.task|vision_wasm_internal\.(js|wasm)/.test(u));
  check('Modell + WASM geladen, gleiche Herkunft', modelReq.length >= 3 && modelReq.every(u => u.startsWith(origin)), { ...m, n: modelReq.length });

  const cases = await page.evaluate(() => window.ZaehlLabor.REPLAYS.map(r => r[1]));
  for (const url of cases) {
    const r = await page.evaluate(u => window.ZaehlLabor.replayUrl(u).then(x => ({ count: x.count, expected: x.expected, source: x.source })), url);
    const shown = await page.textContent('#count');
    check(`Replay ${path.basename(url)}: ${r.count}/${r.expected} (${r.source})`, r.count === r.expected && shown === String(r.expected), { shown });
  }

  if (WITH_FPS) {
    await page.click('#btn-start');
    await page.waitForFunction(() => window.ZaehlLabor.stats.running, null, { timeout: 15000 });
    await page.waitForTimeout(8000);
    const st = await page.evaluate(() => window.ZaehlLabor.stats);
    await page.click('#btn-stop');
    console.log(`INFO fps headless (Fake-Kamera, keine Person): ${st.fps.toFixed(1)} fps, Inferenz ${st.inferMs.toFixed(1)} ms, Delegate ${st.delegate}, Frames ${st.frames}`);
    check('Live-Schleife lief (Frames > 0), gestoppt', st.frames > 0 && !(await page.evaluate(() => window.ZaehlLabor.stats.running)));
  }

  const foreign = requests.filter(u => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
  check('keine Fremd-Requests', foreign.length === 0, { total: requests.length, foreign: foreign.slice(0, 5) });
  check('keine CSP-Verletzungen', csp.length === 0, csp.slice(0, 3));
  check('keine Seitenfehler', errors.length === 0, errors.slice(0, 3));

  await browser.close(); srv.close();
  console.log(ok ? 'ALLE OK' : 'FEHLER');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

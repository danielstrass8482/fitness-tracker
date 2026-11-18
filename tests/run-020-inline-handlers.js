#!/usr/bin/env node
// 020 Teil 3 - Inline-Handler-Pruefung. Extrahiert ALLE Funktionsnamen, die aus einem
// on<event>="..."-Attribut in index.html aufgerufen werden (statisch UND aus Template-Strings, da
// reiner Textscan der Quelldatei - ein Playwright-DOM-Scan saehe nur die zur Laufzeit tatsaechlich
// gerenderten Attribute, nicht die in Template-Strings erst noch zu bauenden), und prueft nach dem
// echten App-Start per `typeof window[NAME] === 'function'`, ob jeder davon aufrufbar ist. Bewusst
// gegen die LIVE index.html gerechnet (kein eingefrorener Namen-Snapshot) - bleibt so auch nach
// kuenftigen Aenderungen aussagekraeftig. JS-Builtins (Date, setTimeout, ...) sind global auf window
// vorhanden, auch ohne eigenes window.NAME= - siehe JS_BUILTINS.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { installHarness } = require('./stubs/harness.js');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z';

const JS_BUILTINS = new Set(['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'isNaN', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'alert', 'confirm', 'prompt', 'console']);

// Gleiche Extraktion wie im Bericht 020 (Teil 3, Punkt 8): alle on<event>="..."-Attribute, je
// Attributinhalt jeder direkt aufgerufene Identifier (kein .method(), kein Keyword), ${...}
// -Interpolationen (Quellcode-Ebene, schon vor dem Setzen des Attributs ausgewertet) werden
// vorher entfernt - sonst wuerden z.B. planEsc()-Aufrufe faelschlich als Inline-Handler gezaehlt.
function extractInlineHandlerNames(src) {
  const attrRe = /\bon[a-z]+\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  const callRe = /(?<![.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  const names = new Set();
  let m;
  while ((m = attrRe.exec(src))) {
    const body = m[1].replace(/\$\{[^}]*\}/g, '');
    let cm;
    while ((cm = callRe.exec(body))) {
      const name = cm[1];
      if (['if', 'for', 'while', 'return', 'typeof', 'new', 'function', 'event'].includes(name)) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

async function main() {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const names = extractInlineHandlerNames(src);
  console.log(`\n=== 020 Teil 3: Inline-Handler zur Laufzeit (typeof window[NAME] === 'function') ===`);
  console.log(`${names.length} verschiedene Funktionsnamen aus on<event>="..."-Attributen extrahiert.`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: {} });

  // confirmDialogResolve ist bewusst erst WAEHREND ein Dialog offen ist eine Funktion (showConfirm()
  // weist sie je Aufruf frisch zu, siehe index.html ~6362); ohne offenen Dialog ist sie null/Platzhalter
  // - die zugehoerigen onclick="confirmDialogResolve(...)"-Buttons sind dann nicht erreichbar (Dialog
  // verborgen). Eigene Pruefung MIT offenem Dialog statt der pauschalen "nach App-Start"-Pruefung.
  const confirmDialogResolveType = await page.evaluate(() => {
    // showConfirm() selbst ist nicht auf window (kein onclick-Ziel) - ueber eine window-Funktion
    // ausgeloest, die als Erstes showConfirm() aufruft (window.deleteTraining, harmlose Nicht-ID).
    window.deleteTraining('__test_nicht_vorhanden__');
    return typeof window.confirmDialogResolve;
  });
  check('window.confirmDialogResolve ist waehrend eines offenen Dialogs eine Funktion', confirmDialogResolveType === 'function', confirmDialogResolveType);
  await page.evaluate(() => window.confirmDialogResolve && window.confirmDialogResolve(false));

  const results = await page.evaluate((names) => names.map(n => ({ name: n, type: typeof window[n] })), names.filter(n => n !== 'confirmDialogResolve'));
  await page.close();
  await browser.close();

  const missing = results.filter(r => r.type !== 'function' && !JS_BUILTINS.has(r.name));
  for (const r of missing) check(`window.${r.name} ist eine Funktion (ist: ${r.type})`, false);
  check(`alle ${names.length - 1} übrigen Inline-Handler-Funktionen sind nach App-Start auf window aufrufbar`, missing.length === 0, missing.map(r => r.name));
  check('keine Konsolenfehler beim App-Start', consoleErrors.length === 0, consoleErrors);

  if (!ok) { console.error('\nFEHLER: mindestens ein Inline-Handler ist zur Laufzeit nicht aufrufbar.'); process.exit(1); }
  console.log('\nOK: alle Inline-Handler sind zur Laufzeit auf window aufrufbar.');
}

main().catch(e => { console.error(e); process.exit(1); });

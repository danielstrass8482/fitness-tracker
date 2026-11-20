#!/usr/bin/env node
// 017 - Testsammlung: fuehrt alle Tests nacheinander aus (ein Chromium-Prozess pro Datei, wie
// bisher), sammelt Exit-Codes, druckt am Ende eine Zusammenfassung (gruen/rot). `npm test` ruft
// genau dieses Skript auf. Reihenfolge: aeltere Einzeltests (Zusatz 17.11.) zuerst, dann die neuen
// 017-Tests (Formeln, Alkoholregel, Smoke, saveSettings).
const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  { file: 'run-012d.js', args: ['--after'] },
  { file: 'run-015-datum-zeitzone.js', args: ['--after'] },
  { file: 'run-016-start-parallel.js', args: [] },
  { file: 'run-016f-analyse-entfernen.js', args: [] },
  { file: 'run-016e-training-plan-first.js', args: [] },
  { file: 'run-017-formeln.js', args: [] },
  { file: 'run-017-alkohol.js', args: [] },
  { file: 'run-017-smoke.js', args: [] },
  { file: 'run-017-savesettings.js', args: [] },
  { file: 'run-018-xss.js', args: [] },
  { file: 'run-020-xss-training.js', args: [] },
  { file: 'run-020-inline-handlers.js', args: [] },
  { file: 'run-023a-workout-builder-max-tokens.js', args: [] },
  { file: 'run-023a2-plan-aenderung-gezielt.js', args: [] },
];

function statusFor(code) {
  if (code === 0) return 'PASS';
  if (code === 2) return 'STOPP'; // run-016-start-parallel.js: kein Beleg fuer vorher/nachher-Unterschied
  if (code === 3) return 'ABWEICHUNG'; // run-016-start-parallel.js: Endzustand vorher!=nachher, wartet auf Entscheidung
  return 'FAIL';
}

function main() {
  const start = Date.now();
  const results = [];
  for (const t of TESTS) {
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`>>> ${t.file} ${t.args.join(' ')}`);
    console.log(`--------------------------------------------------------------------------------`);
    const tStart = Date.now();
    const r = spawnSync('node', [path.join(__dirname, t.file), ...t.args], { stdio: 'inherit' });
    const elapsedMs = Date.now() - tStart;
    const status = statusFor(r.status);
    results.push({ file: t.file, status, code: r.status, elapsedMs });
  }
  const totalMs = Date.now() - start;

  console.log(`\n================================================================================`);
  console.log('ZUSAMMENFASSUNG');
  console.log('================================================================================');
  for (const r of results) {
    console.log(`${r.status.padEnd(10)} ${r.file.padEnd(36)} ${(r.elapsedMs / 1000).toFixed(1)}s (exit ${r.code})`);
  }
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const other = results.length - pass - fail;
  console.log(`\n${pass} gruen, ${fail} rot${other ? `, ${other} mit Sonderstatus (STOPP/ABWEICHUNG, siehe oben)` : ''} von ${results.length} Tests. Gesamtlaufzeit: ${(totalMs / 1000).toFixed(1)}s.`);

  if (fail > 0) process.exit(1);
}

main();

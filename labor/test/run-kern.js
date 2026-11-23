#!/usr/bin/env node
// 038 – Offline-Test des Zählkerns: zählt alle Aufnahmen in labor/test/data/*.json und vergleicht mit "expected".
// Aufruf: node labor/test/run-kern.js [datei.json ...]   (ohne Argumente: alle Dateien in data/)
const fs = require('fs');
const path = require('path');
const K = require('../zaehl-kern.js');
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(path.join(__dirname, 'data')).filter(f => f.endsWith('.json')).sort().map(f => path.join(__dirname, 'data', f));
let ok = true;
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = K.replay(rec);
  const pass = rec.expected === undefined || r.count === rec.expected;
  if (!pass) ok = false;
  const d = r.detail;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${path.basename(f)}: gezaehlt ${r.count}, erwartet ${rec.expected} (Quelle ${r.source}; Pose ${d.pose.count}/abgelehnt ${d.pose.rejected.length}, Abdeckung ${d.pose.coverage}` +
    (d.motion ? `; Bewegung ${d.motion.count}/abgelehnt ${d.motion.rejected.length}` : '') + ')');
  if (!pass || process.env.VERBOSE) console.log('     ', JSON.stringify(d));
}
console.log(ok ? 'ALLE OK' : 'FEHLER');
process.exit(ok ? 0 : 1);

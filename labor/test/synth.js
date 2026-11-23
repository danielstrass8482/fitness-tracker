#!/usr/bin/env node
// 038 – erzeugt synthetische Keypoint-Aufnahmen (Format: labor/README.md) nach labor/test/data/*.json.
// Deterministisch (fester Seed). Pro Übung: sinusartige Wiederholungen + Rauschen + ein Umgreif-Ausreißer
// + eine kurze Lücke (Pose verloren). Zusätzlich Negativfälle (nur Rauschen/Ausreißer → 0).
const fs = require('fs');
const path = require('path');

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const FPS = 30, ARMED_FROM = 5;

// Zeitplan: Ruhe bis ARMED_FROM+1, dann n Wiederholungen mit Pausen. Liefert phase(t) ∈ [0,1].
function schedule(r, n, repDur, pause) {
  const reps = []; let t = ARMED_FROM + 1;
  for (let i = 0; i < n; i++) {
    const d = repDur[0] + r() * (repDur[1] - repDur[0]);
    reps.push([t, t + d]); t += d + pause[0] + r() * (pause[1] - pause[0]);
  }
  return { reps, end: t + 1.5, phase(tt) { for (const [a, b] of reps) if (tt >= a && tt <= b) return (1 - Math.cos(2 * Math.PI * (tt - a) / (b - a))) / 2; return 0; } };
}
// Ausreißer-Zeitpunkt mitten in eine Pause legen
function pauseMid(s, i) { const a = s.reps[i][1], b = s.reps[i + 1][0]; return (a + b) / 2; }

function baseStanding() {
  const kp = Array.from({ length: 33 }, () => [0.5, 0.5, 0.9]);
  const set = (i, x, y) => { kp[i] = [x, y, 0.9]; };
  set(0, 0.5, 0.18); set(2, 0.49, 0.17); set(5, 0.51, 0.17); set(7, 0.47, 0.18); set(8, 0.53, 0.18);
  set(11, 0.43, 0.28); set(12, 0.57, 0.28); set(13, 0.41, 0.38); set(14, 0.59, 0.38); set(15, 0.41, 0.47); set(16, 0.59, 0.47);
  set(23, 0.46, 0.5); set(24, 0.54, 0.5); set(25, 0.46, 0.68); set(26, 0.54, 0.68); set(27, 0.46, 0.86); set(28, 0.54, 0.86);
  return kp;
}
function shiftAll(kp, ids, dy) { for (const i of ids) kp[i] = [kp[i][0], kp[i][1] + dy, kp[i][2]]; }
function noisy(kp, r, sd) { return kp.map(p => [+(p[0] + gauss(r) * sd).toFixed(4), +(p[1] + gauss(r) * sd).toFixed(4), +Math.min(1, Math.max(0, p[2] + gauss(r) * 0.03)).toFixed(3)]); }

const UPPER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

const MODELS = {
  // Hüfte und Oberkörper sinken um 0,12 (Rumpflänge 0,22 → ~0,55 Rumpf)
  splitsquats: { n: 8, repDur: [1.6, 2.2], pause: [0.5, 1.0], pose(ph, spike) { const kp = baseStanding(); shiftAll(kp, [...UPPER, 23, 24], 0.12 * ph + spike * 0.15); kp[25][1] += 0.06 * ph; kp[26][1] += 0.06 * ph; return kp; } },
  // frontal, Kopf/Schultern wandern um 0,14 nach unten (Schulterbreite 0,14 → 1,0)
  liegestuetze: { n: 6, repDur: [1.4, 2.0], pause: [0.4, 0.9], pose(ph, spike) { const kp = baseStanding(); shiftAll(kp, UPPER, 0.2 + 0.14 * ph + spike * 0.2); return kp; } },
  // Winkel 165° → 40°
  curls: { n: 10, repDur: [1.4, 2.0], pause: [0.3, 0.8], pose(ph, spike) {
    const kp = baseStanding(); const ang = (165 - 125 * ph - spike * 140) * Math.PI / 180; const L = 0.1;
    for (const [s, e, w, sg] of [[11, 13, 15, -1], [12, 14, 16, 1]]) {
      // Oberarm senkrecht nach unten; Unterarm im Winkel ang zum Oberarm
      kp[e] = [kp[s][0], kp[s][1] + L, 0.9];
      kp[w] = [kp[e][0] + sg * Math.sin(ang) * L, kp[e][1] - Math.cos(ang) * L, 0.9];
    }
    return kp; } },
  // sitzend, seitlich: Knie 90° → gestreckt
  band_gerade: { n: 8, repDur: [1.6, 2.4], pause: [0.6, 1.2], pose(ph, spike) {
    const kp = baseStanding(); const T = 0.2;
    for (const [h, k, a] of [[23, 25, 27], [24, 26, 28]]) {
      kp[h] = [0.45, 0.6, 0.9]; kp[k] = [0.45 + T, 0.6, 0.9];
      const ang = (Math.PI / 2) * (1 - Math.min(1, ph + spike * 0.9)); // 90° gebeugt → 0° gestreckt
      kp[a] = [kp[k][0] + Math.sin(Math.PI / 2 - ang) * T, kp[k][1] + Math.sin(ang) * T, 0.9];
    }
    return kp; } },
};

function make(ex, seed, variant) {
  const r = rng(seed), m = MODELS[ex];
  const s = schedule(r, m.n, m.repDur, m.pause);
  const spikeAt = pauseMid(s, 2), gapAt = pauseMid(s, 4);
  const frames = [];
  const negative = variant === 'negativ';
  let drift = 0;
  for (let i = 0; i * (1 / FPS) <= s.end; i++) {
    const t = +(i / FPS).toFixed(4);
    const ph = negative ? 0.04 * Math.sin(t * 2) : s.phase(t); // Negativfall: nur kleines Wackeln
    const spike = Math.abs(t - spikeAt) < 0.125 ? 1 : 0;       // 0,25 s Umgreif-Ausreißer
    let kp = noisy(m.pose(ph, spike), r, 0.004);
    if (Math.abs(t - gapAt) < 0.15) kp = null;                // 0,3 s Pose verloren
    if (kp && variant === 'luecken') {                          // ~50 % der Frames: Teile der Oberkörperpunkte unsichtbar
      if (r() < 0.5) for (const j of [0, 2, 5, 7, 8, 11, 12]) if (r() < 0.6) kp[j][2] = 0.1;
      if (r() < 0.15) kp = null;
    }
    const f = { t, kp };
    if (variant === 'bewegung') {                               // nur Bildbewegung, keine Pose
      drift += 0.0004;
      f.kp = null;
      f.my = +(0.08 * ph + spike * 0.1 + drift + gauss(r) * 0.002).toFixed(5);
    }
    frames.push(f);
  }
  return {
    format: 'zaehl-labor-keypoints/1', exercise: ex, variant: variant || 'standard', fps: FPS, armedFrom: ARMED_FROM,
    expected: negative ? 0 : m.n, source: 'synthetisch (labor/test/synth.js)', frames,
  };
}

const CASES = [
  ['splitsquats', 11], ['liegestuetze', 12], ['curls', 13], ['band_gerade', 14],
  ['liegestuetze', 15, 'luecken'], ['liegestuetze', 16, 'bewegung'],
  ['splitsquats', 21, 'negativ'], ['band_gerade', 24, 'negativ'],
];

if (require.main === module) {
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  for (const [ex, seed, v] of CASES) {
    const rec = make(ex, seed, v);
    const name = `synth-${ex}${v ? '-' + v : ''}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(rec));
    console.log(`${name}: ${rec.frames.length} Frames, erwartet ${rec.expected}`);
  }
}
module.exports = { make, CASES };

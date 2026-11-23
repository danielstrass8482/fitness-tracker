// Zähl-Labor (Aufgabe 038) – Kamera → MediaPipe Pose (lite, lokal) → ZaehlKern → Live-Zahl.
// Alles bleibt im Browser: kein Upload, keine Speicherung, keine Fremd-Requests (CSP in zaehlen.html).
import { FilesetResolver, PoseLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

const K = window.ZaehlKern;
const $ = id => document.getElementById(id);
const BASE = new URL('.', import.meta.url);
const WASM_DIR = new URL('vendor/mediapipe/wasm', BASE).href;
const MODEL_URL = new URL('vendor/models/pose_landmarker_lite.task', BASE).href;
const REPLAYS = [
  ['Split Squats', 'test/data/synth-splitsquats.json'],
  ['Liegestütze', 'test/data/synth-liegestuetze.json'],
  ['Bizeps-Curls', 'test/data/synth-curls.json'],
  ['Terraband gerade', 'test/data/synth-band_gerade.json'],
  ['Liegestütze (Lücken)', 'test/data/synth-liegestuetze-luecken.json'],
  ['Liegestütze (nur Bewegung)', 'test/data/synth-liegestuetze-bewegung.json'],
];
const COUNTDOWN_S = 5;
const EDGES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];

const S = {
  landmarker: null, delegate: null, loading: null,
  stream: null, facing: 'user', running: false, armedAt: 0, t0: 0,
  counter: null, frames: 0, fpsT: 0, fpsN: 0, fps: 0, inferMs: 0,
  wakeLock: null, audio: null, curve: [], lastKp: null,
  motion: { canvas: null, ctx: null, prev: null, acc: 0 },
  replaying: false,
};

// ---------- UI ----------
function exKey() { return $('exercise').value; }
function updateHint() { $('hint').textContent = K.CONFIG.exercises[exKey()].hint; }
function setCount(n, pulse) {
  const el = $('count'); el.textContent = String(n);
  if (pulse) { el.classList.add('pulse'); setTimeout(() => el.classList.remove('pulse'), 250); }
}
function msg(t) { $('stage-msg').textContent = t; }
function status(lines) { $('status').textContent = lines.filter(Boolean).join('\n'); $('status').style.whiteSpace = 'pre-line'; }

function beep() {
  if (!$('opt-sound').checked || !S.audio) return;
  const a = S.audio, o = a.createOscillator(), g = a.createGain();
  o.frequency.value = 880; o.type = 'sine';
  g.gain.setValueAtTime(0.0001, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.4, a.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.12);
  o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.13);
}

async function wake(on) {
  try {
    if (on && 'wakeLock' in navigator && !S.wakeLock) S.wakeLock = await navigator.wakeLock.request('screen');
    if (!on && S.wakeLock) { await S.wakeLock.release(); S.wakeLock = null; }
  } catch (e) { S.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.running) { S.wakeLock = null; wake(true); } });

// ---------- Modell ----------
async function loadModel() {
  if (S.landmarker) return S.landmarker;
  if (S.loading) return S.loading;
  S.loading = (async () => {
    const t = performance.now();
    const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
    const forced = ($('opt-delegate').value || new URLSearchParams(location.search).get('delegate') || '').toUpperCase();
    for (const delegate of forced === 'CPU' || forced === 'GPU' ? [forced] : ['GPU', 'CPU']) {
      try {
        S.landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO', numPoses: 1,
          minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        S.delegate = delegate; break;
      } catch (e) { console.warn('Delegate ' + delegate + ' nicht verfügbar:', e && e.message); }
    }
    if (!S.landmarker) throw new Error('Modell konnte nicht geladen werden');
    S.modelLoadMs = Math.round(performance.now() - t);
    return S.landmarker;
  })();
  try { return await S.loading; } finally { S.loading = null; }
}

// ---------- Kamera ----------
async function startCamera() {
  stopCamera();
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: false, video: { facingMode: S.facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  });
  const v = $('video'); v.srcObject = S.stream; await v.play();
  $('stage').classList.toggle('mirror', S.facing === 'user');
}
function stopCamera() {
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  S.stream = null; $('video').srcObject = null;
}

// Vertikale Bildbewegung (Ersatzsignal): Zeilenprofil der verkleinerten Graustufen, Verschiebung per SAD-Suche.
function motionStep(video) {
  const m = S.motion, vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return undefined;
  const H = 64, W = Math.max(16, Math.round(H * vw / vh));
  if (!m.canvas) { m.canvas = document.createElement('canvas'); m.ctx = m.canvas.getContext('2d', { willReadFrequently: true }); }
  if (m.canvas.width !== W) { m.canvas.width = W; m.canvas.height = H; m.prev = null; }
  m.ctx.drawImage(video, 0, 0, W, H);
  const d = m.ctx.getImageData(0, 0, W, H).data, prof = new Float32Array(H);
  for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; } prof[y] = s / W; }
  if (m.prev) {
    const R = 6, cost = [];
    for (let s = -R; s <= R; s++) { let c = 0, n = 0; for (let y = R; y < H - R; y++) { c += Math.abs(prof[y] - m.prev[y - s]); n++; } cost.push(c / n); }
    let bi = 0; for (let i = 1; i < cost.length; i++) if (cost[i] < cost[bi]) bi = i;
    let shift = bi - R;
    if (bi > 0 && bi < cost.length - 1) { const a = cost[bi - 1], b = cost[bi], c = cost[bi + 1], den = a - 2 * b + c; if (den > 0) shift += 0.5 * (a - c) / den; }
    m.acc += shift / H;
  }
  m.prev = prof;
  return m.acc;
}

// ---------- Zeichnen ----------
function drawSkeleton(kp) {
  const c = $('overlay'), st = $('stage');
  const w = st.clientWidth, h = st.clientHeight, dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  if (!kp || !$('opt-skeleton').checked) return;
  // object-fit: cover nachbilden
  const v = $('video'); const vw = v.videoWidth || 3, vh = v.videoHeight || 4;
  const sc = Math.max(w / vw, h / vh), ox = (w - vw * sc) / 2, oy = (h - vh * sc) / 2;
  const P = p => [ox + p[0] * vw * sc, oy + p[1] * vh * sc];
  g.lineWidth = 3; g.strokeStyle = 'rgba(91,141,239,.9)'; g.fillStyle = '#FF7A3D';
  for (const [a, b] of EDGES) { const pa = kp[a], pb = kp[b]; if (pa && pb && pa[2] > 0.5 && pb[2] > 0.5) { const A = P(pa), B = P(pb); g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke(); } }
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { const p = kp[i]; if (p && p[2] > 0.5) { const q = P(p); g.beginPath(); g.arc(q[0], q[1], 4, 0, 7); g.fill(); } }
}
function drawCurve(t) {
  if (!$('opt-curve').checked) return;
  const st = S.counter && S.counter.state; if (st) S.curve.push({ t, v: st.v, en: st.enter, ex: st.exit });
  while (S.curve.length && S.curve[0].t < t - 10) S.curve.shift();
  const c = $('curve'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (S.curve.length < 2) return;
  let lo = Infinity, hi = -Infinity; for (const p of S.curve) { lo = Math.min(lo, p.v, p.ex); hi = Math.max(hi, p.v, p.en); }
  if (hi - lo < 1e-6) hi = lo + 1e-6;
  const X = tt => (tt - (t - 10)) / 10 * W, Y = v => H - 10 - (v - lo) / (hi - lo) * (H - 20);
  for (const [key, col, lw] of [['en', '#F25F1C', 2], ['ex', '#0F7A4B', 2], ['v', '#1E5BD8', 4]]) {
    g.strokeStyle = col; g.lineWidth = lw; g.beginPath();
    S.curve.forEach((p, i) => { const x = X(p.t), y = Y(p[key]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
  }
}

// ---------- Ein Frame durch den Zähler ----------
function feed(frame, armed) {
  const r = S.counter.push(frame, armed);
  if (r.newRep) { setCount(S.counter.count, true); beep(); }
  else if (r.switched) setCount(S.counter.count);
  return r;
}
function detailText() {
  const d = S.counter.detail, ex = K.CONFIG.exercises[S.counter.key];
  return `Gezählt: ${S.counter.count} (Quelle: ${S.counter.source === 'pose' ? 'Pose' : 'Bildbewegung'})` +
    (d.motion ? ` · Pose ${d.pose.count} / Bewegung ${d.motion.count} · Pose-Abdeckung ${Math.round(d.pose.coverage * 100)} %` : ` · Pose-Abdeckung ${Math.round(d.pose.coverage * 100)} %`) +
    ` · verworfen: ${(S.counter.source === 'pose' ? d.pose : d.motion).rejected.length} · ${ex.label}`;
}

// ---------- Live-Schleife ----------
function loop() {
  if (!S.running) return;
  const v = $('video');
  const next = () => { if (!S.running) return; if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); else requestAnimationFrame(loop); };
  if (v.readyState < 2) return next();
  const now = performance.now(), t = (now - S.t0) / 1000;
  const a = performance.now();
  let kp = null;
  try {
    const res = S.landmarker.detectForVideo(v, now);
    const lm = res && res.landmarks && res.landmarks[0];
    if (lm) kp = lm.map(p => [p.x, p.y, p.visibility === undefined ? 1 : p.visibility]);
  } catch (e) { console.warn(e); }
  S.inferMs = S.inferMs * 0.9 + (performance.now() - a) * 0.1;
  const my = S.counter.config.motion ? motionStep(v) : undefined;
  const armed = now >= S.armedAt;
  feed({ t, kp, my }, armed);
  drawSkeleton(kp); drawCurve(t);
  // Countdown / fps
  if (!armed) $('countdown').textContent = 'Start in ' + Math.ceil((S.armedAt - now) / 1000) + ' s';
  else if ($('countdown').textContent) { $('countdown').textContent = ''; msg('Zählt …'); }
  S.fpsN++; if (now - S.fpsT >= 1000) { S.fps = S.fpsN * 1000 / (now - S.fpsT); S.fpsN = 0; S.fpsT = now; }
  S.frames++;
  if (S.frames % 10 === 0) status([detailText(), `${S.fps.toFixed(1)} fps · Inferenz ${S.inferMs.toFixed(0)} ms · ${S.delegate} · ${v.videoWidth}×${v.videoHeight}`, kp ? 'Person erkannt' : 'Keine Person erkannt']);
  next();
}

async function start() {
  if (S.running || S.replaying) return;
  $('btn-start').disabled = true;
  try {
    if (!S.audio) { try { S.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (S.audio && S.audio.state === 'suspended') S.audio.resume();
    msg('Modell wird geladen …'); await loadModel();
    msg('Kamera wird gestartet …'); await startCamera();
  } catch (e) {
    msg('Fehler: ' + (e && e.message || e)); $('btn-start').disabled = false; stopCamera(); return;
  }
  S.counter = K.createCounter(exKey()); S.curve = []; S.motion.prev = null; S.motion.acc = 0;
  setCount(0); S.t0 = performance.now(); S.armedAt = S.t0 + COUNTDOWN_S * 1000; S.fpsT = S.t0; S.fpsN = 0; S.frames = 0;
  S.running = true; $('btn-stop').disabled = false; $('exercise').disabled = true;
  msg('In Position gehen …'); wake(true); loop();
}
function stop() {
  if (!S.running) return;
  S.running = false; stopCamera(); wake(false);
  $('countdown').textContent = ''; drawSkeleton(null);
  $('btn-start').disabled = false; $('btn-stop').disabled = true; $('exercise').disabled = false;
  msg('Gestoppt'); if (S.counter) status([detailText(), `${S.fps.toFixed(1)} fps zuletzt · ${S.delegate}`]);
}
async function flip() {
  S.facing = S.facing === 'user' ? 'environment' : 'user';
  $('btn-flip').textContent = 'Kamera: ' + (S.facing === 'user' ? 'vorne' : 'hinten');
  if (S.running) { try { await startCamera(); S.motion.prev = null; } catch (e) { msg('Kamerawechsel fehlgeschlagen: ' + e.message); } }
}

// ---------- Replay (ohne Kamera, derselbe Zählcode) ----------
async function replay(rec, { realtime = false } = {}) {
  if (S.running) stop();
  S.replaying = true;
  const ex = rec.exercise && K.CONFIG.exercises[rec.exercise] ? rec.exercise : exKey();
  $('exercise').value = ex; updateHint();
  S.counter = K.createCounter(ex); S.curve = []; setCount(0);
  const armedFrom = rec.armedFrom || 0, frames = rec.frames || [];
  try {
    if (realtime) {
      const t0 = performance.now(), f0 = frames.length ? frames[0].t : 0;
      let i = 0;
      await new Promise(res => {
        const step = () => {
          const tt = (performance.now() - t0) / 1000 + f0;
          while (i < frames.length && frames[i].t <= tt) { feed(frames[i], frames[i].t >= armedFrom); S.lastKp = frames[i].kp; i++; }
          drawSkeleton(S.lastKp); drawCurve(tt);
          $('countdown').textContent = tt < armedFrom ? 'Start in ' + Math.ceil(armedFrom - tt) + ' s' : '';
          if (i < frames.length) requestAnimationFrame(step); else res();
        };
        step();
      });
    } else {
      for (const f of frames) feed(f, f.t >= armedFrom);
    }
  } finally { S.replaying = false; $('countdown').textContent = ''; }
  const out = { count: S.counter.count, source: S.counter.source, expected: rec.expected, detail: S.counter.detail };
  $('replay-result').textContent = `Ergebnis: ${out.count}` + (rec.expected !== undefined ? ` (erwartet ${rec.expected})` : '') + ` · Quelle ${out.source === 'pose' ? 'Pose' : 'Bildbewegung'} · ${frames.length} Frames`;
  status([detailText()]); msg('Replay fertig');
  return out;
}
async function replayUrl(url, opts) {
  const r = await fetch(new URL(url, BASE)); if (!r.ok) throw new Error('HTTP ' + r.status);
  return replay(await r.json(), opts);
}

// ---------- Init ----------
$('exercise').addEventListener('change', updateHint);
$('opt-delegate').addEventListener('change', () => {
  if (S.running) stop();
  if (S.landmarker) { try { S.landmarker.close(); } catch (e) {} S.landmarker = null; S.delegate = null; }
  status(['Rechenweg: ' + ($('opt-delegate').value || 'Auto') + ' – wird beim nächsten Start geladen.']);
});
{ const q = (new URLSearchParams(location.search).get('delegate') || '').toUpperCase(); if (q === 'CPU' || q === 'GPU') $('opt-delegate').value = q; }
$('btn-start').addEventListener('click', start);
$('btn-stop').addEventListener('click', stop);
$('btn-flip').addEventListener('click', flip);
$('opt-curve').addEventListener('change', e => { $('curve-card').style.display = e.target.checked ? 'block' : 'none'; S.curve = []; });
$('replay-file').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try { await replay(JSON.parse(await f.text()), { realtime: true }); } catch (err) { $('replay-result').textContent = 'Fehler: ' + err.message; }
});
for (const [label, url] of REPLAYS) {
  const b = document.createElement('button'); b.className = 'btn'; b.textContent = label;
  b.addEventListener('click', () => replayUrl(url, { realtime: true }).catch(err => { $('replay-result').textContent = 'Fehler: ' + err.message; }));
  $('replay-list').appendChild(b);
}
updateHint();

// Test-/Diagnose-Schnittstelle (Playwright)
window.ZaehlLabor = {
  loadModel: async () => { await loadModel(); return { delegate: S.delegate, loadMs: S.modelLoadMs }; },
  start, stop, replay, replayUrl, REPLAYS,
  get stats() { return { fps: S.fps, inferMs: S.inferMs, frames: S.frames, delegate: S.delegate, running: S.running, count: S.counter ? S.counter.count : 0 }; },
};
window.dispatchEvent(new Event('zaehllabor-ready'));

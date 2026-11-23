/* Zähl-Labor – Zählkern (Aufgabe 038).
 * Läuft identisch im Browser (window.ZaehlKern) und in Node (module.exports).
 * Keine Abhängigkeiten, kein DOM, kein Netzwerk.
 *
 * Eingabe pro Frame (siehe labor/README.md, "Keypoint-JSON"):
 *   { t: Sekunden, kp: [[x, y, sichtbarkeit], ... 33 Punkte] | null, my: Zahl | undefined }
 *   x/y normiert 0..1 (y nach unten), Indizes wie MediaPipe Pose (33 Landmarks).
 *   my = integrierte vertikale Bildverschiebung (Bruchteil der Bildhöhe), optional.
 */
(function (root) {
  'use strict';

  // MediaPipe-Pose-Indizes
  const P = {
    nose: 0, eyeL: 2, eyeR: 5, earL: 7, earR: 8,
    shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
    hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
  };

  // ---------- Alle Parameter an einer Stelle ----------
  const CONFIG = {
    common: {
      minVis: 0.5,          // Keypoint gilt ab dieser Sichtbarkeit
      maxGap: 0.5,          // s – kürzere Lücken werden linear überbrückt, längere trennen das Signal
      smoothTau: 0.08,      // s – EMA-Glättung des Signals
      rangeWindow: 10,      // s – Fenster für laufendes Min/Max (Perzentile)
      rangePctLo: 0.05,     // unteres Perzentil (robust gegen kurze Spitzen)
      rangePctHi: 0.95,     // oberes Perzentil
      enterFrac: 0.65,      // Anteil der Spanne: ab hier "in Bewegung" (weg von Ruhelage)
      exitFrac: 0.35,       // Anteil der Spanne: darunter "zurück in Ruhelage" → Wiederholung
      scaleTau: 2,          // s – Glättung der Körpermaßstabs-Größe
      maxRepDuration: 10,   // s – längere "Wiederholungen" werden verworfen
      offAlpha: 0.02,       // Lernrate der Punktversätze (upperBodyY)
    },
    exercises: {
      splitsquats: {
        label: 'Split Squats',
        signal: 'hipY',         // mittlere Hüfthöhe
        rest: 'low',            // stehend: Hüfte oben = kleines y
        minAmplitude: 0.25,     // × Rumpflänge (Schulter–Hüfte)
        minRepDuration: 0.6,
        hint: 'Handy seitlich oder schräg von vorn auf Hüfthöhe, ca. 2–3 m Abstand, ganzer Körper im Bild.',
      },
      liegestuetze: {
        label: 'Liegestütze',
        signal: 'upperBodyY',     // mittlere Höhe sichtbarer Oberkörperpunkte (Versatz je Punkt, lückenrobust)
        rest: 'low',               // oben: Kopf/Schultern höher im Bild = kleines y
        minAmplitude: 0.35,        // × Schulterbreite
        minRepDuration: 0.6,
        motion: {                  // Ersatzsignal: vertikale Bildbewegung (Frame-Differenz)
          signal: 'motionY', rest: 'low', minAmplitude: 0.03, minRepDuration: 0.6, maxRepDuration: 4, highpassTau: 2,
        },
        minPoseCoverage: 0.6,      // Anteil Frames mit Posensignal, sonst zählt das Bewegungssignal
        hint: 'Handy flach vor dir auf den Boden (ca. 1 m vor dem Kopf), Kamera schräg nach oben auf Kopf und Schultern.',
      },
      curls: {
        label: 'Bizeps-Curls',
        signal: 'elbowAngle',   // Winkel Schulter–Ellbogen–Handgelenk (Grad)
        rest: 'high',           // Arm gestreckt = großer Winkel
        minAmplitude: 45,       // Grad
        minRepDuration: 0.6,
        hint: 'Handy frontal oder leicht seitlich auf Brusthöhe, 1,5–2 m Abstand, Arme komplett im Bild.',
      },
      band_gerade: {
        label: 'Terraband gerade',
        signal: 'ankleHipRatio', // Abstand Knöchel–Hüfte / Oberschenkellänge (max. beider Seiten)
        rest: 'low',             // Knie gebeugt = kleiner Abstand
        minAmplitude: 0.2,       // Verhältnis-Einheiten
        minRepDuration: 0.8,     // Umgreifen ist kürzer
        hint: 'Handy seitlich auf Sitzhöhe, 1,5–2 m Abstand, Hüfte, Knie und Fuß im Bild.',
      },
    },
  };

  // ---------- Hilfsfunktionen ----------
  function vis(kp, i, minVis) { const p = kp && kp[i]; return p && (p[2] === undefined || p[2] >= minVis) ? p : null; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  function angle(a, b, c) {
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const n = Math.hypot(...v1) * Math.hypot(...v2);
    if (!n) return null;
    return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / n))) * 180 / Math.PI;
  }
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // ---------- Signale: (frame, ctx) → { v, scale } | null ----------
  // ctx ist ein Zustandsobjekt pro Signalquelle (für integrierende Signale).
  const SIGNALS = {
    hipY(f, c, mv) {
      const kp = f.kp, hl = vis(kp, P.hipL, mv), hr = vis(kp, P.hipR, mv);
      if (!hl || !hr) return null;
      const sl = vis(kp, P.shoulderL, mv), sr = vis(kp, P.shoulderR, mv);
      const h = mid(hl, hr);
      const scale = sl && sr ? dist(mid(sl, sr), h) : null;
      return { v: h[1], scale };
    },
    upperBodyY(f, c, mv) {
      // Mittlere Höhe der sichtbaren Oberkörperpunkte, lückenrobust: jeder Punkt hat einen gelernten Versatz
      // zum gemeinsamen Signal → Wechsel der sichtbaren Teilmenge erzeugt keinen Sprung, keine Integrationsdrift.
      const ids = [P.nose, P.eyeL, P.eyeR, P.earL, P.earR, P.shoulderL, P.shoulderR];
      const kp = f.kp, cur = [];
      for (const i of ids) { const p = vis(kp, i, mv); if (p) cur.push([i, p[1]]); }
      if (cur.length < 2) return null;
      if (!c.off || f.t - c.lastT > c.maxGap) { c.off = {}; }
      let s = 0, m = 0;
      for (const [i, y] of cur) if (c.off[i] !== undefined) { s += y - c.off[i]; m++; }
      if (m) s /= m;
      else if (c.lastS !== undefined && Object.keys(c.off).length) s = c.lastS;     // nur neue Punkte: an letzten Wert anschließen
      else { s = cur.reduce((a, [, y]) => a + y, 0) / cur.length; }
      for (const [i, y] of cur) {
        if (c.off[i] === undefined) c.off[i] = y - s;
        else c.off[i] += c.offAlpha * (y - s - c.off[i]);
      }
      c.lastS = s; c.lastT = f.t;
      const sl = vis(kp, P.shoulderL, mv), sr = vis(kp, P.shoulderR, mv);
      return { v: s, scale: sl && sr ? dist(sl, sr) : null };
    },
    elbowAngle(f, c, mv) {
      const kp = f.kp, res = [];
      for (const [s, e, w] of [[P.shoulderL, P.elbowL, P.wristL], [P.shoulderR, P.elbowR, P.wristR]]) {
        const a = vis(kp, s, mv), b = vis(kp, e, mv), d = vis(kp, w, mv);
        if (a && b && d) { const g = angle(a, b, d); if (g !== null) res.push(g); }
      }
      if (!res.length) return null;
      return { v: Math.min(...res), scale: null }; // kleinster Winkel = beugender Arm (einseitig oder beidseitig)
    },
    ankleHipRatio(f, c, mv) {
      const kp = f.kp, res = [];
      for (const [h, k, a] of [[P.hipL, P.kneeL, P.ankleL], [P.hipR, P.kneeR, P.ankleR]]) {
        const ph = vis(kp, h, mv), pk = vis(kp, k, mv), pa = vis(kp, a, mv);
        if (ph && pk && pa) { const th = dist(ph, pk); if (th > 0) res.push(dist(ph, pa) / th); }
      }
      if (!res.length) return null;
      return { v: Math.max(...res), scale: null }; // gestrecktes Bein zählt (einseitig oder abwechselnd)
    },
    motionY(f) {
      if (typeof f.my !== 'number' || !isFinite(f.my)) return null;
      return { v: f.my, scale: null };
    },
  };

  // ---------- Zähler für ein Signal ----------
  // opts: { signal, rest, minAmplitude, minRepDuration, highpassTau? } + common
  function createSignalCounter(opts) {
    const o = Object.assign({}, CONFIG.common, opts);
    const fn = SIGNALS[o.signal];
    if (!fn) throw new Error('Unbekanntes Signal: ' + o.signal);
    const dir = o.rest === 'high' ? -1 : 1; // Signal so drehen, dass "weg von Ruhelage" = größer
    let st;
    function reset() {
      st = {
        ctx: { maxGap: o.maxGap, offAlpha: o.offAlpha }, hist: [], last: null, ema: null, hp: null, scale: null,
        phase: 'rest', repStart: 0, restStartT: -Infinity, repPeak: -Infinity, restMin: Infinity,
        count: 0, reps: [], rejected: [], validFrames: 0, frames: 0, lastOut: null,
      };
    }
    reset();

    function process(t, raw, scale, armed) {
      // Glätten
      if (st.ema === null) st.ema = raw;
      else { const dt = Math.max(0, t - st.last.t); st.ema += (raw - st.ema) * (1 - Math.exp(-dt / o.smoothTau)); }
      let v = st.ema * dir;
      if (o.highpassTau) {
        // Trend entfernen (doppelte EMA: folgt linearer Drift ohne Restversatz, z. B. integrierte Bildbewegung)
        if (st.hp === null) st.hp = [v, v];
        else {
          const k = 1 - Math.exp(-Math.max(0, t - st.last.t) / o.highpassTau);
          st.hp[0] += (v - st.hp[0]) * k; st.hp[1] += (st.hp[0] - st.hp[1]) * k;
        }
        v = v - (2 * st.hp[0] - st.hp[1]);
      }
      if (scale) st.scale = st.scale === null ? scale : st.scale + (scale - st.scale) * (1 - Math.exp(-Math.max(0, t - (st.last ? st.last.t : t)) / o.scaleTau));
      st.last = { t, raw };

      // Laufende Spanne (Perzentile im Fenster)
      st.hist.push({ t, v });
      while (st.hist.length && st.hist[0].t < t - o.rangeWindow) st.hist.shift();
      const sorted = st.hist.map(h => h.v).sort((a, b) => a - b);
      const lo = quantile(sorted, o.rangePctLo), hi = quantile(sorted, o.rangePctHi);
      const range = hi - lo;
      const minAmp = o.minAmplitude * (opts.scaleRelative && st.scale ? st.scale : 1);
      const enter = lo + o.enterFrac * range, exit = lo + o.exitFrac * range;
      let newRep = false;

      if (st.phase === 'rest') {
        st.restMin = Math.min(st.restMin, v);
        if (range >= minAmp && v > enter) {
          // Wiederholungsdauer = Zeit oberhalb der Rückkehrschwelle: rückwärts bis zum letzten Wert unter "exit" suchen
          let k = st.hist.length - 1;
          while (k > 0 && st.hist[k - 1].v > exit && st.hist[k - 1].t >= st.restStartT) k--;
          st.phase = 'move'; st.repStart = st.hist[k].t; st.repPeak = v;
        }
      } else {
        st.repPeak = Math.max(st.repPeak, v);
        if (v < exit) {
          const dur = t - st.repStart, amp = st.repPeak - st.restMin;
          const rep = { start: +st.repStart.toFixed(3), end: +t.toFixed(3), dur: +dur.toFixed(3), amp: +amp.toFixed(4) };
          if (armed && dur >= o.minRepDuration && dur <= o.maxRepDuration && amp >= minAmp) {
            st.count++; newRep = true; st.reps.push(rep);
          } else if (armed) st.rejected.push(Object.assign(rep, { why: dur < o.minRepDuration ? 'kurz' : dur > o.maxRepDuration ? 'lang' : 'flach' }));
          st.phase = 'rest'; st.restMin = v; st.restStartT = t;
        }
      }
      st.lastOut = { t, v, lo, hi, enter, exit, range, minAmp, phase: st.phase, valid: true };
      return newRep;
    }

    return {
      opts: o,
      reset,
      get count() { return st.count; },
      get reps() { return st.reps.slice(); },
      get rejected() { return st.rejected.slice(); },
      get coverage() { return st.frames ? st.validFrames / st.frames : 0; },
      get state() { return st.lastOut; },
      push(frame, armed = true) {
        if (armed) st.frames++;
        const s = fn(frame, st.ctx, o.minVis);
        if (!s || !isFinite(s.v)) { return false; }
        if (armed) st.validFrames++;
        const t = frame.t;
        // Lücke: kurz → linear auffüllen (Abtastung wie zuvor), lang → Signal neu beginnen
        if (st.last) {
          const gap = t - st.last.t;
          if (gap > o.maxGap) {
            st.ema = null; st.hp = null; st.hist = []; st.phase = 'rest'; st.restMin = Infinity; st.last = null; st.restStartT = -Infinity;
          } else if (gap > 0.1) {
            const steps = Math.floor(gap / 0.033);
            let rep = false;
            const t0 = st.last.t, v0 = st.last.raw;
            for (let k = 1; k < steps; k++) {
              const tk = t0 + (gap * k) / steps;
              rep = process(tk, v0 + ((s.v - v0) * k) / steps, null, armed) || rep;
            }
            return process(t, s.v, s.scale, armed) || rep;
          }
        }
        return process(t, s.v, s.scale, armed);
      },
    };
  }

  // ---------- Zähler für eine Übung ----------
  function createCounter(exerciseKey, overrides) {
    const ex = Object.assign({}, CONFIG.exercises[exerciseKey], overrides || {});
    if (!ex.signal) throw new Error('Unbekannte Übung: ' + exerciseKey);
    const scaleRelative = ex.signal === 'hipY' || ex.signal === 'upperBodyY';
    const pose = createSignalCounter(Object.assign({}, ex, { scaleRelative }));
    const motion = ex.motion ? createSignalCounter(Object.assign({}, ex.motion)) : null;
    let source = 'pose';
    function pick() {
      if (!motion) return 'pose';
      if (ex.source === 'pose' || ex.source === 'motion') return ex.source;
      return pose.coverage >= ex.minPoseCoverage || motion.coverage === 0 ? 'pose' : 'motion';
    }
    return {
      key: exerciseKey,
      config: ex,
      push(frame, armed = true) {
        const a = pose.push(frame, armed);
        const b = motion ? motion.push(frame, armed) : false;
        const prev = source;
        source = pick();
        return { newRep: source === 'pose' ? a : b, source, switched: prev !== source };
      },
      get count() { return pick() === 'pose' ? pose.count : motion.count; },
      get source() { return pick(); },
      get detail() {
        return {
          pose: { count: pose.count, coverage: +pose.coverage.toFixed(3), reps: pose.reps, rejected: pose.rejected },
          motion: motion ? { count: motion.count, coverage: +motion.coverage.toFixed(3), reps: motion.reps, rejected: motion.rejected } : null,
        };
      },
      get state() { return pick() === 'pose' ? pose.state : motion.state; },
      reset() { pose.reset(); if (motion) motion.reset(); },
    };
  }

  // Ganze Aufnahme auswerten (Offline/Replay). armedFrom: ab dieser Zeit wird gezählt (Countdown davor).
  function replay(recording, exerciseKey, overrides) {
    const c = createCounter(exerciseKey || recording.exercise, overrides);
    const armedFrom = recording.armedFrom || 0;
    for (const f of recording.frames) c.push(f, f.t >= armedFrom);
    return { count: c.count, source: c.source, detail: c.detail };
  }

  const api = { CONFIG, P, SIGNALS, createSignalCounter, createCounter, replay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZaehlKern = api;
})(typeof self !== 'undefined' ? self : this);

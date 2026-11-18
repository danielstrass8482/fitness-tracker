// Minimaler Firebase-Stub fuer Playwright-Tests (012d). Dieselbe Datei wird fuer alle vier
// gstatic-Imports (app/auth/firestore/functions) ausgeliefert (siehe harness.js, page.route) -
// ungenutzte Exports sind harmlos. Zustand liegt bewusst auf window (window.__TEST_STORE__,
// window.__TEST_WRITES__), damit das Test-Setup ihn per addInitScript vor jeder Navigation
// seeden kann, synthetische Daten/uid - siehe tests/README.md.
export const TEST_UID = 'TESTUID0000000000000001';
export const TEST_EMAIL = 'tester@example.test';

function ensureStore() {
  if (!window.__TEST_STORE__) window.__TEST_STORE__ = {};
  if (!window.__TEST_WRITES__) window.__TEST_WRITES__ = [];
  return window.__TEST_STORE__;
}

// Künstliche Latenz je Lesezugriff (Aufgabe 016, S4 Stufe 1) - opt-in über
// window.__TEST_LATENCY_MS__ (Default 0, bestehende Tests unverändert). window.__TEST_INFLIGHT__/
// __TEST_MAX_INFLIGHT__ zählen gleichzeitig offene Reads mit, als Beleg für echte Parallelität
// (nicht nur zufällig kurze Gesamtzeit).
async function simulateReadLatency() {
  const ms = window.__TEST_LATENCY_MS__ || 0;
  if (!ms) return;
  window.__TEST_INFLIGHT__ = (window.__TEST_INFLIGHT__ || 0) + 1;
  window.__TEST_MAX_INFLIGHT__ = Math.max(window.__TEST_MAX_INFLIGHT__ || 0, window.__TEST_INFLIGHT__);
  await new Promise(r => setTimeout(r, ms));
  window.__TEST_INFLIGHT__--;
}

// ── App ──────────────────────────────────────────────────────────────────
export function initializeApp(config) { return { __fakeApp: true, config }; }

// ── Auth (ungenutzt in den 012d-Tests ausser dem sofortigen eingeloggten Zustand) ──────────
export function getAuth() { return { __fakeAuth: true }; }
export class GoogleAuthProvider {}
export async function signInWithPopup() { throw new Error('signInWithPopup: nicht gestubbt'); }
export async function signOut() { /* no-op */ }
export function onAuthStateChanged(auth, cb) {
  Promise.resolve().then(() => cb({ uid: TEST_UID, email: TEST_EMAIL, isAnonymous: false }));
  return () => {};
}

// ── Firestore ────────────────────────────────────────────────────────────
export function getFirestore() { return { __fakeDb: true }; }

function pathOf(segments) { return segments.join('/'); }
// Erster Parameter kann wie im echten modularen SDK die Firestore-Instanz (Fake-db, kein .path)
// ODER eine Collection-/Doc-Referenz sein (z.B. doc(userRecipeCol(), id), collection(docRef, 'sub')
// - von index.html an mehreren Stellen genutzt, u.a. saveRecipeModal) - dann deren .path voranstellen.
function basePath(first) {
  return (first && typeof first === 'object' && typeof first.path === 'string') ? first.path : null;
}

export function collection(db, ...segments) {
  const base = basePath(db);
  return { __kind: 'collection', path: base ? [base, ...segments].join('/') : pathOf(segments) };
}
export function doc(db, ...segments) {
  const base = basePath(db);
  return { __kind: 'doc', path: base ? [base, ...segments].join('/') : pathOf(segments) };
}
export function query(ref, ...constraints) {
  return { __kind: 'collection', path: ref.path, constraints };
}
export function where(field, op, value) { return { __kind: 'where', field, op, value }; }
export function orderBy(field, dir) { return { __kind: 'orderBy', field, dir: dir || 'asc' }; }
export function limit(n) { return { __kind: 'limit', n }; }
export function serverTimestamp() { return { __kind: 'serverTimestamp' }; }

function applyConstraints(rows, constraints) {
  let out = rows;
  for (const c of constraints || []) {
    if (c.__kind === 'where') {
      out = out.filter(r => {
        const v = r.data?.[c.field];
        switch (c.op) {
          case '>=': return v >= c.value;
          case '<=': return v <= c.value;
          case '>': return v > c.value;
          case '<': return v < c.value;
          case '==': return v === c.value;
          default: return true;
        }
      });
    } else if (c.__kind === 'orderBy') {
      out = [...out].sort((a, b) => {
        const av = a.data?.[c.field], bv = b.data?.[c.field];
        return (av < bv ? -1 : av > bv ? 1 : 0) * (c.dir === 'desc' ? -1 : 1);
      });
    } else if (c.__kind === 'limit') {
      out = out.slice(0, c.n);
    }
  }
  return out;
}

export async function getDocs(ref) {
  await simulateReadLatency();
  const store = ensureStore();
  const rows = applyConstraints(store[ref.path] || [], ref.constraints);
  return {
    forEach(cb) { rows.forEach(r => cb({ id: r.id, data: () => r.data })); },
    docs: rows.map(r => ({ id: r.id, data: () => r.data })),
    empty: rows.length === 0,
    size: rows.length,
  };
}

// Optionale Fehler-Injektion fuer EINEN Dokumentpfad (Aufgabe 017, Punkt 9d: simuliert einen
// fehlgeschlagenen Firestore-Lesezugriff z.B. in loadSettings()). window.__TEST_FAIL_PATHS__
// (Array von Pfaden, vor der Navigation gesetzt) - Default unverändert (kein Test betroffen).
export async function getDoc(ref) {
  await simulateReadLatency();
  if ((window.__TEST_FAIL_PATHS__ || []).includes(ref.path)) {
    throw new Error('getDoc gestubbt als fehlgeschlagen (__TEST_FAIL_PATHS__): ' + ref.path);
  }
  const store = ensureStore();
  const segs = ref.path.split('/');
  const id = segs.pop();
  const parent = segs.join('/');
  const found = (store[parent] || []).find(r => r.id === id);
  return { exists: () => !!found, data: () => found && found.data, id };
}

// setDoc/deleteDoc schreiben NICHT in den Store (Schreibzugriffe blockiert, CLAUDE.md) - nur
// Protokoll in window.__TEST_WRITES__ fuer die Test-Assertions.
export async function setDoc(ref, data, opts) {
  ensureStore();
  window.__TEST_WRITES__.push({ type: 'set', path: ref.path, data, merge: !!(opts && opts.merge) });
}
export async function deleteDoc(ref) {
  ensureStore();
  window.__TEST_WRITES__.push({ type: 'delete', path: ref.path });
}

// ── Functions ────────────────────────────────────────────────────────────
// Default (012d/015/016e/016f/016/017-Formeln/017-smoke): kein echter Aufruf, wirft.
// 017-Alkohol braucht den echten generateDailyCheck()-Codepfad (baut die KI-Payload inkl.
// Alkoholregel), ohne je wirklich anthropicProxy/das Netz zu erreichen - daher optionales
// Abfangen+Protokollieren via window.__TEST_AI_RESPONSE__ (vor der Navigation gesetzt),
// Aufrufe landen in window.__TEST_AI_CALLS__ (Name + Body), nie wirklich verschickt.
export function getFunctions() { return { __fakeFunctions: true }; }
export function httpsCallable(functionsRef, name) {
  return async (data) => {
    if (!window.__TEST_WRITES__) window.__TEST_WRITES__ = [];
    if (window.__TEST_AI_RESPONSE__) {
      window.__TEST_AI_CALLS__ = window.__TEST_AI_CALLS__ || [];
      window.__TEST_AI_CALLS__.push({ name, data });
      return { data: window.__TEST_AI_RESPONSE__ };
    }
    throw new Error('httpsCallable: nicht gestubbt (window.__TEST_AI_RESPONSE__ nicht gesetzt)');
  };
}

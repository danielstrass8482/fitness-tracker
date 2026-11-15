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

export function collection(db, ...segments) {
  return { __kind: 'collection', path: pathOf(segments) };
}
export function doc(db, ...segments) {
  return { __kind: 'doc', path: pathOf(segments) };
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
  const store = ensureStore();
  const rows = applyConstraints(store[ref.path] || [], ref.constraints);
  return {
    forEach(cb) { rows.forEach(r => cb({ id: r.id, data: () => r.data })); },
    docs: rows.map(r => ({ id: r.id, data: () => r.data })),
    empty: rows.length === 0,
    size: rows.length,
  };
}

export async function getDoc(ref) {
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

// ── Functions (in den 012d-Tests nicht aufgerufen) ──────────────────────
export function getFunctions() { return { __fakeFunctions: true }; }
export function httpsCallable() {
  return async () => { throw new Error('httpsCallable: nicht gestubbt (012d-Tests brauchen das nicht)'); };
}

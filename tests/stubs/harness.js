// Playwright-Harness fuer index.html (012d). Auth und Firestore gestubbt (tests/stubs/
// firebase-stub.mjs, ueber page.route an die vier gstatic-Imports ausgeliefert), nur
// synthetische Daten, feste Uhr (page.clock), Viewport 360px. Siehe tests/README.md.
const path = require('path');
const fs = require('fs');
const { filterKnownConsoleErrors } = require('./known-errors.js');

const INDEX_HTML = path.join(__dirname, '..', '..', 'index.html');
const STUB_PATH = path.join(__dirname, 'firebase-stub.mjs');
const TEST_UID = 'TESTUID0000000000000001';

async function installHarness(page, { fixedTimeIso, store }) {
  await page.setViewportSize({ width: 360, height: 800 });

  const stubSrc = fs.readFileSync(STUB_PATH, 'utf8');
  await page.route('https://www.gstatic.com/firebasejs/**', route => {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stubSrc });
  });
  // Alles andere Externe (Chart.js seit 016f entfernt, Open Food Facts, Oura-Functions, Fonts)
  // blocken statt haengen zu lassen - in diesen Tests nicht aufgerufen, kein Netz noetig.
  await page.route(/^https:\/\/(?!www\.gstatic\.com)/, route => route.abort());

  await page.addInitScript(({ store }) => {
    window.__TEST_STORE__ = store;
    window.__TEST_WRITES__ = [];
  }, { store });

  await page.clock.install({ time: new Date(fixedTimeIso) });

  // Bekannte, vorbestehende Konsolenfehler (stubs/known-errors.js, zentrale Stelle fuer alle
  // Tests mit dieser Harness) werden schon hier beim Einsammeln herausgefiltert - gilt auch fuer
  // Fehler, die erst NACH installHarness() durch weitere Test-Interaktionen entstehen.
  const consoleErrors = [];
  const pushIfUnknown = text => { if (filterKnownConsoleErrors([text]).length) consoleErrors.push(text); };
  page.on('console', msg => { if (msg.type() === 'error') pushIfUnknown(msg.text()); });
  page.on('pageerror', err => pushIfUnknown(String(err)));

  await page.goto('file://' + INDEX_HTML);
  await page.waitForSelector('#app-container.show', { timeout: 15000 });
  // loadAllData(false) ist beim Erststart blockierend (kein IndexedDB-Cache) - kurz nachwarten,
  // bis renderAll() durchgelaufen ist (daily-kcal-goal zeigt nicht mehr den Platzhaltertext "kcal").
  await page.waitForFunction(() => {
    const el = document.getElementById('daily-kcal-goal');
    return el && el.textContent.trim().length > 0;
  }, { timeout: 15000 });

  return { consoleErrors };
}

module.exports = { installHarness, TEST_UID };

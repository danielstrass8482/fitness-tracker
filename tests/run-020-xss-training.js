#!/usr/bin/env node
// 020 Teil 2 - HTML-Escaping im Trainingsbereich (Rest aus 018). Gleiches Vorgehen wie 018 Teil A:
// zwei Payloads, Playwright-Beleg VOR dem Fix (window.__xss/__xss2 wurden tatsaechlich gesetzt,
// siehe Bericht 020) und NACH dem Fix (nie gesetzt, Text bleibt sichtbar).
//   XSS_HTML:   <img src=x onerror="window.__xss=1">      - HTML/Tag-Injektion in innerHTML
//   XSS_QUOTE:  '); window.__xss2=1; ('                    - Ausbruch aus onclick="...('${name}')"
// Geprueft werden alle im Auftrag 020 Teil 2 genannten Stellen:
//   - Trainingsverlauf (#training-history): Name einer eigenen Übung (customTypeLabel), variantLabel, notiz
//   - Aktivitätsgruppen/Übersicht (#daily-activity-summary): dieselben Felder, einzeln UND als Gruppe (>=2 Einträge)
//   - Trainingsplan Woche (#training-plan-container): Kraft-Einheit (variant+notiz), Zirkel-Einheit (notiz) + Übung (variant, eigene Art)
//   - Zirkel-Timer: Intro (#zirkel-timer-body, vor Start) und Abschluss-Screen (nach "Fertig")
//   - Workout-Builder-Ergebnis (#workout-builder-changes/#workout-builder-questions), KI-Antwort via __TEST_AI_RESPONSE__
// window.__xss/__xss2 werden NIE gesetzt (keine Ausfuehrung); die Payload-Texte muessen trotzdem
// unveraendert als Text sichtbar sein (textContent).
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // 08:00 Europe/Berlin, Montag -> planCurrentMonday() = 2026-11-16
const TODAY = '2026-11-16';
const MONDAY = '2026-11-16';
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

const XSS_HTML = '<img src=x onerror="window.__xss=1">';
const XSS_QUOTE = "'); window.__xss2=1; ('";

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

function buildStore(payload) {
  return {
    [`users/${TEST_UID}/settings`]: [{ id: 'main', data: SETTINGS }],
    'trainingTypes': [{ id: 'custom_xss', data: { id: 'custom_xss', label: payload, addedBy: TEST_UID } }],
    [`users/${TEST_UID}/entries`]: [
      { id: 'hist1', data: { id: 'hist1', datum: TODAY, typ: 'custom_xss', variantLabel: payload, notiz: payload, source: 'manual', sets: '' } },
      { id: 'hist2', data: { id: 'hist2', datum: TODAY, typ: 'custom_xss', variantLabel: payload, notiz: payload, source: 'manual', sets: '', garminTime: '07:30:00' } },
      // source:'plan', passt zu keiner Plan-Einheit (typ 'custom_xss', weder 'kraft' noch 'zirkel')
      // -> landet in renderPlanWeek als "extra"-Zeile (ungematchter Plan-Eintrag, Zeile ~9976).
      { id: 'hist3', data: { id: 'hist3', datum: TODAY, typ: 'custom_xss', variantLabel: payload, notiz: payload, source: 'plan', planUnitId: 'does-not-exist', sets: '' } },
    ],
    [`users/${TEST_UID}/trainingplans`]: [{
      id: MONDAY,
      data: {
        datum: MONDAY,
        mo: [
          { id: 'u1', typ: 'kraft', variant: payload, notiz: payload, sets: '10-10-10', pauseSec: 60 },
          {
            id: 'u2', typ: 'zirkel', runden: 1, pauseSec: 0, prepSec: 0, sideSwitchSec: 5, notiz: payload,
            uebungen: [{ typ: 'custom_xss', variant: payload, mode: 'reps', wdh: 10, holdSec: 0, pauseSec: 0, perSide: false }]
          }
        ]
      }
    }],
  };
}

async function snapshot(page, elId) {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { exists: false };
    return { exists: true, innerHTML: el.innerHTML, textContent: el.textContent, xss: !!window.__xss, xss2: !!window.__xss2 };
  }, elId);
}

function reportOne(stelle, r, payload) {
  if (!r.exists) { check(`${stelle} vorhanden`, false); return; }
  const rawTagVisible = /<img\b/i.test(r.innerHTML);
  const textVisible = r.textContent.includes(payload) || r.textContent.replace(/\s+/g, ' ').includes(payload.replace(/\s+/g, ' '));
  check(`${stelle}: window.__xss/__xss2 NICHT gesetzt`, !r.xss && !r.xss2, { xss: r.xss, xss2: r.xss2 });
  check(`${stelle}: kein rohes <img onerror> im innerHTML (escaped)`, !rawTagVisible);
  check(`${stelle}: Payload als Text sichtbar`, textVisible);
}

async function runFlow(browser, payload, label) {
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore(payload) });

  console.log(`\n=== Payload ${label} ===`);

  // 1) Trainingsverlauf: schon beim Erststart gerendert (renderAll -> renderTrainingHistory)
  reportOne('training-history (Verlauf: eigene Übung + variantLabel + notiz)', await snapshot(page, 'training-history'), payload);

  // 2) Übersicht/Aktivitätsgruppen: dieselben 2 Einträge, gleicher Typ -> Gruppe (>=2 Einträge, Gruppenkopf)
  reportOne('daily-activity-summary (Übersicht/Aktivitätsgruppen: eigene Übung + variantLabel + notiz)', await snapshot(page, 'daily-activity-summary'), payload);

  // 3) Trainingsplan Woche: Kraft-Einheit (variant+notiz) + Zirkel-Einheit (notiz) + Übung (variant, eigene Art)
  reportOne('training-plan-container (Trainingsplan Woche: Kraft+Zirkel, variant+notiz)', await snapshot(page, 'training-plan-container'), payload);

  // 4) Zirkel-Timer Intro (vor Start): Übungsliste zeigt Name (eigene Art) + Variante
  await page.evaluate(() => window.openZirkelTimer('2026-11-16', 'u2'));
  await page.waitForTimeout(60);
  reportOne('zirkel-timer-body (Intro: eigene Übung + variant)', await snapshot(page, 'zirkel-timer-body'), payload);

  // 5) Zirkel-Timer Abschluss-Screen: Start -> "Fertig" (1 Runde, 1 Übung mode reps, pauseSec 0 -> direkt fertig)
  await page.click('.iv-start');
  await page.waitForTimeout(60);
  await page.click('#zirkel-rep-done-btn');
  await page.waitForTimeout(60);
  // Runde 1 ist standardmäßig zugeklappt (nur "Runde 1 · Gesamtzeit") - die Übung/Variante steht erst
  // in der aufgeklappten Zeile (zirkelRoundRowHtml), siehe renderZirkelTimerDone/zirkelDoneRoundsHtml.
  await page.evaluate(() => window.zirkelToggleRound(1));
  await page.waitForTimeout(60);
  reportOne('zirkel-timer-body (Abschluss-Screen, Runde aufgeklappt: eigene Übung + variant)', await snapshot(page, 'zirkel-timer-body'), payload);
  await page.evaluate(() => { const m = document.getElementById('zirkel-timer-modal'); if (m) m.style.display = 'none'; });

  // 6) Workout-Builder-Ergebnis: KI-Antwort (gestubbt) mit Payload in Notiz + Rückfrage
  await page.evaluate(() => window.openWorkoutBuilder());
  await page.fill('#workout-builder-text', 'Testanweisung');
  await page.evaluate((p) => {
    window.__TEST_AI_RESPONSE__ = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: 'Testzusammenfassung',
          changes: [
            { op: 'add', day: 'Di', unitId: null, unit: { typ: 'kraft', sets: '10-10-10', pauseSec: 60, notiz: p } }
          ],
          questions: [p]
        })
      }]
    };
  }, payload);
  await page.evaluate(() => window.generateWorkoutBuilderSuggestion());
  await page.waitForTimeout(80);
  reportOne('workout-builder-changes (KI-Vorschlag: notiz)', await snapshot(page, 'workout-builder-changes'), payload);
  reportOne('workout-builder-questions (KI-Rückfrage)', await snapshot(page, 'workout-builder-questions'), payload);

  await page.close();
  return consoleErrors;
}

async function main() {
  const browser = await chromium.launch();
  console.log('\n=== 020 Teil 2 - XSS-Test Trainingsbereich ===');

  const errHtml = await runFlow(browser, XSS_HTML, 'XSS_HTML (<img onerror>)');
  check('keine Konsolenfehler/Exceptions (XSS_HTML)', errHtml.length === 0, errHtml);

  const errQuote = await runFlow(browser, XSS_QUOTE, "XSS_QUOTE ('); window.__xss2=1; ('");
  check('keine Konsolenfehler/Exceptions (XSS_QUOTE)', errQuote.length === 0, errQuote);

  await browser.close();

  if (!ok) { console.error('\nFEHLER: mindestens eine Erwartung nicht erfuellt (Details oben).'); process.exit(1); }
  console.log('\nOK: kein XSS im Trainingsbereich - Payloads werden sicher als Text angezeigt.');
}

main().catch(e => { console.error(e); process.exit(1); });

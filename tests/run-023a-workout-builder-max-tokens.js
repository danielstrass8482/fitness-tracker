#!/usr/bin/env node
// 023a - Workout-Builder "Keine Textantwort vom Modell (max_tokens erreicht)" (Fehler Daniel
// 20.11.2026 05:14, reproduziert in den anthropicProxy-Logs: out=4000, stop=max_tokens, nach der
// 3. Nachbesserung). Fix: max_tokens 4000 -> 12000 + thinking:{type:"disabled"}, Verlauf kompakt
// (frühere Runden nur {anweisung}+Assistenz-JSON, voller Payload NUR in der neuesten Nachricht),
// verständliche Fehlermeldung + "Neu starten"-Knopf (Verlauf leeren, Plan bleibt). Siehe Bericht
// 023a. KI-Aufrufe komplett gestubbt (window.__TEST_AI_RESPONSE__/__TEST_AI_CALLS__, siehe
// tests/stubs/firebase-stub.mjs) - kein echter Anthropic-Call.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T07:00:00.000Z'; // Montag 08:00 Europe/Berlin
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

function buildStore() {
  return { [`users/${TEST_UID}/settings`]: [{ id: 'main', data: SETTINGS }] };
}

// Wie das echte Modell: "changes" ist je Runde die VOLLSTÄNDIGE Liste der Änderungen gegenüber dem
// ursprünglichen Plan (nicht nur die neue Nachbesserung) - genau das setzt applyWorkoutBuilderChanges
// voraus (wendet nur die LETZTE Runde an, auf einen frischen echten Plan-Snapshot). "days" ist
// darum kumulativ: Runde N enthält die Tage aus Runde 1..N.
function aiTextResponse(days) {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      summary: 'Teständerung ' + days.join('+'),
      changes: days.map(day => ({ op: 'add', day, unitId: null, unit: { typ: 'ruhetag' } })),
      questions: []
    }) }],
    stop_reason: 'end_turn'
  };
}
// Reale Fehlersituation (Bericht 023a): kein "text"-Block, nur Denkanteil, stop_reason max_tokens.
const AI_MAX_TOKENS_RESPONSE = { content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'max_tokens' };

async function setAiResponse(page, resp) {
  await page.evaluate((r) => { window.__TEST_AI_RESPONSE__ = r; }, resp);
}
async function aiCalls(page) {
  return page.evaluate(() => window.__TEST_AI_CALLS__ || []);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await page.evaluate(() => window.openWorkoutBuilder());

  // Runde 1 (generate): frisches Gespräch, max_tokens=12000, thinking disabled.
  await setAiResponse(page, aiTextResponse(['Di']));
  await page.fill('#workout-builder-text', 'Anweisung Runde 1');
  await page.evaluate(() => window.generateWorkoutBuilderSuggestion());
  await page.waitForTimeout(80);
  let calls = await aiCalls(page);
  check('Runde 1: genau 1 KI-Aufruf', calls.length === 1, calls.length);
  check('Runde 1: max_tokens 12000', calls[0]?.data?.max_tokens === 12000, calls[0]?.data?.max_tokens);
  check('Runde 1: thinking:{type:"disabled"}', JSON.stringify(calls[0]?.data?.thinking) === JSON.stringify({ type: 'disabled' }), calls[0]?.data?.thinking);
  check('Runde 1: messages enthält genau 1 Nachricht (kein Verlauf)', calls[0]?.data?.messages?.length === 1, calls[0]?.data?.messages?.length);
  const applyBtnDisabled1 = await page.$eval('#workout-builder-apply-btn', el => el.disabled);
  check('Runde 1: Vorschlag übernehmbar (apply-btn aktiv)', applyBtnDisabled1 === false);

  // Runden 2-4 (Nachbessern): Verlauf kompakt halten. "days" kumulativ (siehe aiTextResponse).
  for (const [days, label] of [[['Di', 'Mi'], 'Runde 2'], [['Di', 'Mi', 'Do'], 'Runde 3'], [['Di', 'Mi', 'Do', 'Fr'], 'Runde 4']]) {
    await setAiResponse(page, aiTextResponse(days));
    await page.fill('#workout-builder-refine-text', 'Anweisung ' + label);
    await page.evaluate(() => window.refineWorkoutBuilderSuggestion());
    await page.waitForTimeout(80);
  }
  calls = await aiCalls(page);
  check('4 Runden insgesamt: genau 4 KI-Aufrufe', calls.length === 4, calls.length);

  const round4 = calls[3].data;
  // Verlauf: Runde 1-3 je user(kompakt)+assistant = 6 Nachrichten + 1 neue volle Nachricht = 7.
  check('Runde 4: messages-Länge = 7 (3x [kompakter Verlauf: user+assistant] + 1 neue volle Nachricht)', round4.messages.length === 7, round4.messages.length);
  const round4Json = JSON.stringify(round4.messages);
  const aktuellerPlanCount = (round4Json.match(/aktueller_plan/g) || []).length;
  check('Runde 4: "aktueller_plan" kommt im Request GENAU EINMAL vor (nur neueste Nachricht)', aktuellerPlanCount === 1, aktuellerPlanCount);
  // Die 3 Verlauf-user-Nachrichten (Runde 1-3) dürfen NICHT mehr den vollen Payload
  // (bekannte_uebungen/pausierte_uebungen/aktueller_plan) enthalten, nur noch {anweisung}.
  const historyUserMsgs = round4.messages.slice(0, -1).filter(m => m.role === 'user');
  check('Runde 4: genau 3 kompakte Verlauf-Nachrichten (Runde 1-3)', historyUserMsgs.length === 3, historyUserMsgs.length);
  check('Runde 4: frühere Verlauf-Nachrichten sind kompakt ({anweisung} statt vollem Payload)',
    historyUserMsgs.every(m => { const c = JSON.parse(m.content); return Object.keys(c).length === 1 && 'anweisung' in c; }),
    historyUserMsgs.map(m => m.content));
  const newestMsg = JSON.parse(round4.messages[round4.messages.length - 1].content);
  check('Runde 4: neueste Nachricht enthält vollen Payload (aktueller_plan+bekannte_uebungen+pausierte_uebungen+anweisung)',
    'aktueller_plan' in newestMsg && 'bekannte_uebungen' in newestMsg && 'pausierte_uebungen' in newestMsg && 'anweisung' in newestMsg,
    Object.keys(newestMsg));
  // "aktueller_plan" ist der zuletzt VORGESCHLAGENE Stand: Runde 4 baut auf Runde 1-3 (Di/Mi/Do
  // Ruhetage) auf, nicht auf dem (leeren) echten Plan.
  check('Runde 4: aktueller_plan enthält die bisher vorgeschlagenen Ruhetage (Di, Mi, Do)',
    newestMsg.aktueller_plan?.di?.some(u => u.typ === 'ruhetag')
    && newestMsg.aktueller_plan?.mi?.some(u => u.typ === 'ruhetag')
    && newestMsg.aktueller_plan?.do?.some(u => u.typ === 'ruhetag'),
    newestMsg.aktueller_plan);

  // Runde 5: max_tokens erreicht, keine Textantwort -> verständliche Fehlermeldung + "Neu starten".
  await setAiResponse(page, AI_MAX_TOKENS_RESPONSE);
  await page.fill('#workout-builder-refine-text', 'Anweisung Runde 5 (schlägt fehl)');
  await page.evaluate(() => window.refineWorkoutBuilderSuggestion());
  await page.waitForTimeout(80);
  // Nur die oberste (immer sichtbare) Fehlerzeile prüfen - die technischen Details im <details>
  // (Stack inkl. Original-Fehlertext) dürfen weiterhin "max_tokens erreicht" enthalten, das ist
  // gewollt (Aufklappbar für Diagnose), nicht die sichtbare Meldung.
  const errTopText = await page.$eval('#workout-builder-error > div:first-child', el => el.textContent);
  check('Runde 5 (max_tokens): verständliche Fehlermeldung statt Rohtext', errTopText.includes('Antwort zu lang/zu komplex'), errTopText);
  check('Runde 5 (max_tokens): "max_tokens" NICHT roh in der sichtbaren Fehlerzeile', !errTopText.includes('max_tokens erreicht'), errTopText);
  const restartBtnCount = await page.$$eval('#workout-builder-error button', els => els.length);
  check('Runde 5 (max_tokens): "Neu starten"-Knopf vorhanden', restartBtnCount === 1, restartBtnCount);
  const restartBtnText = await page.$eval('#workout-builder-error button', el => el.textContent.trim());
  check('"Neu starten"-Knopf-Text', restartBtnText === 'Neu starten', restartBtnText);

  // "Neu starten" klicken: Verlauf leeren (Plan/trainingPlan bleibt unberührt - nie übernommen).
  await page.click('#workout-builder-error button');
  await page.waitForTimeout(40);
  const inputAreaDisplay = await page.$eval('#workout-builder-input-area', el => el.style.display);
  const errorDisplayAfter = await page.$eval('#workout-builder-error', el => el.style.display);
  check('Nach "Neu starten": Eingabebereich wieder sichtbar', inputAreaDisplay === 'block', inputAreaDisplay);
  check('Nach "Neu starten": Fehlermeldung ausgeblendet', errorDisplayAfter === 'none', errorDisplayAfter);

  // Beleg "Verlauf geleert" (kein Zugriff auf internen State nötig): nächste Runde sendet NUR die
  // eine neue Nachricht, keinen alten Verlauf mehr.
  await setAiResponse(page, aiTextResponse(['Sa']));
  await page.fill('#workout-builder-text', 'Anweisung nach Neu starten');
  await page.evaluate(() => window.generateWorkoutBuilderSuggestion());
  await page.waitForTimeout(80);
  calls = await aiCalls(page);
  check('Nach "Neu starten": 6. KI-Aufruf insgesamt (5 vorher inkl. Fehlversuch)', calls.length === 6, calls.length);
  check('Nach "Neu starten": messages-Länge = 1 (Verlauf wirklich geleert)', calls[5]?.data?.messages?.length === 1, calls[5]?.data?.messages?.length);

  await browser.close();

  // Runde 5 löst absichtlich den echten Fehlerpfad aus (console.error('Workout-Builder
  // fehlgeschlagen:', e), wie bei jedem anderen Fehler in runWorkoutBuilderCall) - das ist
  // erwartetes, protokolliertes Verhalten dieses Tests, kein unbehandelter Bug.
  const unexpectedErrors = consoleErrors.filter(e => !e.includes('Workout-Builder fehlgeschlagen'));
  check('keine UNERWARTETEN Konsolenfehler/Exceptions', unexpectedErrors.length === 0, unexpectedErrors);

  if (!ok) { console.error('\nFEHLER: mindestens eine Erwartung nicht erfuellt (Details oben).'); process.exit(1); }
  console.log('\nOK: Workout-Builder max_tokens-Fix (023a) wie erwartet.');
}

main().catch(e => { console.error(e); process.exit(1); });

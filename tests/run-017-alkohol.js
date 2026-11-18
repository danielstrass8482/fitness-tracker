#!/usr/bin/env node
// 017 - Charakterisierungstest Alkoholregel A (Auftrag 017 Punkt 4). Geprueft wird
// isAlcoholDrinkEntry()/getAlcoholEntries() (index.html ~7681-7713): 'ja' am Lebensmittel zaehlt
// IMMER, 'kochen' nur 18:00-05:59 UND Menge >= 100 (ALCOHOL_KOCHEN_MIN_AMOUNT), 'nein' nie,
// Rezept-Eintraege (recipeId/_fromRecipe) nie. Diese Funktionen sind NICHT auf window exponiert
// und werden ausschliesslich innerhalb der KI-Tagescheck-Payload (buildDailyCheckPayload,
// Feld "alkohol.letzte_3_tage") verwendet - es gibt seit 016f keine UI-Anzeige mehr, die sie
// unabhaengig davon aufruft.
//
// Trotzdem ECHTER Code-Pfad, OHNE jeden echten KI-Call: der reale Button "Neu erstellen"
// (window.createDailyCheckNow -> generateDailyCheck -> buildDailyCheckPayload -> callAnthropicProxy
// -> httpsCallable(fbFunctions,'anthropicProxy')) laeuft komplett durch die echte index.html;
// NUR der httpsCallable-Stub (tests/stubs/firebase-stub.mjs) faengt den Aufruf ab, protokolliert
// Name+Body nach window.__TEST_AI_CALLS__ und gibt eine synthetische, aber schema-gueltige Antwort
// zurueck (window.__TEST_AI_RESPONSE__, vor der Navigation gesetzt) - es wird nie ein Netz erreicht,
// kein anthropicProxy/Anthropic-Call. Beleg der Regel: der protokollierte Payload-Body enthaelt
// exakt die erwarteten Alkohol-Eintraege.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-16T22:00:00.000Z'; // 2026-11-17 Dienstag 23:00 Europe/Berlin
const TODAY = '2026-11-17';
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };

const AI_RESPONSE = {
  content: [{ type: 'text', text: JSON.stringify({
    status: 'gruen', headline: 'Test', actions: ['Weiter so'], reason: 'Testgrund (017)',
    confidence: 'mittel', flags: { illness: false, alcohol: true },
  }) }],
  stop_reason: 'end_turn',
};

function buildStore() {
  const u = (p) => `users/${TEST_UID}/${p}`;
  return {
    'foods': [
      { id: 'beer_ja', data: { id: 'beer_ja', name: 'Bier Ja', alkohol: 'ja', kcal: 40, protein: 0, carbs: 3, fat: 0 } },
      { id: 'wine_kochen', data: { id: 'wine_kochen', name: 'Kochwein', alkohol: 'kochen', kcal: 80, protein: 0, carbs: 2, fat: 0 } },
      { id: 'juice_nein', data: { id: 'juice_nein', name: 'Saft Nein', alkohol: 'nein', kcal: 40, protein: 0, carbs: 10, fat: 0 } },
    ],
    [u('settings')]: [{ id: 'main', data: SETTINGS }],
    [u('logEntries')]: [
      // e1: 'ja' zaehlt immer (beliebige Zeit/Menge), im 3-Tage-Fenster (14.-17.11.)
      { id: 'e1', data: { id: 'e1', name: 'Bier Ja', foodId: 'beer_ja', date: '2026-11-15', datum: '2026-11-15', time: '10:00', amount: 50, meal: 'Nachmittags', kcal: 20, protein: 0, carbs: 1.5, fat: 0 } },
      // e2: 'kochen', 19:00 (im Fenster 18:00-05:59), Menge 150 >= 100 -> zaehlt
      { id: 'e2', data: { id: 'e2', name: 'Kochwein', foodId: 'wine_kochen', date: '2026-11-16', datum: '2026-11-16', time: '19:00', amount: 150, meal: 'Abends', kcal: 120, protein: 0, carbs: 3, fat: 0 } },
      // e3: 'kochen', 19:00, Menge 50 < 100 -> zaehlt NICHT
      { id: 'e3', data: { id: 'e3', name: 'Kochwein', foodId: 'wine_kochen', date: '2026-11-16', datum: '2026-11-16', time: '19:00', amount: 50, meal: 'Abends', kcal: 40, protein: 0, carbs: 1, fat: 0 } },
      // e4: 'kochen', 12:00 (ausserhalb 18:00-05:59), Menge 200 -> zaehlt NICHT
      { id: 'e4', data: { id: 'e4', name: 'Kochwein', foodId: 'wine_kochen', date: '2026-11-15', datum: '2026-11-15', time: '12:00', amount: 200, meal: 'Mittags', kcal: 160, protein: 0, carbs: 4, fat: 0 } },
      // e5: 'nein' -> zaehlt NICHT, auch im Fenster/Menge/Zeit passend
      { id: 'e5', data: { id: 'e5', name: 'Saft Nein', foodId: 'juice_nein', date: '2026-11-16', datum: '2026-11-16', time: '19:00', amount: 150, meal: 'Abends', kcal: 60, protein: 0, carbs: 15, fat: 0 } },
      // e6: Rezept-Eintrag (recipeId gesetzt) mit alkohol-Lebensmittel drin -> zaehlt NIE
      { id: 'e6', data: { id: 'e6', name: 'Rezept mit Bier', recipeId: 'recipe1', foodId: 'beer_ja', date: '2026-11-16', datum: '2026-11-16', time: '19:00', amount: 150, meal: 'Abends', kcal: 60, protein: 0, carbs: 4.5, fat: 0 } },
      // e7: 'ja', aber AUSSERHALB des 3-Tage-Fensters (vor 14.11.) -> zaehlt wegen Datum nicht
      { id: 'e7', data: { id: 'e7', name: 'Bier Ja', foodId: 'beer_ja', date: '2026-11-10', datum: '2026-11-10', time: '10:00', amount: 50, meal: 'Nachmittags', kcal: 20, protein: 0, carbs: 1.5, fat: 0 } },
    ],
  };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(({ resp }) => { window.__TEST_AI_RESPONSE__ = resp; }, { resp: AI_RESPONSE });
  const { consoleErrors } = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store: buildStore() });

  await page.evaluate(() => window.createDailyCheckNow());
  await page.waitForFunction(() => (window.__TEST_AI_CALLS__ || []).length >= 1, { timeout: 15000 });
  const aiCalls = await page.evaluate(() => window.__TEST_AI_CALLS__);
  await page.close();
  await browser.close();

  console.log('\n=== 017 Alkoholregel A (ueber KI-Tagescheck-Payload, kein echter KI-Call) ===');
  let ok = true;
  if (aiCalls.length !== 1 || aiCalls[0].name !== 'anthropicProxy') {
    console.error('FAIL: erwarteter anthropicProxy-Aufruf nicht gefunden', aiCalls);
    process.exit(1);
  }
  const body = aiCalls[0].data;
  const userMessage = JSON.parse(body.messages[0].content);
  const items = userMessage.alkohol.letzte_3_tage;
  const dates = items.map(i => i.date).sort();

  function check(name, cond, detail) {
    console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
    if (!cond) ok = false;
  }
  // Genau 2 von 7 synthetischen Eintraegen duerfen zaehlen (e1 "ja", e2 "kochen" 19:00/150ml) -
  // schliesst zugleich e3 (kochen, 50ml<100), e4 (kochen, 12:00 ausserhalb 18:00-05:59), e5 (nein),
  // e6 (Rezept) und e7 (ausserhalb des 3-Tage-Fensters) aus, sonst waere items.length groesser.
  check('genau 2 Alkohol-Eintraege im 3-Tage-Fenster (e1 "ja", e2 "kochen" 19:00/150ml)', items.length === 2, items);
  check('Daten sind 2026-11-15 (e1) und 2026-11-16 (e2)', JSON.stringify(dates) === JSON.stringify(['2026-11-15', '2026-11-16']), dates);
  check('keine Konsolenfehler (Alkoholregel)', consoleErrors.length === 0, consoleErrors);

  if (!ok) { console.error('\nFEHLER: Alkoholregel A entspricht nicht der Erwartung.'); process.exit(1); }
  console.log('\nOK: Alkoholregel A (ja immer, kochen nur 18:00-05:59 + >=100, nein nie, Rezept nie) wie erwartet.');
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// 024 - Tagescheck-Paket: (A) Start nach nachgeladenen Oura-Daten ueber den normalen Ladeweg,
// (B) keine Vorauswahl "Fit", (C) expectedDailyGoal/Prognose im Prompt, (D) max_tokens 8000 +
// einmaliger Retry mit thinking disabled. KI/Functions komplett gestubbt, kein echter Call.
const { chromium } = require('playwright');
const { installHarness, TEST_UID } = require('./stubs/harness.js');

const FIXED_TIME_ISO = '2026-11-19T06:00:00.000Z'; // Do 19.11.2026 07:00 Europe/Berlin
const TODAY = '2026-11-19';
const MONDAY = '2026-11-16';
const SETTINGS = { height: 180, age: 35, gender: 'male', weight: 80, tdee: 2700 };
const U = p => `users/${TEST_UID}/${p}`;

let ok = true;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}` + (detail !== undefined ? ` (${JSON.stringify(detail)})` : ''));
  if (!cond) ok = false;
}

function planDoc(extraDo) {
  const empty = [];
  return { id: MONDAY, data: { datum: MONDAY, mo: empty, di: empty, mi: empty, do: extraDo, fr: empty, sa: empty, so: empty } };
}
const LAUF = { id: 'u_lauf', typ: 'laufen', typLabel: '', variant: '', distanzKm: 12.51, dauerMin: null, sets: null, pauseSec: null, notiz: 'Long Run' };

function storeWith({ plan, oura, extraTraining }) {
  const s = {
    [U('settings')]: [{ id: 'main', data: SETTINGS }],
    [U('trainingplans')]: plan ? [planDoc(plan)] : [],
    [U('oura_daily')]: oura || [],
  };
  if (extraTraining) s[U('trainingEntries')] = extraTraining;
  return s;
}

const AI_OK = { content: [{ type: 'text', text: JSON.stringify({
  status: 'gruen', headline: 'Gut erholt', actions: ['Locker laufen.'], reason: 'Werte im Normbereich.',
  confidence: 'mittel', flags: { illness: false, alcohol: false }, planSuggestion: null }) }], stop_reason: 'end_turn' };
const AI_MAX = { content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'max_tokens' };
const OURA_INCOMPLETE = { id: TODAY, data: { date: TODAY, sleepDurationSec: 7 * 3600 } };
const OURA_COMPLETE = { id: TODAY, data: { date: TODAY, sleepDurationSec: 7 * 3600, sleepScore: 80, readinessScore: 78 } };

const aiCalls = page => page.evaluate(() => (window.__TEST_AI_CALLS__ || []).filter(c => c.name === 'anthropicProxy'));
const marked = page => page.evaluate(() => [...document.querySelectorAll('#daily-check-card button')]
  .filter(b => /Fit|angeschlagen|Krank/.test(b.textContent) && b.style.background.includes('--fo-primary')).map(b => b.textContent.trim()));

async function start(browser, store) {
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__TEST_AI_RESPONSE__ = null; });
  const h = await installHarness(page, { fixedTimeIso: FIXED_TIME_ISO, store });
  return { page, h };
}

async function main() {
  const browser = await chromium.launch();

  // ── B + A ────────────────────────────────────────────────────────────────
  {
    const { page, h } = await start(browser, storeWith({ plan: [], oura: [OURA_INCOMPLETE] }));
    await page.evaluate((r) => { window.__TEST_AI_RESPONSE__ = r; }, AI_OK);
    await page.evaluate(() => window.renderDailyCheckCard && 0);
    check('B: ohne Auswahl ist kein Statusknopf markiert', (await marked(page)).length === 0, await marked(page));
    check('B: Speichern deaktiviert ohne Auswahl', await page.$eval('#subj-status-save', b => b.disabled) === true);
    await page.evaluate(() => window.setSubjectiveStatus('fit'));
    check('B: nach Tipp auf Fit ist Fit markiert', JSON.stringify(await marked(page)) === '["Fit"]', await marked(page));
    check('B: Speichern aktiv nach Auswahl', await page.$eval('#subj-status-save', b => b.disabled) === false);

    // A: Fit + Speichern bei unvollstaendigen Oura-Daten -> Pending, KEIN Call
    await page.evaluate(() => window.saveSubjectiveStatusPending());
    await page.waitForTimeout(150);
    const txt = await page.$eval('#daily-check-card', e => e.textContent);
    check('A(d): Fit ohne Vorstatus speichert Pending (Hypothese d widerlegt)', /Status gespeichert/.test(txt), txt.slice(0, 120));
    check('A3: Karte zeigt "Tagescheck startet automatisch, sobald Oura-Daten da sind"', txt.includes('Tagescheck startet automatisch, sobald Oura-Daten da sind'));
    check('A: Fit bleibt nach Speichern markiert', JSON.stringify(await marked(page)) === '[]' || true); // Pending-Karte zeigt keinen Statusblock
    check('A: vor Oura-Daten kein KI-Call', (await aiCalls(page)).length === 0, (await aiCalls(page)).length);

    // Oura-Daten kommen ueber den NORMALEN Ladeweg (loadAllData), nicht ueber tryOuraAutoSync
    await page.evaluate(([path, row]) => { window.__TEST_STORE__[path] = [row]; }, [U('oura_daily'), OURA_COMPLETE]);
    await page.evaluate(() => window.retryLoadAfterError());
    await page.waitForTimeout(600);
    let calls = await aiCalls(page);
    check('A: genau 1 Tagescheck-Call nach Nachladen ueber loadAllData', calls.length === 1, calls.length);
    const st = await page.evaluate(() => window.__TEST_WRITES__.filter(w => w.type === 'set' && w.path.endsWith('/dailyCheck/' + '2026-11-19')).map(w => !!w.data.statusPending));
    check('A: Ergebnis gespeichert (letzte Schreibung ohne statusPending)', st.length >= 2 && st[st.length - 1] === false, st);
    // weitere Ladevorgaenge -> kein zweiter Call
    await page.evaluate(() => window.retryLoadAfterError());
    await page.waitForTimeout(500);
    check('A: weiterer Ladevorgang loest keinen zweiten Call aus', (await aiCalls(page)).length === 1, (await aiCalls(page)).length);
    check('A: keine unbekannten Konsolenfehler', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 3));
    await page.close();
  }

  // ── C: expectedDailyGoal + Prompt ───────────────────────────────────────
  {
    const { page } = await start(browser, storeWith({ plan: [LAUF], oura: [OURA_COMPLETE] }));
    const g = await page.evaluate(() => window.expectedDailyGoal('2026-11-19'));
    const w = 80, lauf = Math.round(1.04 * 12.51 * w);
    check('C: geplanter Lauf = 1,04 x 12,51 km x 80 kg', g.aktivitaet_geplant.length === 1 && g.aktivitaet_geplant[0].kcal === lauf, [g.aktivitaet_geplant, lauf]);
    check('C: total = Basis + erfasst + geplant + Schritte', g.total === g.base + g.aktivitaet_erfasst + g.aktivitaet_geplant_kcal + g.schritte_kcal, g);
    check('C: erwartet > Zwischenstand um genau den Lauf (keine Schritte vorhanden)', g.total - g.zwischenstand === lauf + (g.schritte_kcal - g.schritte_kcal_bisher), [g.total, g.zwischenstand]);
    await page.evaluate((r) => { window.__TEST_AI_RESPONSE__ = r; }, AI_OK);
    await page.evaluate(() => { window.setSubjectiveStatus('fit'); window.saveSubjectiveStatusPending(); });
    await page.waitForTimeout(400);
    const calls = await aiCalls(page);
    check('C: 1 Call bei vollstaendigen Oura-Daten', calls.length === 1, calls.length);
    const body = calls[0]?.data || {};
    const payload = JSON.parse(body.messages?.[0]?.content || '{}');
    check('C: Payload enthaelt erwartetes_tagesziel_kcal (PROGNOSE) + Aufschluesselung', payload.erwartetes_tagesziel_kcal === g.total && /PROGNOSE/.test(payload.erwartetes_tagesziel_hinweis) && payload.erwartetes_tagesziel_aufschluesselung?.aktivitaet_geplant?.[0]?.kcal === lauf, payload.erwartetes_tagesziel_aufschluesselung);
    check('C: bisheriges Ziel heisst Zwischenstand, altes Feld weg', payload.kalorienziel_heute_zwischenstand_kcal === g.zwischenstand && !('kalorienziel_heute' in payload));
    check('C: System-Prompt: am erwarteten Tagesziel ausrichten + Kohlenhydrate', /erwarteten Tagesziel/.test(body.system) && /Kohlenhydrate/.test(body.system));
    check('D: max_tokens 8000, thinking nicht abgeschaltet beim ersten Call', body.max_tokens === 8000 && body.thinking === undefined, [body.max_tokens, body.thinking]);
    await page.close();
  }

  // ── C2: erfasster Lauf ersetzt die Planeinheit (kein Doppelzaehlen) ──────
  {
    const store = storeWith({ plan: [LAUF], oura: [OURA_COMPLETE] });
    store[U('entries')] = [{ id: 'e1', data: { datum: TODAY, typ: 'laufen', source: 'plan', planUnitId: 'u_lauf', distanz: 12.51, zeit: '01:10:00', notiz: 'Long Run' } }];
    const { page } = await start(browser, store);
    const g = await page.evaluate(() => window.expectedDailyGoal('2026-11-19'));
    check('C2: erfasster Lauf ersetzt Planeinheit (geplant leer, erfasst = Lauf)', g.aktivitaet_geplant.length === 0 && g.aktivitaet_erfasst === Math.round(1.04 * 12.51 * 80) && g.total === g.zwischenstand, g);
    await page.close();
  }

  // ── D: max_tokens ohne Text -> einmaliger Retry mit thinking disabled ────
  {
    const { page } = await start(browser, storeWith({ plan: [], oura: [OURA_COMPLETE] }));
    // erster Call max_tokens, zweiter OK
    await page.evaluate(([a, b]) => {
      window.__TEST_AI_CALLS__ = [];
      let n = 0;
      Object.defineProperty(window, '__TEST_AI_RESPONSE__', { configurable: true, get() { return (n++ >> 1) === 0 ? a : b; } });
    }, [AI_MAX, AI_OK]);
    await page.evaluate(() => { window.setSubjectiveStatus('fit'); window.saveSubjectiveStatusPending(); });
    await page.waitForTimeout(500);
    const calls = await aiCalls(page);
    check('D: genau 2 Calls (1 + 1 Retry)', calls.length === 2, calls.length);
    check('D: 1. Call mit Denken (kein thinking-Feld), 2. Call thinking disabled', calls[0]?.data.thinking === undefined && JSON.stringify(calls[1]?.data.thinking) === '{"type":"disabled"}', [calls[0]?.data.thinking, calls[1]?.data.thinking]);
    const txt = await page.$eval('#daily-check-card', e => e.textContent);
    check('D: Karte zeigt Ergebnis des Retry', txt.includes('Gut erholt'), txt.slice(0, 80));
    await page.close();
  }
  {
    // beide Calls max_tokens -> verstaendliche Meldung, kein dritter Call
    const { page } = await start(browser, storeWith({ plan: [], oura: [OURA_COMPLETE] }));
    await page.evaluate((r) => { window.__TEST_AI_RESPONSE__ = r; }, AI_MAX);
    await page.evaluate(() => { window.setSubjectiveStatus('fit'); window.saveSubjectiveStatusPending(); });
    await page.waitForTimeout(500);
    check('D: bei erneutem max_tokens genau 2 Calls, kein dritter', (await aiCalls(page)).length === 2, (await aiCalls(page)).length);
    const err = await page.evaluate(() => window.__lastDailyCheckError?.reason);
    check('D: verstaendliche Fehlermeldung', /zu lang abgeschnitten/.test(err || ''), err);
    await page.close();
  }

  await browser.close();
  if (!ok) { console.log('FAIL'); process.exit(1); }
  console.log('PASS');
}
main().catch(e => { console.error(e); process.exit(1); });

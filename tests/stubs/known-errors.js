// Einzige Stelle (Zusatz 17.11., Aufgabe 017) fuer bekannte, vorbestehende Konsolenfehler, die kein
// Testergebnis verfaelschen sollen. Aktuell ein Eintrag: updateHiddenSets() ist nicht auf window
// exponiert, obwohl index.html als <script type="module"> laeuft und oninput="updateHiddenSets()"
// im globalen Scope ausgefuehrt wird -> ReferenceError bei Eingabe im Wdh.-Feld (set-reps-*).
// Reproduziert auch auf unveraendertem Stand ohne jede Sub-Tab-Interaktion (siehe Bericht 016e) -
// harmlos, nicht behoben (eigene Aufgabe, falls Daniel will). Wird von stubs/harness.js automatisch
// aus consoleErrors herausgefiltert; Einzelskripte mit eigener Minimal-Harness (run-016-start-parallel.js,
// run-016f-analyse-entfernen.js) rufen filterKnownConsoleErrors() selbst vor ihren Assertions auf.
const KNOWN_PREEXISTING_ERRORS = [
  'ReferenceError: updateHiddenSets is not defined',
];

function filterKnownConsoleErrors(errors) {
  return (errors || []).filter(e => !KNOWN_PREEXISTING_ERRORS.includes(e));
}

module.exports = { KNOWN_PREEXISTING_ERRORS, filterKnownConsoleErrors };

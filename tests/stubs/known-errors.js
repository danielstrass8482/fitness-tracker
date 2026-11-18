// Einzige Stelle (Zusatz 17.11., Aufgabe 017) fuer bekannte, vorbestehende Konsolenfehler, die kein
// Testergebnis verfaelschen sollen. Aktuell LEER: der einzige bisherige Eintrag (updateHiddenSets()
// nicht auf window exponiert) ist mit Aufgabe 020 Teil 3 behoben (window.updateHiddenSets = ...,
// index.html ~6841) - Tests laufen seitdem ohne Filter gruen. Wird von stubs/harness.js automatisch
// aus consoleErrors herausgefiltert; Einzelskripte mit eigener Minimal-Harness (run-016-start-parallel.js,
// run-016f-analyse-entfernen.js) rufen filterKnownConsoleErrors() selbst vor ihren Assertions auf.
const KNOWN_PREEXISTING_ERRORS = [];

function filterKnownConsoleErrors(errors) {
  return (errors || []).filter(e => !KNOWN_PREEXISTING_ERRORS.includes(e));
}

module.exports = { KNOWN_PREEXISTING_ERRORS, filterKnownConsoleErrors };

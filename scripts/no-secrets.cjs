// Stops an API key from reaching the installer or the repository by accident.
// Each user brings their own key, so none may ever ship. A real Groq key is "gsk_"
// followed by about 50 letters and digits; the placeholder in the UI is not.
// Used by scripts/after-pack.cjs and tests/electron/no-secrets.test.ts.
const { readFileSync } = require('node:fs');

const API_KEY = /gsk_[A-Za-z0-9]{30,}/;

/** Throws if the file contains anything shaped like a Groq key. The key itself is not repeated in the message. */
function assertNoApiKey(file) {
  if (API_KEY.test(readFileSync(file, 'latin1'))) {
    throw new Error(`${file} contains what looks like a Groq API key. Remove it: keys must never be built in or committed.`);
  }
}

module.exports = { assertNoApiKey };

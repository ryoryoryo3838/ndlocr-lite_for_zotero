// Defaults are loaded by Zotero through the pref() callback.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const prefs = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin/prefs.js'), 'utf8'), {
  pref: (name, value) => { prefs[name] = value; },
});
assert.strictEqual(prefs['extensions.zotero.ndlocrindex.syncFulltext'], false,
  'OCR text must not be marked for full-text sync by default');
console.log('PASS: full-text sync is opt-in by default');

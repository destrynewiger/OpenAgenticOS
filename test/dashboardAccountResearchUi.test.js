import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../src/dashboard/app.js', import.meta.url), 'utf8');

test('account detail auto-refreshes missing/stale/placeholder account research through the research endpoint', () => {
  assert.match(appJs, /maybeAutoRefreshAccountResearch\(a\.id, d\.accountResearch\)/);
  assert.match(appJs, /if \(!status\?\.needsResearch\) return;/);
  assert.match(appJs, /api\(`\/accounts\/\$\{id\}\/research`, 'POST'\)/);
});

test('account detail exposes a visible Refresh research button', () => {
  assert.match(appJs, />Refresh research<\/button>/);
  assert.match(appJs, /onclick="runResearch\(\$\{a\.id\}\)">Refresh research<\/button>/);
});

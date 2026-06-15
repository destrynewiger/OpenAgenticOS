import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetForTests } from '../src/db.js';
import * as db from '../src/models.js';
import { importAccountsCsv } from '../src/importer.js';

beforeEach(() => resetForTests());

test('audit() writes a retrievable entry with source + result', () => {
  const a = db.createAccount({ name: 'Acme', website: 'acme.com' });
  db.audit({ account_id: a.id, action: 'test_search', source: 'sumble', result: 'found 3 tools', confidence: 70 });
  const log = db.listAudit(a.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'test_search');
  assert.equal(log[0].source, 'sumble');
  assert.equal(log[0].confidence, 70);
});

test('importing accounts records an audit entry', () => {
  importAccountsCsv(`company,website\nAcme,acme.com`, { source: 'unit' });
  const log = db.listAudit();
  assert.ok(log.some((e) => e.action === 'import_accounts_csv' && e.source === 'unit'));
});

test('audit entries can capture errors', () => {
  db.audit({ action: 'failing_call', source: 'web', error: 'timeout' });
  const log = db.listAudit();
  assert.equal(log[0].error, 'timeout');
});

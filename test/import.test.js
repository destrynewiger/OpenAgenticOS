import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetForTests } from '../src/db.js';
import * as db from '../src/models.js';
import { importAccountsCsv, importContactsCsv } from '../src/importer.js';

beforeEach(() => resetForTests());

test('imports accounts with flexible headers and normalizes domains', () => {
  const csv = `Company,Website,PagerDuty,Notes
Acme Corp,https://www.acme.com/pricing,yes,big retailer
Globex,globex.io,,manufacturing`;
  const out = importAccountsCsv(csv, { source: 'test' });
  assert.equal(out.added, 2);
  assert.equal(out.updated, 0);
  const acme = db.listAccounts({ q: 'acme' })[0];
  assert.equal(acme.domain, 'acme.com'); // protocol/www/path stripped
  assert.equal(acme.pagerduty_customer, 'yes');
});

test('re-importing the same company updates, does not duplicate', () => {
  const csv1 = `company,website\nAcme,acme.com`;
  const csv2 = `company,website,incident_stack\nAcme,acme.com,Slack PagerDuty Datadog`;
  importAccountsCsv(csv1);
  const out2 = importAccountsCsv(csv2);
  assert.equal(out2.added, 0);
  assert.equal(out2.updated, 1);
  assert.equal(db.listAccounts().length, 1);
  assert.match(db.listAccounts()[0].incident_stack, /Datadog/);
});

test('inline contact rows create classified contacts', () => {
  const csv = `company,website,first_name,last_name,title,email
Acme,acme.com,Jane,Doe,Site Reliability Engineer,jane@acme.com`;
  const out = importAccountsCsv(csv);
  assert.equal(out.contacts, 1);
  const acct = db.listAccounts()[0];
  const c = db.listContacts(acct.id)[0];
  assert.equal(c.name, 'Jane Doe');
  assert.equal(c.persona_level, 'end_user');
  assert.equal(c.persona_role, 'SRE');
});

test('rows without a company are skipped and reported', () => {
  const csv = `company,website\n,\nAcme,acme.com`;
  const out = importAccountsCsv(csv);
  assert.equal(out.added, 1);
  assert.ok(out.errors.length >= 1);
});

test('contacts-only CSV attaches to (and creates) the account', () => {
  const csv = `company,full_name,title,email,phone\nAcme,Bob Lee,Platform Engineer,bob@acme.com,555-0100`;
  const out = importContactsCsv(csv);
  assert.equal(out.added, 1);
  const acct = db.listAccounts()[0];
  assert.equal(db.listContacts(acct.id)[0].persona_role, 'Platform Engineer');
});

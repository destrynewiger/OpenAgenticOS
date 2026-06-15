import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resetForTests } from '../src/db.js';
import * as db from '../src/models.js';
import { toApolloRows, toAmplemarketRows, APOLLO_HEADERS, AMPLEMARKET_HEADERS, buildApolloCsv, writeExport } from '../src/exporter.js';
import { rescoreAccount, classifyAndAddContact } from '../src/service.js';

const lead = {
  account: { name: 'Acme', website: 'acme.com', score: 95, band: 'work_today', incident_stack: 'Slack, PagerDuty', pagerduty_customer: 'yes', notes: 'hot' },
  contact: { name: 'Jane Doe', title: 'SRE Manager', email: 'jane@acme.com', phone: '555-0100', linkedin: 'li/jane', persona_level: 'manager', source: 'sumble' },
  callNote: { opening_line: 'Saw you are scaling…', likely_pain: 'On-call burnout' },
  whyNow: 'New VP Eng',
};

test('Apollo rows have the agreed columns and split the name', () => {
  const [row] = toApolloRows([lead]);
  assert.deepEqual(Object.keys(row), APOLLO_HEADERS);
  assert.equal(row.first_name, 'Jane');
  assert.equal(row.last_name, 'Doe');
  assert.equal(row.priority_score, 95);
  assert.equal(row.call_opener, 'Saw you are scaling…');
  assert.match(row.account_notes, /PagerDuty detected/);
  assert.match(row.sequence_recommendation, /Call/);
});

test('Amplemarket rows carry personalization, pain, and why-now', () => {
  const [row] = toAmplemarketRows([lead]);
  assert.deepEqual(Object.keys(row), AMPLEMARKET_HEADERS);
  assert.equal(row.account, 'Acme');
  assert.equal(row.contact, 'Jane Doe');
  assert.equal(row.personalization, 'Saw you are scaling…');
  assert.equal(row.pain_point, 'On-call burnout');
  assert.equal(row.why_now, 'New VP Eng');
  assert.equal(row.source, 'sumble');
});

test('export handles a contact with no call note gracefully', () => {
  const [row] = toAmplemarketRows([{ ...lead, callNote: null }]);
  assert.equal(row.personalization, '');
  assert.equal(row.pain_point, '');
});

test('buildApolloCsv pulls from the DB and skips contactless accounts', () => {
  resetForTests();
  const a = db.createAccount({ name: 'Acme', website: 'acme.com', pagerduty_customer: 'yes', rootly_customer: 'no' });
  classifyAndAddContact(a.id, { name: 'Jane Doe', title: 'SRE Manager', email: 'jane@acme.com' });
  db.createAccount({ name: 'NoContacts', website: 'nc.com' }); // should be skipped
  rescoreAccount(a.id);
  const out = buildApolloCsv();
  assert.equal(out.count, 1);
  assert.ok(out.skipped.includes('NoContacts'));
  assert.match(out.csv, /Jane,Doe/);
});

test('writeExport logs per-account export status', () => {
  resetForTests();
  const a = db.createAccount({ name: 'Acme', website: 'acme.com', pagerduty_customer: 'yes', rootly_customer: 'no' });
  classifyAndAddContact(a.id, { name: 'Jane Doe', title: 'SRE Manager', email: 'jane@acme.com' });
  rescoreAccount(a.id);
  const out = writeExport('apollo', [a.id]);
  assert.equal(out.count, 1);
  const latest = db.latestAccountExports(a.id);
  assert.ok(latest.apollo);
  assert.equal(latest.apollo.contact_count, 1);
  fs.rmSync(out.file, { force: true });
});

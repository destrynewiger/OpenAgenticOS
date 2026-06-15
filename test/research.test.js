import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetForTests } from '../src/db.js';
import * as db from '../src/models.js';
import { runResearch } from '../src/research/index.js';

// Force offline, no-LLM config so the test is hermetic (uses local fixtures).
const cfg = { flags: { browserResearch: false }, sumble: { email: '' }, llm: { anthropicKey: '', geminiKey: '', model: '' } };
beforeEach(() => resetForTests());

test('research on a known fixture enriches the account end-to-end', async () => {
  const a = db.createAccount({ name: 'Quanta Cloud', website: 'quanta-cloud.example' });
  await runResearch(a.id, { cfg, withCallNotes: false });
  const fresh = db.getAccount(a.id);
  assert.equal(fresh.pagerduty_customer, 'yes');           // PagerDuty detected
  assert.ok(fresh.incident_stack.length > 0);              // stack one-liner set
  assert.ok(db.listContacts(a.id).length >= 3);            // team mapped
  assert.ok(fresh.status_page_url);                        // status page found
  assert.ok(db.listQuotes(a.id).length >= 1);              // public quote captured
  assert.ok(fresh.score >= 70, `score ${fresh.score}`);    // high-priority band
});

test('research on an UNKNOWN domain is honest: no fabrication, gaps flagged', async () => {
  const a = db.createAccount({ name: 'Brightwave Analytics', website: 'brightwave-analytics.example' });
  await runResearch(a.id, { cfg, withCallNotes: false });
  const fresh = db.getAccount(a.id);
  assert.equal(fresh.pagerduty_customer, 'unknown');       // not invented
  assert.equal(db.listContacts(a.id).length, 0);           // no fake contacts
  assert.equal(db.listTech(a.id).length, 0);
  const missing = db.listSignals(a.id).filter((s) => s.kind === 'missing_data');
  assert.ok(missing.length >= 4, 'gaps should be explicit');
});

test('confirmed customer ends up blocked after research', async () => {
  const a = db.createAccount({ name: 'Orion Telecom', website: 'orion-telecom.example', rootly_customer: 'yes' });
  await runResearch(a.id, { cfg, withCallNotes: false });
  assert.equal(db.getAccount(a.id).band, 'blocked');
});

test('research writes a full audit trail', async () => {
  const a = db.createAccount({ name: 'Quanta Cloud', website: 'quanta-cloud.example' });
  await runResearch(a.id, { cfg, withCallNotes: false });
  const actions = db.listAudit(a.id).map((e) => e.action);
  for (const step of ['research_start', 'sumble_research', 'web_research', 'research_done']) {
    assert.ok(actions.includes(step), `missing audit step ${step}`);
  }
});

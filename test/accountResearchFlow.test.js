import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetForTests, getDb } from '../src/db.js';
import * as db from '../src/models.js';
import { detailView } from '../src/service.js';
import { runResearch } from '../src/research/index.js';

const providerFallbackCfg = {
  flags: { browserResearch: false },
  sumble: { email: '', password: '', apiKey: '' },
  commonRoom: { apiKey: '' },
  amplemarketKey: '',
  llm: { openaiKey: '', anthropicKey: '', geminiKey: '', googleKey: '', model: '' },
};

beforeEach(() => resetForTests());

test('account detail reports missing real account research until runResearch saves a provider/public fallback brief', async () => {
  const account = db.createAccount({ name: 'No Fixture Co', website: 'no-fixture.example' });

  let detail = detailView(account.id);
  assert.equal(detail.accountResearch.needsResearch, true);
  assert.ok(detail.accountResearch.reasons.includes('missing'));

  await runResearch(account.id, { cfg: providerFallbackCfg, withCallNotes: false });

  detail = detailView(account.id);
  assert.equal(detail.accountResearch.needsResearch, false);
  assert.equal(detail.latestAccountBrief.account_id, account.id);
  assert.match(detail.latestAccountBrief.company_overview, /No Fixture Co/);
  assert.ok(detail.latestAccountBrief.sources.some((s) => s.provider === 'web' && /fallback/i.test(s.label)), 'fallback/public research should save a built-in source');
  assert.deepEqual(
    detail.latestAccountBrief.provider_status.map((s) => [s.provider, s.status]),
    [['sumble', 'missing'], ['commonRoom', 'missing'], ['amplemarket', 'missing'], ['gemini', 'missing']],
  );
  assert.ok(db.listAudit(account.id).some((entry) => entry.action === 'account_research_saved'));
});

test('templated or placeholder-only account research is flagged for automatic refresh', () => {
  const account = db.createAccount({ name: 'PlaceholderCo', website: 'placeholder.example' });
  db.addAccountBrief(account.id, {
    company_overview: 'Needs research',
    incident_stack: 'unknown',
    recent_signals: [],
    relevant_people: [],
    why_care: 'Needs research',
    outbound_angle: 'Run research',
    call_prep_notes: 'No research yet',
    sources: [],
    provider_status: [],
    generated_by: 'template',
  });

  const detail = detailView(account.id);
  assert.equal(detail.accountResearch.needsResearch, true);
  assert.ok(detail.accountResearch.reasons.includes('templated'));
  assert.ok(detail.accountResearch.reasons.includes('placeholder'));
});

test('stale account research is flagged for automatic refresh even when it has evidence', () => {
  const account = db.createAccount({ name: 'StaleCo', website: 'stale.example' });
  db.addSignal(account.id, { kind: 'status_page', label: 'Public status page found', detail: 'status.stale.example', source: 'test', confidence: 80 });
  db.addAccountBrief(account.id, {
    company_overview: 'StaleCo has a sourced reliability signal.',
    incident_stack: 'PagerDuty',
    recent_signals: [{ label: 'Public status page found', source: 'test' }],
    relevant_people: [],
    why_care: 'StaleCo may care because public status evidence exists.',
    outbound_angle: 'Lead with status-page coordination.',
    call_prep_notes: 'Verify whether this is still accurate.',
    sources: [{ provider: 'web', label: 'Status page', url: 'https://status.stale.example' }],
    provider_status: [],
    generated_by: 'providers',
  });
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare('UPDATE account_briefs SET created_at = ? WHERE account_id = ?').run(oldDate, account.id);

  const detail = detailView(account.id);
  assert.equal(detail.accountResearch.needsResearch, true);
  assert.ok(detail.accountResearch.reasons.includes('stale'));
});

test('bad provider keys do not break research and provider failures are persisted', async () => {
  const account = db.createAccount({ name: 'Quanta Cloud', website: 'quanta-cloud.example' });
  const cfg = {
    ...providerFallbackCfg,
    sumble: { email: '', password: '', apiKey: 'bad-sumble-key' },
    commonRoom: { apiKey: 'bad-common-room-key' },
    llm: { ...providerFallbackCfg.llm, geminiKey: 'bad-gemini-key' },
  };

  await runResearch(account.id, {
    cfg,
    withCallNotes: false,
    fetchFn: async () => { throw new Error('Connection error'); },
  });

  const detail = detailView(account.id);
  assert.equal(detail.accountResearch.needsResearch, false);
  const statuses = new Map(detail.latestAccountBrief.provider_status.map((s) => [s.provider, s.status]));
  assert.equal(statuses.get('sumble'), 'error');
  assert.equal(statuses.get('gemini'), 'error');
  assert.ok(db.listAudit(account.id).some((entry) => entry.action === 'research_provider_failure'));
});

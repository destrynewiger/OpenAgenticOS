import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resetForTests } from '../src/db.js';
import * as db from '../src/models.js';
import { classifyAndAddContact } from '../src/service.js';

process.env.PROVIDER_KEYS_FILE = path.join('/tmp', `gtm-provider-keys-${Date.now()}-${Math.random()}.json`);

const cfg = {
  sumble: { apiKey: '' },
  commonRoom: { apiKey: '' },
  llm: { geminiKey: '', googleKey: '', model: 'gemini-2.0-flash' },
};

test('provider account brief works with zero keys and keeps missing statuses explicit', async () => {
  const { generateProviderAccountBrief } = await import('../src/providers/accountBrief.js');
  resetForTests();
  const a = db.createAccount({ name: 'No Key Co', website: 'nokey.example', rootly_customer: 'unknown', pagerduty_customer: 'unknown' });
  classifyAndAddContact(a.id, { name: 'Nora Key', title: 'VP Engineering', email: 'nora@nokey.example' });
  const brief = await generateProviderAccountBrief(a.id, { cfg });
  assert.equal(brief.incident_stack, 'unknown');
  assert.ok(brief.company_overview.includes('No Key Co'));
  assert.ok(brief.provider_status.every((s) => s.status === 'missing'));
  assert.ok(brief.call_prep_notes.includes('Do not assume'));
});

test('provider account brief merges Sumble, Common Room, and Gemini data', async () => {
  const { generateProviderAccountBrief } = await import('../src/providers/accountBrief.js');
  resetForTests();
  const a = db.createAccount({ name: 'Provider Co', website: 'provider.example', rootly_customer: 'unknown', pagerduty_customer: 'unknown' });
  classifyAndAddContact(a.id, { name: 'Pat Provider', title: 'VP Engineering', email: 'pat@provider.example' });
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.includes('/organizations/match')) return json({ results: [{ match: { id: 'org_1', name: 'Provider Co', domain: 'provider.example' } }] });
    if (u.includes('/organizations/enrich')) return json({ technologies: [{ name: 'PagerDuty' }, { name: 'Datadog' }] });
    if (u.includes('/people/find')) return json({ people: [{ name: 'Riley SRE', job_title: 'SRE Manager', linkedin_url: 'https://linkedin.com/in/riley' }] });
    if (u.includes('/user/')) return json({ fullName: 'Pat Provider', title: 'VP Engineering', activities_count: 7, last_active: '2026-06-01', common_room_member_url: 'https://commonroom.io/member/1' });
    if (u.includes('/sequences')) return json({ sequences: [{ id: 'seq_1', name: 'Reliability Workflow', status: 'active', created_by_user_email: 'seller@example.com' }] });
    if (u.includes('/contacts/email/')) return json({ name: 'Pat Provider', title: 'VP Engineering', email: 'pat@provider.example', last_contacted_at: '2026-06-03' });
    if (u.includes('generativelanguage.googleapis.com')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      company_overview: 'Provider Co has provider-backed GTM context.',
      why_care: 'Provider Co has verified activity and incident tooling evidence.',
      outbound_angle: 'Lead with incident coordination after alerts.',
      call_prep_notes: 'Ask Pat how alerts become coordinated incident work.',
    }) }] } }] });
    throw new Error(`unexpected URL ${u}`);
  };
  const brief = await generateProviderAccountBrief(a.id, {
    cfg: { sumble: { apiKey: 'sumble-key' }, commonRoom: { apiKey: 'common-key' }, amplemarketKey: 'ample-key', llm: { geminiKey: 'gemini-key', googleKey: '', model: 'gemini-2.0-flash' } },
    fetchFn: fakeFetch,
  });
  assert.equal(brief.generated_by, 'gemini+providers');
  assert.equal(brief.incident_stack, 'PagerDuty, Datadog');
  assert.ok(brief.company_overview.includes('provider-backed'));
  assert.ok(brief.recent_signals.some((s) => /Common Room activity/.test(s.label)));
  assert.ok(brief.recent_signals.some((s) => /Amplemarket sequence available/.test(s.label)));
  assert.ok(brief.relevant_people.some((p) => p.name === 'Riley SRE'));
  assert.ok(brief.relevant_people.some((p) => p.source === 'amplemarket'));
  assert.ok(brief.provider_status.every((s) => s.status === 'connected'));
});

test('provider account brief can use Gemini through Google ADC with no API key', async () => {
  const { generateProviderAccountBrief } = await import('../src/providers/accountBrief.js');
  resetForTests();
  const oldToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  process.env.GOOGLE_OAUTH_ACCESS_TOKEN = 'adc-token-for-test';
  const a = db.createAccount({ name: 'ADC Co', website: 'adc.example', rootly_customer: 'unknown', pagerduty_customer: 'unknown' });
  const fakeFetch = async (url, opts = {}) => {
    const u = String(url);
    assert.ok(u.includes('us-central1-aiplatform.googleapis.com'));
    assert.equal(opts.headers.authorization, 'Bearer adc-token-for-test');
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      company_overview: 'ADC Co was summarized through Google ADC.',
      why_care: 'ADC mode lets restricted Google orgs use Gemini without API keys.',
      outbound_angle: 'Use grounded research only.',
      call_prep_notes: 'Verify unknowns before calling.',
    }) }] } }] });
  };
  const brief = await generateProviderAccountBrief(a.id, {
    cfg: {
      sumble: { apiKey: '' },
      commonRoom: { apiKey: '' },
      amplemarketKey: '',
      llm: { geminiKey: '', googleKey: '', googleProject: 'rootly-test', googleLocation: 'us-central1', model: 'gemini-2.0-flash' },
    },
    fetchFn: fakeFetch,
  });
  assert.equal(brief.generated_by, 'gemini+providers');
  assert.ok(brief.company_overview.includes('Google ADC'));
  assert.equal(brief.provider_status.find((s) => s.provider === 'gemini').status, 'connected');
  if (oldToken === undefined) delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  else process.env.GOOGLE_OAUTH_ACCESS_TOKEN = oldToken;
});

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

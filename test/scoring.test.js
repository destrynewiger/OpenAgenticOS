import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAccount, bandFor } from '../src/scoring.js';
import { missingResearch } from '../src/service.js';

const base = (over = {}) => ({
  account: { rootly_customer: 'unknown', pagerduty_customer: 'unknown', do_not_contact: false, ...over },
  signals: [], contacts: [], quotes: [], tech: [],
});

test('PagerDuty detected adds +30 and shows in reasons', () => {
  const withPd = scoreAccount(base({ pagerduty_customer: 'yes', rootly_customer: 'no' }));
  const without = scoreAccount(base({ pagerduty_customer: 'unknown', rootly_customer: 'no' }));
  assert.equal(withPd.score - without.score, 30);
  assert.ok(withPd.reasons.some((r) => /PagerDuty detected \(\+30\)/.test(r)));
});

test('confirmed customer is excluded: -100 and blocked band', () => {
  const r = scoreAccount(base({ rootly_customer: 'yes', pagerduty_customer: 'yes' }));
  assert.ok(r.reasons.some((x) => /Already a customer \(-100\)/.test(x)));
  assert.equal(r.band, 'blocked');
});

test('legacy do-not-contact flag does not block prospecting', () => {
  const r = scoreAccount(base({ pagerduty_customer: 'yes', rootly_customer: 'no', do_not_contact: true }));
  assert.notEqual(r.band, 'blocked');
  assert.ok(!r.reasons.some((x) => /do-not-contact/i.test(x)));
});

test('not a customer adds +25', () => {
  const r = scoreAccount(base({ rootly_customer: 'no' }));
  assert.ok(r.reasons.some((x) => /Not a customer \(\+25\)/.test(x)));
});

test('unknown customer status is workable but lower than confirmed non-customer', () => {
  const unknown = scoreAccount(base({ rootly_customer: 'unknown' }));
  const confirmed = scoreAccount(base({ rootly_customer: 'no' }));
  assert.equal(confirmed.score - unknown.score, 15);
  assert.ok(unknown.reasons.some((x) => /Customer status unverified — verify before sequencing \(\+10\)/.test(x)));
});

test('a fully-signalled PagerDuty account lands in work_today (90+)', () => {
  const r = scoreAccount({
    account: { rootly_customer: 'no', pagerduty_customer: 'yes', status_page_url: 'https://status.x.com' },
    signals: [{ kind: 'outage' }, { kind: 'infra_scaling' }, { kind: 'new_to_role' }],
    tech: [{ tool: 'PagerDuty' }],
    quotes: [{ quote: 'x' }],
    contacts: [
      { persona_level: 'decision_maker', email: 'a@x.com' },
      { persona_level: 'manager', email: 'b@x.com' },
      { persona_level: 'end_user', phone: '555' },
    ],
  });
  assert.ok(r.score >= 90, `score was ${r.score}`);
  assert.equal(r.band, 'work_today');
});

test('no contact data applies -10', () => {
  const r = scoreAccount(base({ rootly_customer: 'no' }));
  assert.ok(r.reasons.some((x) => /No clear contact data \(-10\)/.test(x)));
});

test('grounded prior-work signals contribute without inventing stack facts', () => {
  const r = scoreAccount({
    account: { rootly_customer: 'unknown', pagerduty_customer: 'unknown' },
    signals: [
      { kind: 'historical_booked_meeting' },
      { kind: 'prior_thread_ready_task' },
      { kind: 'sf_warm_task' },
    ],
    contacts: [{ email: 'rep@example.com', persona_level: 'manager' }],
    quotes: [],
    tech: [],
  });
  assert.ok(r.reasons.some((x) => /Historical booked-meeting signal \(\+20\)/.test(x)));
  assert.ok(r.reasons.some((x) => /Prior thread has ready-to-work task \(\+15\)/.test(x)));
  assert.ok(r.reasons.some((x) => /Warm SF task from prior work \(\+15\)/.test(x)));
  assert.ok(!r.reasons.some((x) => /Incident stack detected/.test(x)));
});

test('product/platform tech does not count as incident stack evidence', () => {
  const r = scoreAccount({
    account: { rootly_customer: 'unknown', pagerduty_customer: 'unknown' },
    signals: [{ kind: 'ai_initiative' }],
    contacts: [{ email: 'rep@example.com', persona_level: 'manager' }],
    quotes: [],
    tech: [{ tool: 'AI platform', category: 'platform' }, { tool: 'Document automation', category: 'platform' }],
  });
  assert.ok(r.reasons.some((x) => /Recent infra \/ platform \/ AI/.test(x)));
  assert.ok(!r.reasons.some((x) => /Incident stack detected/.test(x)));
});

test('band thresholds map correctly', () => {
  assert.equal(bandFor(95), 'work_today');
  assert.equal(bandFor(75), 'sequence_week');
  assert.equal(bandFor(55), 'research_more');
  assert.equal(bandFor(10), 'low');
  assert.equal(bandFor(200, { rootlyCustomer: true }), 'blocked');
});

test('missing-data handling flags every unknown', () => {
  const gaps = missingResearch(base());
  assert.ok(gaps.includes('PagerDuty status unknown'));
  assert.ok(gaps.includes('Customer status unverified'));
  assert.ok(gaps.includes('No incident stack'));
  assert.ok(gaps.includes('No contacts mapped'));
});

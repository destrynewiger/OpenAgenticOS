import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCard } from '../src/callnotes.js';

const acct = (over = {}) => ({ name: 'Acme', pagerduty_customer: 'unknown', rootly_customer: 'unknown', incident_stack: '', ...over });

test('does NOT claim an outage when there is no outage signal', () => {
  const card = buildCard({ account: acct(), signals: [], quotes: [] }, { name: 'Jane', title: 'SRE', persona_level: 'end_user', persona_role: 'SRE' });
  assert.doesNotMatch(card.opening_line.toLowerCase(), /reliability event|recent outage/);
});

test('references a real signal in the opener when one exists', () => {
  const card = buildCard({ account: acct(), signals: [{ kind: 'outage', label: 'Status incident', detail: 'Checkout latency' }], quotes: [] },
    { name: 'Jane', title: 'SRE', persona_level: 'end_user' });
  assert.match(card.opening_line, /reliability event|Checkout latency/);
});

test('PagerDuty-known accounts get the displacement objection + angle', () => {
  const card = buildCard({ account: acct({ pagerduty_customer: 'yes' }), signals: [], quotes: [] }, { name: 'Jane', title: 'SRE Manager', persona_level: 'manager' });
  assert.equal(card.likely_objection, 'We already use PagerDuty.');
  assert.match(card.rootly_angle, /after the page|paging/i);
});

test('missing contact → why_person says needs research, not a fabrication', () => {
  const card = buildCard({ account: acct(), signals: [], quotes: [] }, null);
  assert.match(card.why_person, /needs research|no contact/i);
});

test('every card field is populated (usable live)', () => {
  const card = buildCard({ account: acct({ pagerduty_customer: 'yes' }), signals: [], quotes: [] }, { name: 'Jane', title: 'CTO', persona_level: 'department_head' });
  for (const k of ['why_person', 'likely_pain', 'opening_line', 'rootly_angle', 'good_question', 'likely_objection', 'best_response', 'next_step']) {
    assert.ok(card[k] && card[k].length > 0, `field ${k} empty`);
  }
  assert.equal(card.generated_by, 'template');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatusCandidates, detectProvider, parseStatusSnippet } from '../src/statuspage.js';

test('derives likely status URLs from a domain', () => {
  const c = deriveStatusCandidates('acme.com');
  assert.ok(c.includes('https://status.acme.com'));
  assert.ok(c.includes('https://acme.com/status'));
});

test('returns no candidates for empty / invalid domain', () => {
  assert.deepEqual(deriveStatusCandidates(''), []);
  assert.deepEqual(deriveStatusCandidates('notadomain'), []);
});

test('detects status-page providers', () => {
  assert.equal(detectProvider('powered by statuspage.io'), 'Atlassian Statuspage');
  assert.equal(detectProvider('<meta>status by incident.io</meta>'), 'incident.io');
  assert.equal(detectProvider('built on instatus.com'), 'Instatus');
  assert.equal(detectProvider('https://status.acme.com'), 'custom'); // a URL, unknown vendor
  assert.equal(detectProvider(''), 'unknown');
});

test('parses healthy status pages as no active incident', () => {
  const r = parseStatusSnippet('All Systems Operational');
  assert.equal(r.hasActiveIncident, false);
});

test('parses active incidents only when incident language is present', () => {
  const r = parseStatusSnippet('Investigating elevated error rates on the Checkout API');
  assert.equal(r.hasActiveIncident, true);
  assert.match(r.lastIncident, /Investigating/);
});

test('never invents an incident from empty text', () => {
  const r = parseStatusSnippet('');
  assert.equal(r.hasActiveIncident, false);
  assert.equal(r.lastIncident, '');
});

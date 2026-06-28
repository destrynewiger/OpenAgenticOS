import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsOriginFor, isPrivileged } from '../src/security.js';

test('privileged endpoints allow loopback clients', () => {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(isPrivileged(req, {}), true);
});

test('privileged endpoints deny remote clients without an ops token', () => {
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(isPrivileged(req, {}), false);
});

test('privileged endpoints allow a matching ops token', () => {
  const req = { headers: { 'x-ops-token': 'secret' }, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(isPrivileged(req, { OPS_TOKEN: 'secret' }), true);
});

test('cockpit CORS does not wildcard arbitrary web origins by default', () => {
  assert.equal(corsOriginFor('/api/cockpit/by-contact', 'https://evil.example', {}), null);
  assert.equal(corsOriginFor('/api/cockpit/by-contact', 'chrome-extension://abc', {}), 'chrome-extension://abc');
  assert.equal(corsOriginFor('/api/cockpit/by-contact', 'https://trusted.example', { COCKPIT_ALLOWED_ORIGINS: 'https://trusted.example' }), 'https://trusted.example');
  assert.equal(corsOriginFor('/api/cockpit/by-contact', 'https://evil.example', { COCKPIT_ALLOWED_ORIGINS: '*' }), '*');
});

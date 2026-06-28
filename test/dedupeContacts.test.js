import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetForTests, getDb } from '../src/db.js';
import * as db from '../src/models.js';

beforeEach(() => resetForTests());

test('among equally-descriptive titles the higher-confidence row survives and blanks merge in', () => {
  const a = db.createAccount({ name: 'Arteria AI', website: 'arteria.ai' });
  // Both real titles → confidence breaks the tie. Lower-conf row holds the email.
  const low = db.addContact(a.id, { name: 'Andy Macdonald', title: 'VP of Engineering', email: 'andy@arteria.ai', confidence: 90 });
  const high = db.addContact(a.id, { name: 'Andy Macdonald', title: 'Vice President, Engineering', phone: '+1 647-981-9379', confidence: 92 });

  const dry = db.dedupeContacts();
  assert.equal(dry.applied, false);
  assert.equal(dry.groups, 1);
  assert.equal(dry.contactsDeleted, 1);
  assert.equal(db.listContacts(a.id).length, 2, 'dry-run must not write');

  const r = db.dedupeContacts({ apply: true });
  assert.equal(r.applied, true);
  assert.equal(r.contactsDeleted, 1);

  const remaining = db.listContacts(a.id);
  assert.equal(remaining.length, 1);
  const kept = remaining[0];
  assert.equal(kept.id, high.id, 'survivor is the highest-confidence row');
  assert.equal(kept.phone, '+1 647-981-9379');
  assert.equal(kept.email, 'andy@arteria.ai', 'blank field backfilled from loser');
  assert.equal(db.getContact(low.id), null, 'loser deleted');
});

test('dedupe repoints call_queue/call_log to the survivor and the queue still resolves', () => {
  const a = db.createAccount({ name: 'Acme', website: 'acme.com' });
  const keep = db.addContact(a.id, { name: 'Jane Doe', title: 'VP Eng', confidence: 95 });
  const dupe = db.addContact(a.id, { name: 'Jane Doe', title: 'Buyer', confidence: 80 });

  // Queue + log point at the loser; repoint must keep them resolvable.
  db.replaceQueue([{ account_id: a.id, contact_id: dupe.id, why_now: 'test' }]);
  db.addCallLog(a.id, dupe.id, { outcome: 'voicemail' });

  const r = db.dedupeContacts({ apply: true });
  assert.equal(r.queueRepointed, 1);
  assert.equal(r.logRepointed, 1);

  const q = db.listQueue();
  assert.equal(q.length, 1);
  assert.equal(q[0].contact_id, keep.id);
  assert.equal(q[0].contact_name, 'Jane Doe', 'join resolves to the surviving contact');
  assert.equal(getDb().prepare('SELECT contact_id FROM call_log').get().contact_id, keep.id);
});

test('survivor is the row with a real title even when a generic-title row scores higher', () => {
  const a = db.createAccount({ name: 'Arteria AI', website: 'arteria.ai' });
  // Mirrors the real data: outreach-history row "Buyer" has higher confidence.
  const real = db.addContact(a.id, { name: 'Andy Macdonald', title: 'VP of Engineering', email: 'andy@arteria.ai', confidence: 90 });
  const generic = db.addContact(a.id, { name: 'Andy Macdonald', title: 'Buyer', phone: '+1 647-981-9379', confidence: 92 });

  const r = db.dedupeContacts({ apply: true });
  assert.equal(r.merges[0].keepTitle, 'VP of Engineering');
  const remaining = db.listContacts(a.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, real.id, 'descriptive-title row survives over higher-confidence generic one');
  assert.equal(remaining[0].title, 'VP of Engineering');
  assert.equal(remaining[0].phone, '+1 647-981-9379', 'phone backfilled from the generic row');
  assert.equal(db.getContact(generic.id), null);
});

test('dedupe is scoped per account and leaves singletons alone', () => {
  const a1 = db.createAccount({ name: 'A1', website: 'a1.com' });
  const a2 = db.createAccount({ name: 'A2', website: 'a2.com' });
  db.addContact(a1.id, { name: 'Sam Lee', confidence: 50 });
  db.addContact(a2.id, { name: 'Sam Lee', confidence: 50 }); // same name, different account — not a dup
  const r = db.dedupeContacts({ apply: true });
  assert.equal(r.groups, 0);
  assert.equal(db.listContacts(a1.id).length, 1);
  assert.equal(db.listContacts(a2.id).length, 1);
});

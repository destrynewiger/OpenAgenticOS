// Cockpit payload: everything a rep needs in front of them for ONE contact —
// the account brief, this person's call card, why-now, persona talk track, and
// their LinkedIn. Read by the Chrome-extension cockpit and the /cockpit page.
// Matching is keyed on phone first (the most stable signal from the dialer),
// then email / linkedin / name.
import * as db from './models.js';
import { bestWhyNow } from './service.js';
import { buildCard } from './callnotes.js';
import { rankContactsForCalling } from './personas.js';
import { talkTrackFor, keyMemory } from './knowledge/brain.js';

const HISTORY_RE = /closed.?lost|past customer|former customer|previous customer|historical_booked_meeting|booked.?meeting|warm_account|prior_thread|sf_warm/i;

export function matchContact({ phone, email, linkedin, name, account } = {}) {
  let c = null;
  let matchedBy = '';
  if (phone) { c = db.findContactByPhone(phone); if (c) matchedBy = 'phone'; }
  if (!c && email) { c = db.findContactByEmail(email); if (c) matchedBy = 'email'; }
  if (!c && linkedin) { c = db.findContactByLinkedin(linkedin); if (c) matchedBy = 'linkedin'; }
  if (!c && name) { c = db.findContactByName(name, account); if (c) matchedBy = 'name'; }
  return c ? { contact: c, matchedBy } : null;
}

export function cockpitForContactId(contactId) {
  const contact = db.getContact(Number(contactId));
  return contact ? buildCockpit(contact, 'id') : null;
}

// Outcome → queue status. Logging an outcome moves the queued row along so the
// queue/sheet reflect what actually happened on the call.
const QUEUE_STATUS = {
  connected: 'connected', meeting_booked: 'done', not_interested: 'done',
  bad_number: 'skipped', voicemail: 'dialed', no_answer: 'dialed',
  callback: 'dialed', other: 'dialed',
};

// Log a call outcome back to the account (and advance the queue row). Resolves
// the contact by id, then phone/email/linkedin/name.
export function logOutcome({ contactId, phone, email, linkedin, name, account, queueId, outcome, note = '' } = {}) {
  if (!outcome) return { error: 'outcome required' };
  let contact = contactId ? db.getContact(Number(contactId)) : null;
  if (!contact) contact = matchContact({ phone, email, linkedin, name, account })?.contact || null;
  if (!contact) return { error: 'no matching contact' };
  const queue = queueId ? db.getQueueItem(Number(queueId)) : db.getQueueByContact(contact.id);
  const log = db.addCallLog(contact.account_id, contact.id, { outcome, note, queue_id: queue?.id || null });
  const status = QUEUE_STATUS[outcome];
  const queueUpdated = (queue && status) ? db.setQueueStatus(queue.id, status, outcome) : null;
  db.audit({ account_id: contact.account_id, action: 'call_outcome', source: 'cockpit', result: `${outcome}${note ? ': ' + note.slice(0, 60) : ''}`, confidence: 100 });
  return { ok: true, log, queue: queueUpdated, contact: { id: contact.id, name: contact.name, account_id: contact.account_id } };
}

export function cockpitForQuery(query) {
  const hit = matchContact(query);
  return hit ? buildCockpit(hit.contact, hit.matchedBy) : null;
}

export function buildCockpit(contact, matchedBy = '') {
  const account = db.getAccount(contact.account_id);
  const bundle = db.getAccountBundle(contact.account_id);
  if (!account || !bundle) return null; // account vanished / data race — fail soft
  const brief = bundle.latestAccountBrief;
  // Prefer this contact's saved card, then an account-level card, then a
  // deterministic template so the cockpit is never blank.
  const card = (bundle.callNotes || []).find((n) => n.contact_id === contact.id)
    || (bundle.callNotes || []).find((n) => !n.contact_id)
    || buildCard(bundle, contact);

  // Top contacts at this account, ranked by fit — so the cockpit shows who else
  // to call without leaving the panel.
  const accountContacts = rankContactsForCalling(bundle.contacts || []).slice(0, 6).map((c) => ({
    id: c.id, name: c.name, title: c.title || c.persona_role || '',
    persona_level: c.persona_level, persona_role: c.persona_role,
    phone: c.phone, linkedin: c.linkedin, confidence: c.confidence,
    isCurrent: c.id === contact.id,
  }));

  // Memory: how this account has been worked — old notes, closed-lost /
  // past-customer state, and positioning guidance.
  // / warm history, plus the brain's positioning + proof line.
  const km = keyMemory();
  const history = (bundle.signals || [])
    .filter((s) => HISTORY_RE.test(`${s.kind} ${s.label} ${s.detail}`))
    .slice(0, 6)
    .map((s) => ({ label: s.label, detail: s.detail || '', source: s.source || '' }));

  return {
    matchedBy,
    contact: {
      id: contact.id, name: contact.name, title: contact.title, email: contact.email,
      phone: contact.phone, linkedin: contact.linkedin,
      persona_level: contact.persona_level, persona_role: contact.persona_role,
    },
    account: {
      id: account.id, name: account.name, domain: account.domain, website: account.website,
      incident_stack: account.incident_stack || '', score: account.score, band: account.band,
      pagerduty_customer: account.pagerduty_customer, rootly_customer: account.rootly_customer,
    },
    whyNow: bestWhyNow(bundle.signals, account),
    card: {
      why_person: card.why_person || '', likely_pain: card.likely_pain || '',
      opening_line: card.opening_line || '', rootly_angle: card.rootly_angle || '',
      good_question: card.good_question || '', likely_objection: card.likely_objection || '',
      best_response: card.best_response || '', next_step: card.next_step || '',
      generated_by: card.generated_by || 'template',
    },
    brief: brief ? {
      company_overview: brief.company_overview, why_care: brief.why_care,
      outbound_angle: brief.outbound_angle, call_prep_notes: brief.call_prep_notes,
      incident_stack: brief.incident_stack,
      recent_signals: (brief.recent_signals || []).slice(0, 6),
      relevant_people: (brief.relevant_people || []).slice(0, 6),
    } : null,
    talkTrack: talkTrackFor(contact, account),
    accountContacts,
    memory: {
      notes: account.notes || '',
      history,
      positioning: km.positioning,
      proof: km.proof,
    },
    recentOutcomes: (bundle.callLog || []).slice(0, 4).map((l) => ({
      outcome: l.outcome, note: l.note || '', contact: l.contact_name || '', at: l.created_at,
    })),
    linkedin: contact.linkedin || '',
  };
}

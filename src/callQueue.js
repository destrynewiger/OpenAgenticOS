// Dial-ready call queue: top-band accounts → their top callable contacts, in
// dial order. This is the single source of truth that both the Google Sheet
// (what an optional dialer uses) and the call cockpit read. Reuses the existing scoring
// (via listCards) and persona ranking. Never invents contacts; only queues
// people who have a phone, on accounts that are actually workable.
import * as db from './models.js';
import { listCards } from './service.js';
import { rankContactsForCalling } from './personas.js';

const TOP_BANDS = ['work_today', 'sequence_week'];
const SKIP_STATUS = new Set(['already_worked', 'blocked']);
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const hasPhone = (c) => !!String(c.phone || '').trim();

export function buildQueue({
  bands = TOP_BANDS,
  perAccount = num(process.env.QUEUE_CONTACTS_PER_ACCOUNT, 3),
  max = num(process.env.QUEUE_MAX, 100),
} = {}) {
  const cards = listCards({}); // already ordered by score DESC
  const rows = [];
  let rank = 0;
  for (const card of cards) {
    if (rows.length >= max) break;
    if (!bands.includes(card.band) || SKIP_STATUS.has(card.status)) continue;
    const account = db.getAccount(card.id);
    if (!account || account.do_not_contact) continue;
    const callable = rankContactsForCalling(db.listContacts(card.id)).filter(hasPhone);
    for (const c of callable.slice(0, perAccount)) {
      if (rows.length >= max) break;
      rows.push({ account_id: card.id, contact_id: c.id, rank: rank++, why_now: card.whyNow || '' });
    }
  }
  const out = db.replaceQueue(rows);
  const accounts = new Set(rows.map((r) => r.account_id)).size;
  db.audit({
    action: 'rebuild_call_queue', source: 'system',
    result: `${out.count} contacts queued from ${accounts} accounts`, confidence: 100,
  });
  return { queued: out.count, accounts };
}

// Shape a joined call_queue row into the cockpit/sheet/dashboard payload.
export function shapeQueueRow(r) {
  return {
    id: r.id,
    rank: r.rank,
    status: r.status,
    whyNow: r.why_now || '',
    outcome: r.outcome || '',
    lastDialedAt: r.last_dialed_at || '',
    account: {
      id: r.account_id, name: r.account_name, domain: r.account_domain,
      score: r.account_score, band: r.account_band, incident_stack: r.account_incident_stack || '',
    },
    contact: r.contact_id ? {
      id: r.contact_id, name: r.contact_name, title: r.contact_title, email: r.contact_email,
      phone: r.contact_phone, linkedin: r.contact_linkedin,
      persona_level: r.contact_persona_level, persona_role: r.contact_persona_role,
    } : null,
  };
}

export function getQueue(filter = {}) {
  return db.listQueue(filter).map(shapeQueueRow);
}

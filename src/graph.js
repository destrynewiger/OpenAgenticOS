// Memory-map graph: accounts ↔ the people we're calling ↔ shared hubs.
// Powers the Obsidian-style force-directed view. Two kinds of hub link accounts
// to each other and give the graph its interconnected "second brain" look:
//   - trigger hubs (why-now): PagerDuty, new leader, scaling, status page, …
//   - tech hubs: a tool used by 2+ accounts.
// Queued accounts/contacts are flagged so the people we're actively reaching out
// to stand out (white ring in the UI).
import * as db from './models.js';

const hubId = (kind, slug) => `${kind}_${slug.replace(/[^a-z0-9]+/g, '_')}`;

// Meaningful "why now" signal kinds → friendly hub labels. Other/noisy kinds
// (missing_data, apollo_presence, source_*) are intentionally excluded.
const TRIGGER_LABEL = {
  new_to_role: 'New leader',
  pagerduty_detected: 'PagerDuty',
  incident_stack: 'Incident stack',
  status_page: 'Status page',
  outage: 'Recent outage',
  eval: 'Evaluating tooling',
  infra_scaling: 'Scaling infra',
  ai_initiative: 'AI initiative',
  filing_quote: 'Public quote',
  warm_account: 'Warm',
  historical_booked_meeting: 'Past meeting',
};

export function buildGraph({ bands, limit = 120, includeTech = true } = {}) {
  let accounts = db.listAccounts().filter((a) => !a.do_not_contact && a.rootly_customer !== 'yes');
  if (bands && bands.length) accounts = accounts.filter((a) => bands.includes(a.band));
  accounts = accounts.slice(0, limit); // listAccounts() is sorted by score DESC

  const queue = db.listQueue();
  const queuedContacts = new Set(queue.map((q) => q.contact_id).filter(Boolean));
  const queuedAccounts = new Set(queue.map((q) => q.account_id));

  const nodes = [];
  const edges = [];
  const hubs = new Map(); // id -> { id, type, label, count }

  const addHub = (type, key, label) => {
    const id = hubId(type, key);
    if (!hubs.has(id)) hubs.set(id, { id, type, label, count: 0 });
    hubs.get(id).count++;
    return id;
  };

  for (const a of accounts) {
    nodes.push({
      id: `a${a.id}`, type: 'account', accountId: a.id, label: a.name,
      score: a.score, band: a.band, queued: queuedAccounts.has(a.id),
    });
    for (const c of db.listContacts(a.id)) {
      nodes.push({
        id: `c${c.id}`, type: 'contact', contactId: c.id, accountId: a.id,
        label: c.name || 'Unknown', title: c.title || c.persona_role || '',
        persona: c.persona_level || '', linkedin: c.linkedin || '',
        queued: queuedContacts.has(c.id),
      });
      edges.push({ source: `a${a.id}`, target: `c${c.id}`, kind: 'contact' });
    }

    // Trigger hubs (why-now). Dedupe per account so an account links each hub once.
    const triggers = new Set();
    if (a.pagerduty_customer === 'yes') triggers.add('pagerduty_detected');
    for (const s of db.listSignals(a.id)) if (TRIGGER_LABEL[s.kind]) triggers.add(s.kind);
    for (const kind of triggers) {
      edges.push({ source: `a${a.id}`, target: addHub('trigger', kind, TRIGGER_LABEL[kind]), kind: 'trigger' });
    }

    // Tech hubs.
    if (includeTech) {
      const tools = new Set(db.listTech(a.id).map((t) => String(t.tool || '').trim().toLowerCase()).filter(Boolean));
      for (const slug of tools) {
        const t = db.listTech(a.id).find((x) => String(x.tool || '').trim().toLowerCase() === slug);
        edges.push({ source: `a${a.id}`, target: addHub('tech', slug, t.tool), kind: 'tech' });
      }
    }
  }

  // Keep only hubs shared by 2+ accounts; drop singletons and their edges so the
  // graph clusters instead of sprouting dead-end leaves.
  const kept = new Set();
  for (const h of hubs.values()) {
    if (h.count >= 2) { nodes.push({ id: h.id, type: h.type, label: h.label, count: h.count }); kept.add(h.id); }
  }
  const finalEdges = edges.filter((e) => (e.kind !== 'tech' && e.kind !== 'trigger') || kept.has(e.target));

  return {
    nodes,
    edges: finalEdges,
    stats: {
      accounts: accounts.length,
      contacts: nodes.filter((n) => n.type === 'contact').length,
      hubs: kept.size,
      queued: queuedContacts.size,
    },
  };
}

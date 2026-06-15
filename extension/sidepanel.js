// OpenAgenticOS Call Cockpit — Chrome side panel. The cockpit itself: account brief,
// contacts ranked by fit, the current contact's call angle / trigger / objection
// notes, memory from your optional local brain folder (positioning, proof, old notes,
// closed-lost), one-click LinkedIn, and outcome logging back to the account.
// Gets the "who's dialing" phone from the content-script detector (via the
// background worker); manual search is the fallback.
const DEFAULTS = { apiBase: 'http://localhost:4100', autoOpenLinkedIn: false };
let cfg = { ...DEFAULTS };
let payload = null;
let lastKey = '';
let lastAutoOpenedId = null;

const $ = (id) => document.getElementById(id);
const view = $('view');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const digits = (s) => String(s || '').replace(/\D/g, '');

function setStatus(s) { $('status').textContent = s ? `· ${s}` : ''; }
let toastTimer;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}

function loadCfg() {
  return new Promise((resolve) => {
    try { chrome.storage.sync.get(DEFAULTS, (v) => { cfg = { ...DEFAULTS, ...v }; resolve(); }); }
    catch { resolve(); }
  });
}
try { chrome.storage.onChanged.addListener((c) => { for (const k in c) cfg[k] = c[k].newValue; }); } catch {}

function openLinkedIn(url) {
  if (!url) return;
  try { chrome.runtime.sendMessage({ type: 'open', url }); } catch { window.open(url, '_blank'); }
}

// ---------- fetch ----------
async function fetchKey(key, force) {
  if (!force && key === lastKey) return;
  lastKey = key;
  const [type, value] = key.split(/:(.+)/);
  const url = type === 'contact'
    ? `${cfg.apiBase}/api/cockpit/contact/${encodeURIComponent(value)}`
    : `${cfg.apiBase}/api/cockpit/by-contact?${type}=${encodeURIComponent(value)}`;
  setStatus('…');
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (res.status === 404) { setStatus('no match'); view.innerHTML = `<div class="muted pad">No contact matching <b>${esc(value)}</b> in the command center yet. Try the name, or rebuild the queue.</div>`; return; }
    if (!res.ok) throw new Error(res.status);
    payload = await res.json();
    setStatus(payload.matchedBy || 'ok');
    render(payload);
    if (cfg.autoOpenLinkedIn && payload.linkedin && payload.contact.id !== lastAutoOpenedId) {
      lastAutoOpenedId = payload.contact.id;
      openLinkedIn(payload.linkedin);
    }
  } catch (e) {
    setStatus('error');
    view.innerHTML = `<div class="pad err">Can't reach OpenAgenticOS at <b>${esc(cfg.apiBase)}</b>.<br><br>If this is a remote hub, use an HTTPS URL. Plain HTTP can be blocked on HTTPS pages. Set it in Options.</div>`;
  }
}
const byPhone = (p) => fetchKey(`phone:${digits(p)}`, false);
const byContact = (id) => fetchKey(`contact:${id}`, true);

// ---------- render ----------
function field(lab, val, cls = '') { return val ? `<div class="card ${cls}"><div class="lab">${esc(lab)}</div>${esc(val)}</div>` : ''; }

const OUTCOMES = [
  ['connected', 'Connected'], ['voicemail', 'Voicemail'], ['no_answer', 'No answer'],
  ['meeting_booked', 'Meeting booked'], ['not_interested', 'Not interested'],
  ['bad_number', 'Bad number'], ['callback', 'Callback'],
];

function render(d) {
  const c = d.contact || {}, a = d.account || {}, card = d.card || {}, t = d.talkTrack || {}, b = d.brief || {}, m = d.memory || {};
  const score = Math.max(0, Math.min(100, a.score || 0));
  const contactsHtml = (d.accountContacts || []).map((x) => `
    <div class="contact ${x.isCurrent ? 'current' : ''}" data-contact-id="${x.id}">
      <div class="c-main">
        <div class="c-name">${esc(x.name || 'Unknown')}${x.isCurrent ? ' • on call' : ''}</div>
        <div class="c-sub muted">${esc(x.title || x.persona_role || '')}${x.phone ? ' · ' + esc(x.phone) : ''}</div>
      </div>
      ${x.linkedin ? `<a class="mini-li" href="#" data-li="${esc(x.linkedin)}">LinkedIn ↗</a>` : ''}
    </div>`).join('');
  const signalsHtml = (b.recent_signals || []).map((s) => `<div class="card"><b>${esc(s.label || 'Signal')}</b>${s.detail ? ' — ' + esc(s.detail) : ''}${s.source ? `<div class="muted">${esc(s.source)}</div>` : ''}</div>`).join('');
  const peopleHtml = (b.relevant_people || []).map((p) => `<div class="contact"><div class="c-main"><div class="c-name">${esc(p.name || 'Unknown')}</div><div class="c-sub muted">${esc(p.title || '')}${p.source ? ' · ' + esc(p.source) : ''}${p.activity ? ' · ' + esc(p.activity) : ''}</div></div>${p.linkedin ? `<a class="mini-li" href="#" data-li="${esc(p.linkedin)}">LinkedIn ↗</a>` : ''}</div>`).join('');
  const histHtml = (m.history || []).map((h) => `<span class="chip hist" title="${esc(h.detail || '')}">${esc(h.label)}</span>`).join('');
  const recent = (d.recentOutcomes || []).map((o) => `<span class="chip">${esc((o.outcome || '').replace(/_/g, ' '))}${o.note ? ': ' + esc(o.note) : ''}</span>`).join('');

  view.innerHTML = `
    <div class="top">
      <div class="score">${score}</div>
      <div class="who">
        <div class="acct">${esc(a.name || 'Account')}</div>
        <div class="muted">${esc(c.name || '')} — ${esc(c.title || c.persona_role || '')}</div>
      </div>
      ${d.linkedin ? `<a class="li-btn" href="#" id="li-main" data-li="${esc(d.linkedin)}">LinkedIn ↗</a>` : ''}
    </div>
    ${d.whyNow ? `<div class="why"><b>Why now:</b> ${esc(d.whyNow)}</div>` : ''}
    ${field('Opening line', card.opening_line)}
    ${t.angle ? `<div class="card"><div class="lab">Talk track · ${esc(t.persona || '')}</div>${esc(t.angle)}${t.cta ? `<div class="muted" style="margin-top:5px">CTA: ${esc(t.cta)}</div>` : ''}</div>` : ''}
    ${field('Good question', card.good_question)}
    ${card.likely_objection ? `<div class="card obj"><div class="lab">If they say “${esc(card.likely_objection)}”</div>${esc(card.best_response)}</div>` : ''}
    ${field('Likely pain', card.likely_pain)}
    ${field('Seller angle', card.rootly_angle)}

    ${signalsHtml ? `<div class="sec-h">Recent signals</div>${signalsHtml}` : ''}

    <div class="sec-h">Contacts ranked by fit</div>
    ${contactsHtml || '<div class="muted">No other contacts mapped.</div>'}
    ${peopleHtml ? `<div class="sec-h">People (from research)</div>${peopleHtml}` : ''}

    <div class="sec-h">Memory</div>
    ${m.proof ? field('Proof', m.proof) : ''}
    ${m.positioning ? field('Positioning', m.positioning) : ''}
    ${histHtml ? `<div class="card"><div class="lab">History</div><div class="chips">${histHtml}</div></div>` : ''}
    ${m.notes ? field('Account notes', m.notes) : ''}
    ${b.why_care ? field('Why they might care', b.why_care) : ''}

    <div class="sec-h">Log outcome</div>
    <div class="outcomes">${OUTCOMES.map(([v, l]) => `<button data-outcome="${v}">${esc(l)}</button>`).join('')}</div>
    <textarea id="note" placeholder="optional note (saved to the account)…"></textarea>
    ${recent ? `<div class="sec-h">Recent</div><div class="chips">${recent}</div>` : ''}`;
}

// ---------- events (delegated) ----------
view.addEventListener('click', async (e) => {
  const li = e.target.closest('[data-li]');
  if (li) { e.preventDefault(); openLinkedIn(li.getAttribute('data-li')); return; }
  const contact = e.target.closest('[data-contact-id]');
  if (contact) { byContact(contact.getAttribute('data-contact-id')); return; }
  const outcomeBtn = e.target.closest('[data-outcome]');
  if (outcomeBtn) { logOutcome(outcomeBtn.getAttribute('data-outcome')); return; }
});

async function logOutcome(outcome) {
  if (!payload?.contact?.id) return toast('No contact loaded', true);
  const note = $('note')?.value?.trim() || '';
  try {
    const res = await fetch(`${cfg.apiBase}/api/cockpit/outcome`, {
      method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactId: payload.contact.id, outcome, note }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    toast(`Logged: ${outcome.replace(/_/g, ' ')}`);
    byContact(payload.contact.id); // refresh recent outcomes
  } catch (e) { toast(`Log failed: ${e.message}`, true); }
}

$('find').addEventListener('click', manualFind);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') manualFind(); });
$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
function manualFind() {
  const v = $('q').value.trim();
  if (!v) return;
  fetchKey(/[a-zA-Z]/.test(v) ? `name:${v}` : `phone:${digits(v)}`, true);
}

// Incoming "currently dialing" phone from the content-script detector.
try {
  chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'dialing' && msg.phone) byPhone(msg.phone); });
} catch {}

loadCfg().then(() => {
  // Catch up to whatever was last detected before the panel opened.
  try { chrome.runtime.sendMessage({ type: 'getLast' }, (resp) => { if (resp?.phone) byPhone(resp.phone); }); } catch {}
});

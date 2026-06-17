// OpenAgenticOS — vanilla SPA. Hash routing, fetch API, no build step.
const view = document.getElementById('view');
const fileInput = document.getElementById('fileInput');
let stopMap = null; // teardown for the Memory Map animation loop (set by renderMap)
let renderEpoch = 0;
const currentFullHash = () => location.hash || '#/';
let lastObservedHash = currentFullHash();

// ---------- helpers ----------
async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const attr = (s) => esc(String(s ?? ''));
const normalizedScore = (score) => Math.max(0, Math.min(100, Math.round(Number(score || 0))));
const scoreTone = (score) => normalizedScore(score) >= 80 ? 'green' : normalizedScore(score) >= 50 ? 'yellow' : 'red';
const pill = (score) => `<span class="score-pill ${scoreTone(score)}" title="Raw score: ${esc(score)}">${normalizedScore(score)}</span>`;
const badge = (label, color) => `<span class="badge ${color}">${esc(label)}</span>`;
const yn = (v) => v === 'yes' ? `<span class="pd-yes">Yes</span>` : v === 'no' ? 'No' : '<span class="muted">Unknown</span>';
const shortDate = (iso) => iso ? String(iso).slice(5, 16).replace('T', ' ') : '';
function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3500);
}
const LEVELS = [['department_head', 'Department head'], ['decision_maker', 'Decision maker'], ['manager', 'Manager'], ['end_user', 'End user']];
const autoResearchAttempts = new Map();
const relevantTech = ['Slack', 'Datadog', 'Grafana', 'New Relic', 'PagerDuty', 'OpsGenie', 'VictorOps', 'FireHydrant', 'AWS', 'GCP'];
const signalNoisePhrases = ['callable imported contact', 'top imported call-list', 'tier', 'has linkedin', 'active in apollo sequence', 'active in two apollo sequences'];

// ---------- router ----------
async function render() {
  const epoch = ++renderEpoch;
  lastObservedHash = currentFullHash();
  const hash = lastObservedHash.replace(/^#/, '') || '/';
  const isAgentOs = hash === '/agent-os' || hash.startsWith('/agent-os/');
  document.body.classList.toggle('agent-os-mode', isAgentOs);
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === hash || (isAgentOs && a.dataset.route === '/agent-os') || (hash.startsWith('/account/') && a.dataset.route === '/accounts')));
  if (stopMap) { stopMap(); stopMap = null; } // tear down the graph loop when leaving the map
  if (!isAgentOs && window.stopAgentOs) { window.stopAgentOs(); window.stopAgentOs = null; } // stop Agent OS live polling
  try {
    if (isAgentOs) return await renderAgentOs(hash.split('/')[2] || null, { epoch, hash });
    if (hash === '/') return await renderHome();
    if (hash === '/map') return await renderMap();
    if (hash === '/queue') return await renderQueue();
    if (hash === '/planned') return await renderPlannedOutreach();
    if (hash === '/accounts') return await renderAccounts();
    if (hash.startsWith('/account/')) return await renderAccount(hash.split('/')[2]);
    if (hash === '/contacts') return await renderContacts();
    if (hash === '/signals') return await renderSignals();
    if (hash === '/exports') return await renderExports();
    if (hash === '/closeout') return await renderCloseout();
    if (hash === '/settings') return await renderSettings();
    view.innerHTML = '<div class="empty">Not found</div>';
  } catch (e) { view.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);
setInterval(() => {
  const hash = currentFullHash();
  if (hash !== lastObservedHash) render();
}, 250);
document.addEventListener('click', (e) => {
  const button = e.target.closest?.('.copy-btn');
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  copyFromButton(button);
});
document.addEventListener('pointerdown', (e) => {
  const button = e.target.closest?.('.copy-btn');
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  copyFromButton(button);
});
document.addEventListener('mousedown', (e) => {
  const button = e.target.closest?.('.copy-btn');
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  copyFromButton(button);
});
document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-os-hide]') || e.target.closest?.('[data-os-show]')) return; // handled below
  const button = e.target.closest?.('.os-agent-row[data-agent-key], .os-agent-tile[data-agent-key]');
  if (!button) return;
  e.preventDefault();
  const key = button.dataset.agentKey;
  if (key) location.hash = '#/agent-os/' + key;
});
document.addEventListener('click', (e) => {
  const hide = e.target.closest?.('[data-os-hide]');
  if (hide) { e.preventDefault(); e.stopPropagation(); return window.osToggleHidden(hide.dataset.osHide); }
  const show = e.target.closest?.('[data-os-show]');
  if (show) { e.preventDefault(); e.stopPropagation(); return window.osToggleHidden(show.dataset.osShow); }
  const recheck = e.target.closest?.('[data-os-recheck]');
  if (recheck) {
    e.preventDefault();
    return selectAgentInternal(recheck.dataset.osRecheck, true);
  }
  const start = e.target.closest?.('[data-os-start]');
  if (start) {
    e.preventDefault();
    return agentOsStartInternal(start.dataset.osStart);
  }
  const clear = e.target.closest?.('[data-os-n2-clear]');
  if (clear) {
    e.preventDefault();
    return agentOsN2ClearInternal();
  }
  const stop = e.target.closest?.('[data-os-claude-stop]');
  if (stop) {
    e.preventDefault();
    return agentOsClaudeStop();
  }
  const ccNew = e.target.closest?.('[data-os-claude-new]');
  if (ccNew) {
    e.preventDefault();
    return agentOsClaudeNew();
  }
  const gemNew = e.target.closest?.('[data-os-gemini-new]');
  if (gemNew) {
    e.preventDefault();
    return agentOsGeminiNew();
  }
  const gemStop = e.target.closest?.('[data-os-gemini-stop]');
  if (gemStop) {
    e.preventDefault();
    return agentOsGeminiStop();
  }
  const sample = e.target.closest?.('[data-os-council-sample]');
  if (sample) {
    e.preventDefault();
    return agentOsCouncilSample(sample.dataset.osCouncilSample || '');
  }
});
document.addEventListener('submit', (e) => {
  if (e.target.matches?.('.os-claude-form')) return agentOsClaudeRunInternal(e);
  if (e.target.matches?.('.os-gemini-form')) return agentOsGeminiSendInternal(e);
  if (e.target.matches?.('.os-n2-form')) return agentOsN2SendInternal(e);
  if (e.target.matches?.('.os-council-form')) return agentOsCouncilInternal(e);
});
// Cmd/Ctrl+Enter submits an Agent OS prompt box from anywhere in the textarea.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
  const ta = e.target.closest?.('.os-claude-form, .os-gemini-form, .os-n2-form, .os-council-form');
  if (!ta) return;
  const form = e.target.closest('form');
  if (form) { e.preventDefault(); form.requestSubmit(); }
});

// ---------- HOME ----------
function tile(n, label, color = '') { return `<div class="tile ${color}"><b>${n}</b><span>${label}</span></div>`; }
function exportChips(c) {
  const x = c.exportStatus || {};
  const chip = (target) => x[target]?.exported
    ? `<span class="tag good">${target} CSV ready</span>`
    : `<span class="tag">${target}: not exported</span>`;
  return `<span class="pill-row">${chip('apollo')}${chip('amplemarket')}</span>`;
}
function cardHtml(c) {
  const persona = c.firstContact ? `${esc(c.firstContact.name)} <span class="muted">(${esc(c.firstContact.persona_role || c.firstContact.title || '')})</span>` : '<span class="muted">no contacts yet</span>';
  return `<div class="card ${c.color}" onclick="location.hash='#/account/${c.id}'">
    <div class="card-top">
      ${pill(c.score)}
      <span class="name">${esc(c.name)}</span>
      ${badge(c.bandLabel, c.color)}
      ${badge(c.status.replace(/_/g, ' '), 'gray')}
    </div>
    <div class="reason">${esc(c.reason)}</div>
    <div class="why-now">${esc(c.whyNow || 'Needs research')}</div>
    <div class="card-meta">
      <span>PagerDuty: ${yn(c.pagerduty_customer)}</span>
      <span>Customer: ${yn(c.rootly_customer)}</span>
      <span>Stack: <b>${esc(c.incident_stack || '—')}</b></span>
      <span>First contact: ${persona}</span>
      <span>Gaps: <b>${c.gapCount || 0}</b></span>
    </div>
    <div class="card-meta">${exportChips(c)}</div>
    <div class="next">▶ ${esc(c.next_action || 'Run research')}</div>
  </div>`;
}
function workQueueRow(c, i) {
  const who = c.firstContact ? `${esc(c.firstContact.name)}<br><span class="muted">${esc(c.firstContact.title || c.firstContact.persona_role || '')}</span>` : '<span class="muted">map contact</span>';
  const verify = c.needsVerification ? badge('verify', 'yellow') : badge('trusted enough', 'green');
  return `<tr class="clickable" onclick="location.hash='#/account/${c.id}'">
    <td>${i + 1}</td>
    <td>${pill(c.score)}</td>
    <td><b>${esc(c.name)}</b><br><span class="muted">${esc(c.domain || '')}</span></td>
    <td>${who}</td>
    <td>${esc(c.whyNow || 'Needs research')}</td>
    <td>${esc(c.next_action || '')}</td>
    <td>${verify}<br>${c.gapCount ? `<span class="muted">${c.gapCount} gaps</span>` : '<span class="muted">no gaps</span>'}</td>
    <td>${exportChips(c)}</td>
  </tr>`;
}
async function renderHome() {
  const d = await api('/home');
  const s = d.stats;
  const queue = d.priority.filter((c) => c.band === 'work_today' || c.status === 'ready_to_call' || c.status === 'ready_to_sequence').slice(0, 12);
  const sig = d.freshSignals.map((x) => `<div class="item"><span class="k">${esc(x.account_name)}</span> — ${esc(x.label)}</div>`).join('') || '<div class="item muted">No signals yet</div>';
  const miss = d.missing.map((x) => `<div class="item"><span class="k">${esc(x.account_name)}</span> — ${esc(x.label)}</div>`).join('') || '<div class="item muted">Nothing missing</div>';
  const acts = d.nextActions.map((t) => `<div class="item">${esc(t.account_name || '')}: ${esc(t.title)}</div>`).join('') || '<div class="item muted">No open tasks</div>';
  view.innerHTML = `
    <div class="tiles">
      ${tile(s.total, 'Target accounts')}
      ${tile(s.workToday, 'Work today', 'green')}
      ${tile(s.readyToSequence, 'Ready to sequence', 'yellow')}
      ${tile(s.needsResearch, 'Needs research', 'blue')}
      ${tile(s.blocked, 'Blocked', 'red')}
    </div>
    <div class="toolbar" style="margin-top:16px">
      <button class="btn primary" onclick="researchAll()">Run research (all)</button>
      <button class="btn" onclick="rescoreAll()">Recompute scores</button>
      <button class="btn" onclick="triggerImport('accounts')">↑ Import / add</button>
      <span class="spacer"></span>
      <a class="btn" href="#/accounts">All accounts →</a>
    </div>
    <h2>Daily work queue</h2>
    <table class="queue"><thead><tr><th>#</th><th>Score</th><th>Account</th><th>Person</th><th>Why now</th><th>Next action</th><th>Trust</th><th>Export</th></tr></thead>
      <tbody>${queue.map(workQueueRow).join('') || '<tr><td colspan="8" class="empty">No callable accounts yet. Run research or import contacts.</td></tr>'}</tbody></table>
    <div class="home-grid">
      <div>
        <h2>Today's priority accounts</h2>
        <div class="cards">${d.priority.map(cardHtml).join('') || '<div class="empty">No accounts yet. Import a CSV or click “Run research”.</div>'}</div>
      </div>
      <div class="rail">
        <div class="box"><h3>🔔 Fresh signals</h3>${sig}</div>
        <div class="box"><h3>🔎 Missing research</h3>${miss}</div>
        <div class="box"><h3>✅ Today's next actions</h3>${acts}</div>
      </div>
    </div>`;
}

// ---------- ACCOUNTS ----------
let acctFilter = {};
async function renderAccounts() {
  const qs = new URLSearchParams(Object.entries(acctFilter).filter(([, v]) => v)).toString();
  const cards = await api('/accounts' + (qs ? '?' + qs : ''));
  const rows = cards.map((c) => `<tr class="clickable" onclick="location.hash='#/account/${c.id}'">
    <td>${pill(c.score)}</td>
    <td><b>${esc(c.name)}</b><br><span class="muted">${esc(c.domain || '')}</span></td>
    <td>${badge(c.bandLabel, c.color)}</td>
    <td>${esc(c.status.replace(/_/g, ' '))}</td>
    <td>${yn(c.pagerduty_customer)}</td>
    <td>${yn(c.rootly_customer)}</td>
    <td>${esc(c.incident_stack || '—')}</td>
    <td>${c.firstContact ? esc(c.firstContact.name) + '<br><span class="muted">' + esc(c.firstContact.persona_role || '') + '</span>' : '<span class="muted">—</span>'}</td>
    <td class="muted">${esc(c.next_action || '')}<br>${exportChips(c)}</td>
  </tr>`).join('');
  view.innerHTML = `
    <div class="toolbar">
      <input class="search" id="q" placeholder="Search name / domain / stack" value="${esc(acctFilter.q || '')}" />
      <select id="f-band"><option value="">All bands</option>${opts(['work_today','sequence_week','research_more','low','blocked'], acctFilter.band)}</select>
      <select id="f-status"><option value="">All statuses</option>${opts(['research_needed','ready_to_sequence','ready_to_call','already_worked','blocked'], acctFilter.status)}</select>
      <select id="f-persona"><option value="">Any persona</option>${opts(['end_user','manager','decision_maker','department_head'], acctFilter.persona)}</select>
      <select id="f-signal"><option value="">Any signal</option>${opts(['pagerduty_detected','incident_stack','status_page','outage','new_to_role','infra_scaling','ai_initiative','filing_quote','eval','warm_account','source_work_today','source_priority','historical_booked_meeting','prior_thread_ready_task','sf_warm_task','call_ready','apollo_presence','apollo_job_change','amplemarket_presence','missing_data'], acctFilter.signalKind)}</select>
      <input class="search" id="f-tech" placeholder="Tech contains…" value="${esc(acctFilter.tech || '')}" style="width:140px" />
      <label class="btn"><input type="checkbox" id="f-pd" ${acctFilter.pagerduty ? 'checked' : ''}/> PagerDuty</label>
      <label class="btn"><input type="checkbox" id="f-sp" ${acctFilter.hasStatusPage ? 'checked' : ''}/> Status page</label>
      <button class="btn primary" onclick="applyFilters()">Filter</button>
      <button class="btn ghost" onclick="clearAcctFilter()">Clear</button>
      <span class="spacer"></span>
      <button class="btn" onclick="triggerImport('accounts')">↑ Import / add</button>
      <button class="btn primary" onclick="researchAll()">Research all</button>
    </div>
    <table><thead><tr><th>Score</th><th>Account</th><th>Priority</th><th>Status</th><th>PD</th><th>Customer</th><th>Incident stack</th><th>First contact</th><th>Next action / export</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="9" class="empty">No accounts. Import a CSV or add one.</td></tr>'}</tbody></table>`;
  const q = document.getElementById('q');
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
}
let plannedSort = 'jj';
async function renderPlannedOutreach() {
  const list = await api('/planned-outreach');
  const sorted = sortPlannedRows(list, plannedSort);
  const stats = plannedStats(list);
  const rows = sorted.map((x, i) => `<tr class="clickable ${x.priority ? 'p1-row' : ''}" onclick="location.hash='#/account/${x.id}'">
    <td><span class="rank-num">#${i + 1}</span></td>
    <td>${logoCell(x)}<div><b>${esc(x.account)}</b><br><span class="muted">${esc(x.domain || '')}</span></div></td>
    <td>${lanePill(x.jjLane)}${x.priority ? badge(x.priority, 'green') : ''}</td>
    <td>${esc(x.bucket || 'Unbucketed')}</td>
    <td>${x.targetKnown ? `<b>${esc(x.targetName)}</b>` : '<b class="muted">Needs target</b>'}<br><span class="muted">${esc(x.targetTitle || '')}</span></td>
    <td><div class="sheet-signal-list">${plannedSignalChips(x.signals)}</div></td>
    <td>${miniScoreRing(x.score)}</td>
    <td>${esc(x.nextAction || '')}</td>
  </tr>`).join('');
  view.innerHTML = `
    <section class="cockpit-hero">
      <div>
        <div class="part-label">PART 05 · JJ PRIORITIZATION COCKPIT</div>
        <h2>Score. <span>Rank.</span> Route.</h2>
        <p>JJ lens: work logos that make a splash, or accounts with source-backed recent funding. Everything else stays in thesis-build until research proves timing.</p>
      </div>
      <div class="radar-card">
        <div class="radar-orbit"><i></i><b>RAS</b></div>
        <div class="muted">Account Score</div>
      </div>
    </section>
    <section class="cockpit-metrics">
      ${metricTile(stats.total, 'accounts in cockpit', '+planned')}
      ${metricTile(stats.splash, 'splash logos', 'JJ lane')}
      ${metricTile(stats.funded, 'recently funded', 'source-backed only')}
      ${metricTile(stats.p1, 'priority 1', 'start here')}
    </section>
    <section class="jj-lanes">
      ${laneCard('Splash logos', stats.splash, 'Recognizable names that can make the 1:1 feel concrete. Still verify fit, contact, and timing before sequencing.', list.filter((x) => x.jjLane === 'Splash logo').slice(0, 6))}
      ${laneCard('Recently funded', stats.funded, 'Only accounts with funding language already present in signals. No funding claims are invented.', list.filter((x) => x.jjLane === 'Recently funded').slice(0, 6))}
    </section>
    <div class="sheet-head">
      <div>
        <div class="part-label">ACCOUNT QUEUE</div>
        <h2>One sheet for JJ.</h2>
        <p class="muted">Account, target, lane, source-backed triggers, score, and next action. Unknown people stay unknown until a provider or import maps them.</p>
      </div>
      <div class="toolbar cockpit-toolbar">
        <select id="planned-sort" onchange="setPlannedSort(this.value)">
          ${opts2(['jj','priority','signal','score','account','bucket','target'], plannedSort)}
        </select>
        <a class="btn" href="#/accounts">All accounts</a>
      </div>
    </div>
    <table class="queue outreach-sheet">
      <thead><tr><th>Rank</th><th>Account</th><th>JJ lens</th><th>Bucket</th><th>Target</th><th>Signals / triggers</th><th>RAS</th><th>Next action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="empty">No planned outreach accounts yet.</td></tr>'}</tbody>
    </table>`;
}
function sortPlannedRows(rows, sort) {
  const copy = [...rows];
  const priorityScore = (x) => x.priority === 'P1' ? 1 : 0;
  const cmpText = (a, b, key) => String(a[key] || '').localeCompare(String(b[key] || ''));
  if (sort === 'jj') return copy.sort((a, b) => b.jjLaneRank - a.jjLaneRank || priorityScore(b) - priorityScore(a) || b.score - a.score || b.signalSort - a.signalSort || cmpText(a, b, 'account'));
  if (sort === 'signal') return copy.sort((a, b) => b.signalSort - a.signalSort || priorityScore(b) - priorityScore(a) || cmpText(a, b, 'account'));
  if (sort === 'score') return copy.sort((a, b) => b.score - a.score || priorityScore(b) - priorityScore(a) || cmpText(a, b, 'account'));
  if (sort === 'account') return copy.sort((a, b) => cmpText(a, b, 'account'));
  if (sort === 'bucket') return copy.sort((a, b) => cmpText(a, b, 'bucket') || priorityScore(b) - priorityScore(a) || cmpText(a, b, 'account'));
  if (sort === 'target') return copy.sort((a, b) => Number(b.targetKnown) - Number(a.targetKnown) || cmpText(a, b, 'targetTitle') || cmpText(a, b, 'account'));
  return copy.sort((a, b) => priorityScore(b) - priorityScore(a) || b.signalSort - a.signalSort || b.score - a.score || cmpText(a, b, 'account'));
}
function plannedStats(list) {
  return {
    total: list.length,
    p1: list.filter((x) => x.priority === 'P1').length,
    splash: list.filter((x) => x.jjLane === 'Splash logo').length,
    funded: list.filter((x) => x.jjLane === 'Recently funded').length,
  };
}
function metricTile(value, label, detail) {
  return `<div class="cockpit-tile"><b>${esc(value)}</b><span>${esc(label)}</span><small>${esc(detail)}</small></div>`;
}
function laneCard(title, count, copy, rows) {
  return `<div class="lane-card">
    <div class="lane-card-head"><div><div class="part-label">${esc(title)}</div><h3>${esc(count)} accounts</h3></div>${lanePill(title)}</div>
    <p>${esc(copy)}</p>
    <div class="lane-mini-list">${rows.map((x) => `<a href="#/account/${x.id}">${esc(x.account)} <span>${esc(x.priority || 'planned')}</span></a>`).join('') || '<div class="muted">No source-backed rows yet.</div>'}</div>
  </div>`;
}
function logoCell(x) {
  return `<span class="logo-chip" title="${esc(x.jjLane || 'Account')}">${esc(companyInitials(x.account))}</span>`;
}
function lanePill(lane) {
  const cls = lane === 'Recently funded' ? 'funded' : lane === 'Splash logo' || lane === 'Splash logos' ? 'splash' : 'thesis';
  return `<span class="lane-pill ${cls}">${esc(lane)}</span>`;
}
function miniScoreRing(score) {
  const normalized = normalizedScore(score);
  return `<span class="mini-score-ring ${scoreTone(score)}" style="--score:${normalized}"><b>${normalized}</b></span>`;
}
function plannedSignalChips(signals) {
  return safeArray(signals).slice(0, 5).map((s) => {
    const label = s.label || shortSignalLabel(s) || s.kind;
    return chipHtml(label, signalTone(label, s), [s.detail, s.source].filter(Boolean).join(' · '));
  }).join('') || '<span class="muted">Needs research</span>';
}
window.setPlannedSort = (value) => {
  plannedSort = value || 'jj';
  renderPlannedOutreach();
};
function opts(list, sel) { return list.map((v) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${v.replace(/_/g, ' ')}</option>`).join(''); }
window.applyFilters = () => {
  acctFilter = {
    q: val('q'), band: val('f-band'), status: val('f-status'), persona: val('f-persona'),
    signalKind: val('f-signal'), tech: val('f-tech'),
    pagerduty: document.getElementById('f-pd').checked ? 'true' : '',
    hasStatusPage: document.getElementById('f-sp').checked ? 'true' : '',
  };
  // map to query keys server expects
  acctFilter = { q: acctFilter.q, band: acctFilter.band, status: acctFilter.status, persona: acctFilter.persona, signal: acctFilter.signalKind, tech: acctFilter.tech, pagerduty: acctFilter.pagerduty, status_page: acctFilter.hasStatusPage };
  render();
};
const val = (id) => document.getElementById(id).value.trim();

// ---------- ACCOUNT DETAIL ----------
async function renderAccount(id) {
  const d = await api('/accounts/' + id);
  const a = d.account;
  const sp = d.statusPage;
  const q = d.quotes[0];
  const focus = d.firstContact;
  const focusNote = d.firstCallNote;
  const researchBrief = d.latestResearchBrief;
  const accountBrief = d.latestAccountBrief;
  const researchNotice = accountResearchNotice(a.id, d.accountResearch);
  const callcards = d.callNotes.length ? d.callNotes.map((n) => callcardHtml(n, d.contacts, a.id)).join('')
    : '<div class="empty compact">No call card yet. Generate call notes when contacts are mapped.</div>';
  const signalList = safeArray(d.signals).filter((s) => s.kind !== 'missing_data');

  view.innerHTML = `
    <a class="back-link" href="#/accounts">Accounts</a>
    <div class="account-profile-layout">
      <aside class="profile-panel">
        <div class="profile-company">
          <div class="company-mark signal-pulse">${esc(companyInitials(a.name))}</div>
          <div>
            <h1>${esc(a.name)}</h1>
            ${a.website ? `<a class="domain-link" href="${a.website.startsWith('http')?'':'https://'}${esc(a.website)}" target="_blank">${esc(a.domain || a.website)}</a>` : ''}
          </div>
          ${profileStackChipsHtml(d, accountBrief, a)}
        </div>
        <div class="profile-tab">Overview</div>
        ${accountOverviewHtml(a, accountBrief, signalList, q)}
        ${performanceHtml(a, d.contacts, signalList)}
        ${accountDetailsHtml(a, d, accountBrief)}
      </aside>

      <section class="operator-workspace">
        <div class="operator-topbar">
          <div class="score-anchor score-ring ${scoreTone(a.score)}" style="--score:${normalizedScore(a.score)}">
            <div class="score-number">${normalizedScore(a.score)}</div>
            <div class="score-label">Priority</div>
          </div>
          <div class="operator-summary">
            <div class="operator-tags">
              ${badge(bandLabel(a.band), a.color || colorFor(a.band))}
              ${badge(a.status.replace(/_/g,' '), 'gray')}
              ${d.missing.length ? '' : chipHtml('Research current', 'good')}
            </div>
            <div class="next action-callout">${esc(a.next_action || 'Run research')}</div>
          </div>
          <div class="action-bar">
            <button class="btn primary" onclick="runResearch(${a.id})">Refresh research</button>
            <button class="btn" onclick="genProviderBrief(${a.id})">Provider brief</button>
            <button class="btn" onclick="genResearchBrief(${a.id}${focus ? ',' + focus.id : ''})">AI brief</button>
            <button class="btn" onclick="genCallNotes(${a.id})">Call notes</button>
            <button class="btn" onclick="approve(${a.id})">Approve</button>
            <select onchange="setStatus(${a.id}, this.value)">${opts2(['research_needed','ready_to_sequence','ready_to_call','already_worked','blocked'], a.status)}</select>
          </div>
        </div>
        ${researchNotice}
        ${signalEnginePanelHtml(a, signalList)}

        <div class="signal-board">
          ${techStackPanelHtml(d, accountBrief, a)}
          ${signalPanelHtml(signalList, accountBrief)}
        </div>

        <div class="workspace-grid">
          <div class="section call-focus"><h3>Live Call Panel</h3>
            ${liveCallPanel(focus, focusNote)}
          </div>
          <div class="section research-hud">
            <div class="section-head compact-head">
              <h3>Research Engine</h3>
              <button class="btn sm primary" onclick="genResearchBrief(${a.id}${focus ? ',' + focus.id : ''})">Refresh</button>
            </div>
            ${researchBriefHtml(researchBrief, focus, a)}
          </div>
        </div>

        <div class="section provider-brief">
          <div class="section-head">
            <div>
              <h3>Account Brief</h3>
              <div class="muted">Merged context from saved data and connected providers.</div>
            </div>
            <button class="btn sm" onclick="runResearch(${a.id})">Refresh</button>
          </div>
          ${renderSafe('Account brief', () => accountBriefHtml(accountBrief, a))}
        </div>

        <div class="section"><h3>Team Map <span class="muted">(${d.contacts.length})</span></h3>
          ${personaMapHtml(d.contacts)}
          <details class="add-contact"><summary>+ add contact</summary>
            <div><input id="c-name" placeholder="Name" /> <input id="c-title" placeholder="Title" />
            <input id="c-email" placeholder="Email" /> <input id="c-phone" placeholder="Phone" /> <input id="c-li" placeholder="LinkedIn" />
            <button class="btn sm primary" onclick="addContact(${a.id})">Add</button></div>
          </details>
        </div>

        <div class="context-grid">
          <div class="section"><h3>Recent Exec Hires</h3>${recentExecHiresHtml(signalList, d.contacts)}</div>
          <div class="section"><h3>Recent News</h3>${recentNewsHtml(signalList, q)}</div>
        </div>
        <div class="section journey-panel"><h3>72-hour prospect journey</h3>${journeyTimelineHtml(signalList, a)}</div>

        <div class="section"><h3>Call prep</h3>${callcards}</div>
        <div class="section"><h3>Call log <span class="muted">(${d.callLog ? d.callLog.length : 0})</span></h3>${callLogHtml(d.callLog)}</div>
        <div class="section"><h3>Sequence notes</h3>
          <textarea id="notes">${esc(a.notes || '')}</textarea>
          <button class="btn sm primary" style="margin-top:6px" onclick="saveNotes(${a.id})">Save notes</button>
        </div>
        <details class="section dev-panel"><summary>Developer</summary>${diagnosticsHtml(a)}</details>
  </section>
    </div>`;
  bindCopyButtons();
  maybeAutoRefreshAccountResearch(a.id, d.accountResearch);
}
function companyInitials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';
}
function cleanSentences(text) {
  return briefCopy(text, '').split(/(?<=[.!?])\s+/).filter(Boolean);
}
function accountOverviewHtml(account, brief, signals, quote) {
  const bullets = overviewBullets(account, brief, signals, quote);
  return `<section class="overview-copy">
    <div class="spark">+</div>
    <ul>${(bullets.length ? bullets : ['Run research to populate sourced call prep for this account.']).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
  </section>`;
}
function signalEnginePanelHtml(account, signals) {
  const weights = signalWeightRows(signals);
  const spark = sparklineHtml(account, signals);
  return `<div class="signal-engine-panel">
    <div class="engine-orb" aria-hidden="true"><span></span></div>
    <div class="engine-copy">
      <div class="eyebrow">Signal Engine</div>
      <h3>Operational intent scan</h3>
      <p>${esc(engineSummary(account, signals))}</p>
    </div>
    <div class="engine-spark">
      <div class="eyebrow">Signal velocity</div>
      ${spark}
    </div>
    <div class="signal-weights">
      <div class="eyebrow">Signal weights</div>
      ${weights}
    </div>
  </div>`;
}
function engineSummary(account, signals) {
  const labels = signalLabelsForSummary(signals);
  if (labels.length) return `${account.name} is showing ${labels.slice(0, 3).join(', ').toLowerCase()} signals. Prioritize the cleanest human touch and verify anything not source-backed before calling.`;
  return `${account.name} has no high-confidence intent signals yet. Keep the workflow research-first and avoid unverified stack claims.`;
}
function signalLabelsForSummary(signals) {
  const seen = new Set();
  return safeArray(signals)
    .filter(isActionableSignal)
    .map(shortSignalLabel)
    .filter((label) => label && !seen.has(label.toLowerCase()) && seen.add(label.toLowerCase()))
    .slice(0, 5);
}
function signalWeightRows(signals) {
  const buckets = [
    ['Intent', /funding|new project|ai|platform|hiring|new_to_role|recent hire/i],
    ['Relationship', /warm|meeting|invite|linkedin|past customer/i],
    ['Reliability', /pagerduty|incident|outage|status|reliability/i],
  ];
  return buckets.map(([label, re]) => {
    const count = safeArray(signals).filter((s) => re.test(`${s.kind} ${s.label} ${s.detail}`)).length;
    const value = Math.min(100, 28 + count * 18);
    return `<div class="weight-row"><span>${esc(label)}</span><div class="weight-track"><i style="width:${value}%"></i></div><b>${value}</b></div>`;
  }).join('');
}
function sparklineHtml(account, signals) {
  const base = normalizedScore(account.score);
  const count = Math.max(1, safeArray(signals).filter(isActionableSignal).length);
  const values = Array.from({ length: 12 }, (_, i) => Math.max(14, Math.min(100, Math.round(base * .45 + ((i + 2) * count * 3) % 58))));
  return `<div class="sparkline">${values.map((v) => `<span style="height:${v}%"></span>`).join('')}</div>`;
}
function journeyTimelineHtml(signals, account) {
  const rows = safeArray(signals)
    .filter(isActionableSignal)
    .map((s) => ({ raw: s, label: shortSignalLabel(s) }))
    .filter((x) => x.label)
    .sort((a, b) => String(b.raw.detected_at || '').localeCompare(String(a.raw.detected_at || '')))
    .slice(0, 4);
  if (!rows.length) return '<div class="empty compact">No recent source-backed journey yet.</div>';
  const timeLabels = ['Now', '24h', '48h', '72h'];
  return `<div class="journey-timeline">${rows.map((x, i) => {
    const source = [x.raw.source, shortDate(x.raw.detected_at)].filter(Boolean).join(' · ');
    const detail = safeText(x.raw.detail || x.raw.label || `${account.name} signal`, '').slice(0, 140);
    return `<div class="journey-step">
      <div class="journey-dot"></div>
      <div class="journey-time">${esc(timeLabels[i] || shortDate(x.raw.detected_at) || 'Signal')}</div>
      <div class="journey-card">
        <b>${esc(x.label)}</b>
        ${detail ? `<span>${esc(detail)}</span>` : ''}
        ${source ? `<small>${esc(source)}</small>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}
function overviewBullets(account, brief, signals, quote) {
  const signalParagraphs = prioritySignalParagraphs(account, signals);
  const paragraphs = [
    ...signalParagraphs,
    ...cleanSentences(brief?.why_care || ''),
    ...cleanSentences(brief?.company_overview || ''),
    quote?.interpretation || quote?.quote || '',
    account.notes || '',
  ]
    .map((s) => String(s || '').trim())
    .map(displayCleanCopy)
    .filter((s) => s && !/(unknown|unverified|needs research|needs verification|no public|not found)/i.test(s));
  const unique = [];
  const seen = new Set();
  for (const p of paragraphs) {
    const key = p.toLowerCase().slice(0, 90);
    if (!seen.has(key)) { seen.add(key); unique.push(p); }
    if (unique.length >= 3) break;
  }
  const fallback = safeArray(signals).filter((s) => s.kind !== 'missing_data').slice(0, 3)
    .map((s) => [s.label, s.detail].filter(Boolean).join('. '));
  return (unique.length ? unique : fallback).map(shortCallSnippet).filter(Boolean).slice(0, 6);
}
function shortCallSnippet(text) {
  return displayCleanCopy(text)
    .replace(/^Imported why now:\s*/i, '')
    .replace(/\s*\|\s*/g, ' · ')
    .split(/(?<=[.!?])\s+/)[0]
    .trim()
    .slice(0, 150);
}
function prioritySignalParagraphs(account, signals) {
  const rows = safeArray(signals).filter((s) => s.kind !== 'missing_data');
  const byKind = (pattern) => rows.find((s) => pattern.test(`${s.kind} ${s.label} ${s.detail}`));
  const funding = byKind(/funding|series|raised|investment/i);
  const ai = byKind(/ai_initiative|ai documentation|platform|automation/i);
  const financial = byKind(/financial_services|financial institution/i);
  const warm = byKind(/warm_account|recent rootly event touch|meeting|invite/i);
  return [
    [funding?.label, funding?.detail].filter(Boolean).join(': '),
    [ai?.label, ai?.detail].filter(Boolean).join(': '),
    [financial?.label, financial?.detail].filter(Boolean).join(': '),
    warm ? `${account.name} has a recent warm touch: ${warm.detail || warm.label}` : '',
  ].filter(Boolean);
}
function displayCleanCopy(text) {
  return String(text || '')
    .replace(/\bSource needs periodic refresh\.?/gi, '')
    .replace(/\bThis is product\/platform context, not incident-stack evidence\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function performanceHtml(account, contacts, signals) {
  const channels = safeArray(contacts).reduce((acc, c) => {
    if (c.email) acc.email += 1;
    if (c.phone) acc.phone += 1;
    if (c.linkedin) acc.linkedin += 1;
    return acc;
  }, { email: 0, phone: 0, linkedin: 0 });
  const signalSummary = topSignalPills(signals);
  const channelChips = [
    channels.email ? `<b class="mini-pill blue">${channels.email} email</b>` : '',
    channels.linkedin ? `<b class="mini-pill teal">${channels.linkedin} LI</b>` : '',
    channels.phone ? `<b class="mini-pill orange">${channels.phone} call</b>` : '',
  ].join('') || '<span class="muted">No contact channels yet</span>';
  return `<section class="profile-section">
    <button class="collapse-row">Activity</button>
    <div class="metric-card">
      <div class="metric-row"><span>Channels</span><div class="activity-pills">${channelChips}</div></div>
      <div class="metric-row"><span>Signals</span><div class="activity-pills">${signalSummary || '<span class="muted">No intent signals yet</span>'}</div></div>
      <div class="metric-row"><span>Last touch</span><strong>${lastInteractionText(signals)}</strong></div>
    </div>
  </section>`;
}
function volumeBars(account) {
  return Array.from({ length: 14 }, (_, i) => `<span class="${i < Math.ceil(normalizedScore(account.score) / 8) ? scoreTone(account.score) : ''}"></span>`).join('');
}
function diagnosticsHtml(account) {
  return `<div class="muted">Diagnostics hidden from operator view.</div>
    <div class="metric-card diagnostics-card">
      <div class="metric-row"><span>Volume</span><div class="volume-bars">${volumeBars(account)}</div></div>
      <div class="metric-row"><span>Raw score</span><strong>${esc(account.score || 0)}</strong></div>
    </div>`;
}
function lastInteractionText(signals) {
  const dated = safeArray(signals).filter((s) => s.detected_at).sort((a, b) => String(b.detected_at).localeCompare(String(a.detected_at)))[0];
  return dated ? shortDate(dated.detected_at) : 'No activity yet';
}
function topSignalPills(signals, limit = 5) {
  const actionableRows = safeArray(signals).filter(isActionableSignal);
  const seen = new Set();
  const ranked = actionableRows
    .map((s) => ({ raw: s, label: shortSignalLabel(s), rank: signalRank(s) }))
    .filter((x) => x.label && !seen.has(x.label.toLowerCase()) && seen.add(x.label.toLowerCase()))
    .sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));
  const top = ranked.slice(0, limit);
  const rest = Math.max(0, actionableRows.length - top.length);
  return [
    ...top.map((x) => `<b class="mini-pill ${miniSignalTone(x.label, x.raw)}" title="${esc([x.raw.source, x.raw.label, x.raw.detail].filter(Boolean).join(' · '))}">${esc(x.label)}</b>`),
    rest ? `<b class="mini-pill more" title="${esc(`${rest} more lower-priority signals`)}">+${rest}</b>` : '',
  ].join('');
}
function signalRank(s) {
  const label = shortSignalLabel(s);
  const text = `${s.kind || ''} ${s.label || ''} ${s.detail || ''} ${s.source || ''}`.toLowerCase();
  let score = 0;
  if (/sumble|amplemarket/.test(text)) score += 40;
  if (/new_to_role|new hire|recent hire|joined|appointed|promoted/.test(text)) score += 35;
  if (/hiring sre|site reliability|sre role|hiring/.test(text)) score += 34;
  if (/series|funding|raised|investment/.test(text)) score += 32;
  if (/closed lost|past customer|former customer|previous customer/.test(text)) score += 31;
  if (/ai|ml|platform|infra|migration|project|launch/.test(text)) score += 28;
  if (/linkedin\s+(post|activity)|posted on linkedin/.test(text)) score += 24;
  if (/warm|meeting|invite/.test(text)) score += 18;
  if (/pagerduty|incident|outage|status/.test(text)) score += 12;
  if (!label) score -= 100;
  return score;
}
function miniSignalTone(label, s = {}) {
  const text = `${label} ${s.kind || ''}`.toLowerCase();
  if (/hire|funding|customer|linkedin/.test(text)) return 'green';
  if (/closed|pagerduty|incident|outage|reliability/.test(text)) return 'red';
  if (/project|ai|infra|platform/.test(text)) return 'cyan';
  if (/warm|meeting/.test(text)) return 'purple';
  return 'gray';
}
function detailFromNotes(notes, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(notes || '').match(new RegExp(`${escaped}:\\s*([^|]+)`, 'i'))?.[1]?.trim() || '';
}
function accountDetailsHtml(account, d, brief) {
  const notes = account.notes || '';
  const rows = [
    ['Industry', detailFromNotes(notes, 'Industry') || (hasSignalKind(d.signals, 'financial_services') ? 'Financial services technology' : '')],
    ['Size', detailFromNotes(notes, 'Company size')],
    ['Route', detailFromNotes(notes, 'Route')],
    ['Source', detailFromNotes(notes, 'Source')],
    ['Website', account.domain ? `<a href="${account.website?.startsWith('http') ? account.website : 'https://' + (account.website || account.domain)}" target="_blank">${esc(account.domain)}</a>` : ''],
  ].filter(([, value]) => value);
  const sources = safeArray(brief?.sources).slice(0, 3).map((s) => `<span class="detail-chip">${esc(providerLabel(s.provider))}: ${esc(s.label || 'source')}</span>`).join('');
  return `<section class="profile-section">
    <button class="collapse-row">Details</button>
    <div class="detail-list">
      ${rows.map(([label, value]) => `<div class="detail-row"><span>${esc(label)}</span><strong>${String(value).includes('<a ') ? value : esc(value)}</strong></div>`).join('')}
      ${sources ? `<div class="detail-row source-detail"><span>Sources</span><strong>${sources}</strong></div>` : ''}
    </div>
  </section>`;
}
function hasSignalKind(signals, kind) {
  return safeArray(signals).some((s) => s.kind === kind);
}
function safeArray(v) { return Array.isArray(v) ? v : []; }
function safeText(v, fallback = 'unknown') {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s || fallback;
}
function renderSafe(label, fn) {
  try { return fn(); }
  catch (e) {
    return `<div class="research-empty error-state"><b>${esc(label)} unavailable</b><div class="muted">${esc(e.message || 'Malformed provider data. Refresh research or check provider status.')}</div></div>`;
  }
}
function chipHtml(label, tone = 'neutral', detail = '') {
  return `<span class="chip ${esc(tone)}" title="${esc(detail || label)}">${esc(label)}</span>`;
}
function statusChip(label, value, accountId, field) {
  if (!value || value === 'unknown') return '';
  const tone = value === 'yes' ? 'good' : value === 'no' ? 'neutral' : 'warn';
  return `<span class="chip ${tone}">${esc(label)}: ${esc(value || 'unknown')} ${selCustomer(accountId, field, value)}</span>`;
}
function splitStackText(text) {
  return String(text || '')
    .split(/[,;|/]+|\s(?:and|\+)\s/gi)
    .map((s) => s.trim())
    .filter((s) => s && !/^(unknown|needs research|needs verification|unverified|none|n\/a|-|—)$/i.test(s));
}
function techTone(tool, category = '') {
  const t = `${tool} ${category}`.toLowerCase();
  if (/pagerduty|incident|rootly|opsgenie|statuspage/.test(t)) return 'incident';
  if (/datadog|grafana|new relic|dynatrace|observability|monitor/.test(t)) return 'observe';
  if (/slack|teams|chat/.test(t)) return 'chat';
  if (/aws|gcp|azure|kubernetes|k8s|cloud/.test(t)) return 'cloud';
  return 'neutral';
}
function isRelevantTech(row) {
  const text = `${row.label || ''} ${row.category || ''}`.toLowerCase();
  return relevantTech.some((tool) => {
    const t = tool.toLowerCase();
    if (t === 'aws') return /\baws\b|amazon web services/.test(text);
    if (t === 'gcp') return /\bgcp\b|google cloud/.test(text);
    if (t === 'new relic') return /new\s*relic/.test(text);
    if (t === 'opsgenie') return /ops\s*genie|opsgenie/.test(text);
    return text.includes(t);
  });
}
function techChips(d, brief, account) {
  const providerStack = String(brief?.incident_stack || '');
  const providerStackConfirmed = providerStack && !/(unknown|needs research|needs verification|unverified|verify|may care|if incident|manual today)/i.test(providerStack);
  const rows = [
    ...safeArray(d.tech).map((t) => ({ label: t.tool, category: t.category, source: t.source, confidence: Number(t.confidence || 0) })),
    ...splitStackText(account.incident_stack).map((tool) => ({ label: tool, category: 'incident', source: 'account' })),
    ...(providerStackConfirmed ? splitStackText(providerStack).map((tool) => ({ label: tool, category: 'provider', source: 'account brief' })) : []),
  ];
  const seen = new Set();
  const sorted = rows
    .map((r) => ({ ...r, label: safeText(r.label, '') }))
    .filter((r) => !/(target|fallback|fixture|missing|unknown|needs research|needs verification|unverified)/i.test(`${r.label} ${r.category} ${r.source}`))
    .filter((r) => !r.confidence || r.confidence >= 70)
    .filter(isRelevantTech)
    .filter((r) => r.label && !seen.has(r.label.toLowerCase()) && seen.add(r.label.toLowerCase()))
    .sort((a, b) => techTone(a.label, a.category).localeCompare(techTone(b.label, b.category)) || a.label.localeCompare(b.label));
  return sorted.map((r) => chipHtml(r.label, `tech-${techTone(r.label, r.category)}`, `${r.category || 'tech'}${r.source ? ' · ' + r.source : ''}`)).join('');
}
function techStackPanelHtml(d, brief, account) {
  const verified = techChips(d, brief, account);
  if (!verified) return '';
  return `<div class="signal-card tech-card">
    <div class="eyebrow">Tech Stack</div>
    <div class="chip-cluster sortable">${verified}</div>
  </div>`;
}
function profileStackChipsHtml(d, brief, account) {
  const verified = techChips(d, brief, account);
  if (!verified) return '';
  return `<div class="profile-stack-inline">
    <div class="eyebrow">Tech Stack</div>
    <div class="chip-cluster">${verified}</div>
  </div>`;
}
function isActionableSignal(s) {
  const text = `${s.kind || ''} ${s.label || ''} ${s.detail || ''}`.toLowerCase();
  return !signalNoisePhrases.some((phrase) => text.includes(phrase));
}
function shortSignalLabel(s) {
  const kind = String(s.kind || '').toLowerCase();
  const text = `${s.label || ''} ${s.detail || ''}`.toLowerCase();
  if (/closed lost|closed-lost|lost opp|lost opportunity/.test(`${kind} ${text}`)) return 'Closed Lost';
  if (/past customer|former customer|previous customer/.test(`${kind} ${text}`)) return 'Past Customer';
  if (/linkedin\s+(post|activity)|posted on linkedin|linkedin post/.test(`${kind} ${text}`)) return 'LinkedIn Post';
  if (/historical_booked_meeting|booked[-\s]?meeting|past meeting/.test(`${kind} ${text}`)) return 'Past Meeting';
  if (/hiring sre|sre role|site reliability.*hiring|hiring.*site reliability/.test(`${kind} ${text}`)) return 'Hiring SRE';
  if (/warm|meeting|invite|sales accepted|rootly event/.test(`${kind} ${text}`)) return 'Warm Touch';
  if (/new_to_role|new hire|recent hire|joined|appointed|promoted/.test(`${kind} ${text}`)) return 'Recent Hire';
  if (/series|funding|raised|investment/.test(text)) return 'Recent Funding';
  if (/active|sequence|last contacted|apollo|amplemarket/.test(`${kind} ${text}`)) return '';
  if (/ai|ml|platform|infra|migration|project|launch/.test(`${kind} ${text}`)) return 'New Project';
  if (/outage|incident|status/.test(`${kind} ${text}`)) return 'Reliability Signal';
  if (/pagerduty/.test(`${kind} ${text}`)) return 'PagerDuty Signal';
  return safeText(s.label || s.kind, 'Signal').slice(0, 38);
}
function signalTone(label, s = {}) {
  const text = `${label} ${s.kind || ''}`.toLowerCase();
  if (/hire|funding|warm|customer|linkedin/.test(text)) return 'good';
  if (/closed|pagerduty|reliability|incident|outage/.test(text)) return 'incident';
  if (/project|ai|infra|platform/.test(text)) return 'cloud';
  return 'neutral';
}
function signalChips(signals, brief) {
  const rows = [
    ...safeArray(signals),
    ...safeArray(brief?.recent_signals).map((s) => ({ ...s, kind: s.kind || 'provider_signal' })),
  ].filter(isActionableSignal);
  const seen = new Set();
  const chips = rows
    .map((s) => ({ raw: s, label: shortSignalLabel(s) }))
    .filter((x) => x.label && !seen.has(x.label.toLowerCase()) && seen.add(x.label.toLowerCase()))
    .sort((a, b) => a.label.localeCompare(b.label));
  return chips.map((x) => chipHtml(x.label, signalTone(x.label, x.raw), `${x.raw.label || ''}${x.raw.detail ? ' · ' + x.raw.detail : ''}`)).join('') || chipHtml('No signals yet', 'warn');
}
function signalPanelHtml(signals, brief) {
  return `<div class="signal-card">
    <div class="eyebrow">Signals</div>
    <div class="chip-cluster sortable">${signalChips(signals, brief)}</div>
  </div>`;
}
function liveCallPanel(focus, note) {
  return `<div class="call-focus-grid compact">
    <div>
      <div class="lab">Call first</div>
      ${focus ? `<b>${esc(focus.name)}</b><div class="muted">${esc(focus.title || focus.persona_role || '')}</div>
        <div class="meta">${[focus.phone, focus.email, focus.linkedin ? `<a href="${esc(focus.linkedin)}" target="_blank">LinkedIn</a>` : ''].filter(Boolean).join(' · ') || '<span class="muted">No phone/email yet</span>'}</div>`
        : '<span class="muted">No contact mapped yet</span>'}
    </div>
    <div><div class="lab">Opening line</div>${note ? esc(note.opening_line) : '<span class="muted">Generate call notes after mapping contacts.</span>'}</div>
    <div><div class="lab">Question</div>${note ? esc(note.good_question) : '<span class="muted">Needs call note.</span>'}</div>
    <div><div class="lab">Handle</div>${note ? `<b>${esc(note.likely_objection)}</b><br>${esc(note.best_response)}` : '<span class="muted">Needs call note.</span>'}</div>
  </div>`;
}
function personaBucket(c) {
  const lvl = String(c.persona_level || '').toLowerCase();
  const title = String(c.title || '').toLowerCase();
  if (lvl === 'department_head' || lvl === 'decision_maker' || /\b(cio|cto|vp|chief|head of|director)\b/.test(title)) return 'buyer';
  if (lvl === 'manager' || /manager|lead|principal|staff/.test(title)) return 'champion';
  return 'end_user';
}
function personaMapHtml(contacts) {
  const buckets = [
    ['buyer', 'Buyer / Department Head'],
    ['champion', 'Champion'],
    ['end_user', 'End User'],
  ];
  return `<div class="persona-grid">${buckets.map(([key, label]) => {
    const list = safeArray(contacts).filter((c) => personaBucket(c) === key);
    return `<div class="persona-column ${key}">
      <div class="persona-title">${esc(label)} <span>${list.length}</span></div>
      ${list.map(contactHtml).join('') || '<div class="empty compact">No contacts yet</div>'}
    </div>`;
  }).join('')}</div>`;
}
function recentExecHiresHtml(signals, contacts) {
  const execSignals = safeArray(signals).filter((s) => /new_to_role|hire|joined|appointed|promoted|exec/i.test(`${s.kind} ${s.label} ${s.detail}`));
  const execContacts = safeArray(contacts).filter((c) => personaBucket(c) === 'buyer' && /new|joined|hired/i.test(`${c.source} ${c.title}`));
  const rows = [
    ...execSignals.map((s) => ({ label: s.label, detail: s.detail || s.source || '' })),
    ...execContacts.map((c) => ({ label: c.name, detail: c.title || '' })),
  ].slice(0, 5);
  return rows.map((r) => `<div class="context-item"><b>${esc(r.label)}</b><span>${esc(r.detail)}</span></div>`).join('') || '<div class="empty compact">No recent exec hire signal yet</div>';
}
function recentNewsHtml(signals, quote) {
  const newsKinds = /filing_quote|infra_scaling|ai_initiative|eval|outage|status_page|source_priority|source_work_today|funding|news/i;
  const rows = safeArray(signals).filter((s) => newsKinds.test(`${s.kind} ${s.label} ${s.detail}`)).slice(0, 5)
    .map((s) => ({ label: s.label, detail: s.detail || s.source || '', url: s.url || '' }));
  if (quote) rows.unshift({ label: quote.source_name || 'Research quote', detail: quote.quote || quote.interpretation || '', url: quote.url || '' });
  return rows.slice(0, 5).map((r) => `<div class="context-item"><b>${esc(r.label)}</b>${r.url ? ` <a href="${esc(r.url)}" target="_blank">↗</a>` : ''}<span>${esc(r.detail)}</span></div>`).join('') || '<div class="empty compact">No recent news signal yet</div>';
}
function auditHtml(audit) {
  return safeArray(audit).map((x) => `<div>${esc(String(x.created_at || '').slice(5,16))} · <b>${esc(x.action)}</b> [${esc(x.source)}] ${esc(x.result || x.error || '')}</div>`).join('') || '<div class="muted">No audit entries</div>';
}
function accountResearchNotice(accountId, status) {
  if (!status?.needsResearch) return '';
  const key = (status.reasons || []).join('|') || 'needs-research';
  const reasons = (status.reasons || []).join(', ') || 'missing/stale/placeholder';
  const actionText = autoResearchAttempts.get(accountId) === key
    ? 'Auto-refresh was already attempted once; use <b>Refresh research</b> to retry.'
    : 'Auto-refresh is queued; use <b>Refresh research</b> to run it manually.';
  return `<div class="research-refresh-note">
    Account research is ${esc(reasons)}. ${actionText}
  </div>`;
}
function maybeAutoRefreshAccountResearch(accountId, status) {
  if (!status?.needsResearch) return;
  const key = (status.reasons || []).join('|') || 'needs-research';
  if (autoResearchAttempts.get(accountId) === key) return;
  autoResearchAttempts.set(accountId, key);
  setTimeout(() => {
    const hash = location.hash.replace(/^#/, '') || '/';
    if (hash !== `/account/${accountId}`) return;
    refreshAccountResearch(accountId, { autoReason: (status.reasons || []).join(', ') || 'missing/stale/placeholder' });
  }, 0);
}
function accountBriefHtml(brief, account) {
  if (!brief) {
    return `<div class="research-empty">
      <div>
        <b>No merged account brief yet.</b>
        <div class="muted">Connect optional providers in Settings, then refresh this brief. With zero keys, the dashboard still uses local/public fallback research.</div>
      </div>
    </div>`;
  }
  const status = safeArray(brief.provider_status).map((s) => `<span class="provider-status ${esc(s.status || 'missing')}">${esc(providerLabel(s.provider))}: ${esc(s.status || 'missing')}${s.message ? ' — ' + esc(s.message) : ''}</span>`).join('');
  const signals = safeArray(brief.recent_signals).map((s) => `<li><b>${esc(safeText(s.label, 'Signal'))}</b>${s.detail ? ' — ' + esc(s.detail) : ''}<span>${esc(s.source || '')}</span></li>`).join('');
  const people = safeArray(brief.relevant_people).map((p) => `<li><b>${esc(safeText(p.name, 'Unknown person'))}</b> ${esc(p.title || '')}<span>${esc([p.source || '', p.activity || ''].filter(Boolean).join(' · '))}</span></li>`).join('');
  const sources = safeArray(brief.sources).map((s) => `<span class="source-chip">${esc(providerLabel(s.provider))}: ${esc(s.label || 'source')}${s.url ? ` <a href="${esc(s.url)}" target="_blank">↗</a>` : ''}</span>`).join('');
  const stackText = safeText(brief.incident_stack);
  const showStack = !/^(unknown|needs research|none|n\/a|-|—)$/i.test(stackText);
  return `<div class="brief-grid">
    <div class="brief-card wide"><div class="eyebrow">Company Overview</div><p>${esc(briefCopy(brief.company_overview, ''))}</p></div>
    ${showStack ? `<div class="brief-card"><div class="eyebrow">Incident / Reliability Stack</div><p>${esc(stackText)}</p></div>` : ''}
    <div class="brief-card"><div class="eyebrow">Why ${esc(account.name)} Might Care</div><p>${esc(briefCopy(brief.why_care, ''))}</p></div>
    <div class="brief-card"><div class="eyebrow">Suggested Outbound Angle</div><p>${esc(briefCopy(brief.outbound_angle, ''))}</p></div>
    <div class="brief-card"><div class="eyebrow">Call Prep Notes</div><p>${esc(briefCopy(brief.call_prep_notes, ''))}</p></div>
    <div class="brief-card list-card"><div class="eyebrow">Recent Signals</div><ul>${signals || '<li>No provider signals yet.<span>fallback</span></li>'}</ul></div>
    <div class="brief-card list-card"><div class="eyebrow">Relevant People</div><ul>${people || '<li>No provider people yet.<span>fallback</span></li>'}</ul></div>
    <div class="brief-card wide"><div class="eyebrow">Provider Status</div><div class="provider-row">${status || '<span class="provider-status missing">No provider status</span>'}</div><div class="source-row">${sources || '<span class="muted">No provider source attribution yet.</span>'}</div><div class="source-line">Generated ${esc(shortDate(brief.created_at))} by ${esc(brief.generated_by || 'system')}</div></div>
  </div>`;
}
function briefCopy(value, fallback) {
  const text = safeText(value, fallback).replace(/\s+/g, ' ').trim();
  const cleaned = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/(unknown|unverified|needs research|needs verification|no public|not found)/i.test(s))
    .join(' ')
    .trim();
  return cleaned || fallback || '';
}
function providerLabel(p) {
  return ({ commonRoom: 'Common Room', sumble: 'Sumble', gemini: 'Gemini', amplemarket: 'Amplemarket', web: 'Web', fixture: 'Fixture' }[p] || p || 'Provider');
}
function researchBriefHtml(brief, focus, account) {
  if (!brief) {
    return `<div class="research-empty">
      <div>
        <b>No generated research brief yet.</b>
        <div class="muted">Run the engine for ${focus ? esc(focus.name) : 'the first mapped contact'} at ${esc(account.name)} to populate likely pain, questions, LinkedIn touch, and email draft.</div>
      </div>
    </div>`;
  }
  const questions = (brief.questions_to_ask || []).map((q, i) => `<li><span>${i + 1}</span>${esc(q)}</li>`).join('');
  const painBullets = shortPainBullets(brief.likely_pain);
  return `<div class="research-grid">
    <div class="research-card pain-card">
      <div class="eyebrow">Likely Pain</div>
      <ul class="research-bullets">${painBullets.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <div class="source-line">Generated by ${esc(brief.generated_by)} ${brief.model ? '· ' + esc(brief.model) : ''} · ${esc(shortDate(brief.created_at))}</div>
    </div>
    <div class="research-card questions-card">
      <div class="eyebrow">Questions To Ask</div>
      <ol>${questions || '<li><span>1</span>Needs research.</li>'}</ol>
    </div>
    <div class="research-card outreach-card">
      <div class="eyebrow">Outreach</div>
      <div class="outreach-grid">
        <div class="touch-card">
          <div class="mini-label"><span>LinkedIn Touch</span><span class="mini-actions"><button class="copy-btn" data-copy-text="${attr(brief.linkedin_touch)}" type="button">Copy</button></span></div>
          <p>${esc(brief.linkedin_touch)}</p>
        </div>
        <div class="email-box">
          <div class="mini-label"><span>Email Draft</span><span class="mini-actions"><span>${String(brief.email_draft || '').trim().split(/\s+/).filter(Boolean).length}/60 words</span><button class="copy-btn" data-copy-text="${attr(brief.email_draft)}" type="button">Copy</button></span></div>
          <p>${esc(brief.email_draft)}</p>
        </div>
      </div>
    </div>
  </div>`;
}
function shortPainBullets(text) {
  const cleaned = displayCleanCopy(text)
    .replace(/^As\s+.*?,\s*/i, '')
    .replace(/\blikely faces pressure to\b/gi, 'Pressure to')
    .replace(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+Pressure to/i, 'Pressure to')
    .replace(/\bEnsuring\b/g, 'Ensure')
    .replace(/\bManaging\b/g, 'Manage')
    .replace(/\bEnsure seamless operations and minimizing\b/gi, 'Keep operations stable and minimize')
    .replace(/\bcould be a significant challenge\b/gi, 'is a likely challenge');
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+$/, '').trim())
    .filter(Boolean)
    .map((s) => s.length > 96 ? s.slice(0, 93).replace(/\s+\S*$/, '') + '...' : s);
  return sentences.slice(0, 4).length ? sentences.slice(0, 4) : ['Pressure-test incident response, stakeholder comms, and post-incident follow-up.'];
}
function contactHtml(c) {
  const bits = [c.email, c.phone, c.linkedin ? `<a href="${esc(c.linkedin)}" target="_blank">LinkedIn</a>` : ''].filter(Boolean).join(' · ');
  const initials = String(c.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';
  const reach = [c.email ? chipHtml('Email', 'good') : '', c.phone ? chipHtml('Phone', 'good') : '', c.linkedin ? chipHtml('LinkedIn', 'cloud') : ''].join('');
  return `<div class="contact-card">
    <div class="avatar">${esc(initials)}</div>
    <div class="contact-main">
      <div class="contact-top"><b>${esc(c.name || 'Unknown contact')}</b><span>${esc(c.confidence || 0)}%</span></div>
      <div class="contact-title">${esc(c.title || c.persona_role || '')}</div>
      <div class="contact-reach">${reach || '<span class="muted">No direct channel yet</span>'}</div>
      <div class="meta">${bits || ''}${c.source ? ' · ' + esc(c.source) : ''}</div>
    </div>
  </div>`;
}
function callcardHtml(n, contacts, accountId) {
  const who = contacts.find((c) => c.id === n.contact_id);
  const f = (lab, v) => v ? `<div class="field"><div class="lab">${lab}</div>${esc(v)}</div>` : '';
  const regen = n.contact_id ? `<button class="btn sm" onclick="genCallNotesFor(${accountId},${n.contact_id})" title="Rewrite with LLM if a key is set">↻ LLM</button>` : '';
  return `<div class="callcard">
    <h3>${who ? esc(who.name) + ' — ' + esc(who.title || '') : 'Account-level'} ${badge(n.generated_by, n.generated_by==='llm'?'green':'gray')} ${regen}</h3>
    ${f('Why this person', n.why_person)}${f('Likely pain', n.likely_pain)}${f('Opening line', n.opening_line)}
    ${f('Seller angle', n.rootly_angle)}${f('Good question', n.good_question)}${f('Likely objection', n.likely_objection)}
    ${f('Best response', n.best_response)}${f('Next step', n.next_step)}</div>`;
}
function callLogHtml(logs) {
  return safeArray(logs).slice(0, 12).map((l) => `<div class="item"><b>${esc((l.outcome || '').replace(/_/g, ' '))}</b>${l.contact_name ? ' · ' + esc(l.contact_name) : ''} <span class="muted">${esc(shortDate(l.created_at))}</span>${l.note ? `<div class="muted">${esc(l.note)}</div>` : ''}</div>`).join('') || '<div class="muted">No calls logged yet.</div>';
}
const bandLabel = (b) => ({work_today:'Work today',sequence_week:'Sequence this week',research_more:'Research more',low:'Low priority',blocked:'Blocked / do not work'}[b] || b);
const colorFor = (b) => ({work_today:'green',sequence_week:'yellow',research_more:'blue',low:'gray',blocked:'red'}[b] || 'gray');
const opts2 = (list, sel) => list.map((v) => `<option value="${v}" ${v===sel?'selected':''}>${v.replace(/_/g,' ')}</option>`).join('');
const selCustomer = (id, field, cur) => `<select class="sm" onchange="setCustomer(${id},'${field}',this.value)">${opts2(['unknown','yes','no'], cur)}</select>`;

// ---------- AGENT OS ----------
let agentOsData = null, agentOsSurfaces = {}, agentOsSelected = null;
// Live-reprobe these on click so their status reflects the running machine.
const OS_LIVE_KEYS = ['hermes', 'openclaw', 'ollama', 'free-claude-code', 'n2-agent', 'gemini'];
let n2History = [];          // [{role, content}] kept for the N2 chat panel
let claudeLastRun = null;    // last Free Claude Code run result (legacy single-run)
let councilLastRun = null;   // last Agent Council deliberation result
let claudeSession = null;    // { id, turns:[...], running } — multi-turn Claude Code
let geminiSession = null;    // { turns:[...], running } — Gemini CLI chat
let n2Models = null;         // cached free/low-cost router models for the N2 picker

// ---- Agent logos: cohesive white glyphs that sit inside the accent avatar.
// Each is a 24x24 SVG using currentColor (the avatar sets color:#fff), so it
// inherits the circle's foreground. Falls back to the first letter if unmapped.
const OS_LOGOS = {
  council: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5V10a2.5 2.5 0 0 1-2.5 2.5H8l-4 3z"/><path d="M16 9.5h1.5A2.5 2.5 0 0 1 20 12v3.5l-3 2.5h-4.5A2.5 2.5 0 0 1 10 15.5"/></svg>',
  memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.6 3.1 3 7 3s7-1.4 7-3V6"/><path d="M5 12c0 1.6 3.1 3 7 3s7-1.4 7-3"/></svg>',
  'free-claude-code': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>',
  claude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>',
  'n2-agent': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/></svg>',
  hermes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3 3 10.5 9.5 13 12 21l3-7z"/><path d="M21 3 9.5 13"/></svg>',
  openclaw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6"/><path d="M6 21l-1.5-7a7.5 7.5 0 0 1 15 0L18 21"/><path d="M9 21l.7-5M15 21l-.7-5M12 16v5"/></svg>',
  gemini: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 1.5C12.6 6.8 17.2 11.4 22.5 12 17.2 12.6 12.6 17.2 12 22.5 11.4 17.2 6.8 12.6 1.5 12 6.8 11.4 11.4 6.8 12 1.5z"/></svg>',
  codex: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7 3 12l5 5"/><path d="m16 7 5 5-5 5"/><path d="M13.5 4 10.5 20"/></svg>',
  ollama: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6.6 3.2c.7-.3 1.5.2 1.7 1l.5 2c.3 1 1.2 1.7 2.2 1.7h2c1 0 1.9-.7 2.2-1.7l.5-2c.2-.8 1-1.3 1.7-1 .6.3.9 1.1.7 2l-.6 2.5c-.2 1 0 1.9.9 2.8V18c0 1-.8 1.8-1.8 1.8s-1.7-.8-1.7-1.8v-2.2l-2-1.3-2 1.3V18c0 1-.8 1.8-1.8 1.8S7.6 19 7.6 18v-6.7c.9-.9 1.1-1.8.9-2.8L7.9 6c-.2-.9.1-1.5.7-2z"/></svg>',
  antigravity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V7"/><path d="m7 12 5-5 5 5"/><path d="M4.5 19.5a9 9 0 0 1 15 0"/></svg>',
};
function osLogo(agent, label = '') {
  const svg = OS_LOGOS[agent];
  if (svg) return svg;
  return esc((label || agent || '?')[0] || '?');
}

// ---- Hide/show agents: operator can turn off agents that aren't set up.
// Persisted per-browser in localStorage; affects the rail and the tile mosaic.
function osHiddenSet() {
  try { return new Set(JSON.parse(localStorage.getItem('osHiddenAgents') || '[]')); }
  catch { return new Set(); }
}
function osSetHidden(set) {
  try { localStorage.setItem('osHiddenAgents', JSON.stringify([...set])); } catch { /* ignore */ }
}
function osToggleHiddenInternal(key) {
  const set = osHiddenSet();
  if (set.has(key)) set.delete(key); else set.add(key);
  osSetHidden(set);
  if (agentOsSelected === key && set.has(key)) agentOsSelected = null;
  renderAgentOs(agentOsSelected);
}
window.osToggleHidden = osToggleHiddenInternal;

async function renderAgentOs(initialKey = null, guard = null) {
  const [d, sres] = await Promise.all([api('/agent-os'), api('/agent-os/surfaces')]);
  if (guard && (guard.epoch !== renderEpoch || (location.hash.replace(/^#/, '') || '/') !== guard.hash)) return;
  agentOsData = d;
  agentOsSurfaces = (sres && sres.surfaces) || {};
  const keys = Object.keys(agentOsSurfaces);
  if (initialKey && agentOsSurfaces[initialKey]) agentOsSelected = initialKey;
  else if (!agentOsSelected && agentOsSurfaces.council) agentOsSelected = 'council';
  if (!agentOsSelected || !agentOsSurfaces[agentOsSelected]) agentOsSelected = keys[0] || null;
  const stats = d.gtm?.stats || {};
  const priority = d.gtm?.priority || [];
  const tasks = d.gtm?.tasks || [];
  const audits = d.gtm?.audits || [];
  const brain = d.brain || {};
  // Real system-status strip (replaces the old decorative mode tabs).
  const statusStrip = ['app', 'hermes', 'ollama', 'openClaw', 'gemini', 'sumble', 'amplemarket']
    .map((k) => { const s = d.status?.[k]; return s ? osStatusChip(s.label, s.state) : ''; }).join('');
  const hidden = osHiddenSet();
  const visibleKeys = keys.filter((k) => !hidden.has(k));
  const hiddenKeys = keys.filter((k) => hidden.has(k));
  const agentRows = visibleKeys.map((k) => osAgentRow(agentOsSurfaces[k])).join('');
  const hiddenRows = hiddenKeys.map((k) => osHiddenRow(agentOsSurfaces[k])).join('');
  const tileKeys = ['memory', 'free-claude-code', 'hermes', 'openclaw', 'n2-agent'].filter((k) => !hidden.has(k));
  const agentTiles = tileKeys.map((k) => osAgentTile(agentOsSurfaces[k])).join('');
  // Real analytics sparkline: normalized scores of the top priority accounts.
  const barData = priority.slice(0, 10).map((c) => ({ h: normalizedScore(c.score), label: c.name }));
  const bars = barData.length
    ? barData.map((b) => `<span style="height:${Math.max(6, b.h)}%" title="${attr(b.label)}: ${b.h}"></span>`).join('')
    : '<span class="os-muted" style="font-size:11px">No scored accounts yet</span>';
  const priorityRows = priority.slice(0, 6).map((c) => `<div class="os-account-row" onclick="location.hash='#/account/${c.id}'">
      <span class="os-score">${normalizedScore(c.score)}</span>
      <div><b>${esc(c.name)}</b><small>${esc(c.whyNow || c.next_action || 'Needs research')}</small></div>
      <i>${esc(c.bandLabel || c.band || '')}</i>
    </div>`).join('');
  const taskRows = tasks.map((t) => `<div class="os-log-line"><span>task</span><b>${esc(t.account_name || 'OS')}</b><em>${esc(t.title)}</em></div>`).join('');
  const auditRows = audits.slice(0, 7).map((a) => `<div class="os-audit-row"><span>${esc(shortDate(a.created_at))}</span><b>${esc(a.source || 'system')}</b><em>${esc(a.action || '')}</em></div>`).join('');

  view.innerHTML = `<div class="agent-os-shell">
    <aside class="os-left-rail">
      <div class="os-window-dots"><span></span><span></span><span></span></div>
      <div class="os-rail-title">Agents</div>
      <div class="os-agent-list">${agentRows}</div>
      ${hiddenRows ? `<details class="os-hidden-agents"><summary>Hidden · ${hiddenKeys.length}</summary><div class="os-agent-list">${hiddenRows}</div></details>` : ''}
      <div class="os-rail-section">Workspace</div>
      <button class="os-side-action" type="button" onclick="location.hash='#/'"><span></span>GTM Home</button>
      <button class="os-side-action" type="button" onclick="location.hash='#/map'"><span></span>Memory Map</button>
      <button class="os-side-action" type="button" onclick="location.hash='#/queue'"><span></span>Call Queue</button>
      <div class="os-live-card">
        <div class="os-live-frame"><b>LIVE</b><span></span></div>
        <div>Operator room</div>
        <small>real local agent surfaces</small>
      </div>
    </aside>

    <section class="os-main">
      <header class="os-command-bar">
        <div class="os-status-strip">${statusStrip}</div>
        <div class="os-command-actions">
          <span class="os-live-pill" title="Surfaces auto-refresh every 25s"><i></i>Live</span>
          <button class="os-icon-btn" onclick="agentOsRefresh()" title="Refresh" type="button">&#8635;</button>
        </div>
      </header>

      <div class="os-mission-layout">
        <div class="os-center-stage">
          <section class="os-council-banner">
            <div>
              <span class="os-eyebrow">Agentic OS</span>
              <h1>Mission Control</h1>
              <p>${esc(stats.workToday || 0)} work-today accounts · ${esc(brain.graph?.hubs || 0)} memory hubs · ${esc(brain.skills?.available || d.skills?.available || 0)} skills</p>
            </div>
            <button class="os-cta" type="button" onclick="selectAgent('council')">Open council</button>
          </section>
          <div class="os-agent-mosaic">${agentTiles}</div>
          <div id="os-surface" class="os-surface-host"></div>
        </div>
        <aside class="os-brain-rail">${osBrainRail(brain)}</aside>
      </div>

      <div class="os-lower-grid">
        <section class="os-card">
          <div class="os-card-title">Daily Operating Queue</div>
          ${priorityRows || '<div class="os-muted">No priority accounts yet.</div>'}
        </section>
        <section class="os-card">
          <div class="os-card-title">Goals &amp; Journal</div>
          ${taskRows || '<div class="os-muted">No open tasks.</div>'}
        </section>
        <section class="os-card analytics">
          <div class="os-card-title">GTM Analytics</div>
          <div class="os-metrics">
            ${osMetric(stats.total || 0, 'accounts')}
            ${osMetric(stats.workToday || 0, 'work today')}
            ${osMetric(stats.contacts || 0, 'contacts')}
            ${osMetric(stats.blocked || 0, 'blocked')}
          </div>
          <div class="os-bars" title="Top priority account scores">${bars}</div>
        </section>
        <section class="os-card">
          <div class="os-card-title">Logs &amp; Audit Trail</div>
          ${auditRows || '<div class="os-muted">No audit rows yet.</div>'}
        </section>
      </div>
    </section>
  </div>`;
  window.selectAgent(agentOsSelected, false);
  startAgentOsAutoRefresh();
}

// Keep the live surfaces' rail dots current without disturbing the open panel
// (so a running Claude job / N2 chat isn't interrupted). Cleared on route change.
const OS_AUTOREFRESH_KEYS = ['hermes', 'openclaw', 'ollama'];
function startAgentOsAutoRefresh() {
  if (window._agentOsTimer) clearInterval(window._agentOsTimer);
  let busy = false;
  window._agentOsTimer = setInterval(async () => {
    if (busy || !document.body.classList.contains('agent-os-mode')) return;
    busy = true;
    try {
      await Promise.all(OS_AUTOREFRESH_KEYS.map(async (k) => {
        try {
          const s = await api('/agent-os/surfaces/' + k);
          agentOsSurfaces[k] = s;
          const dot = document.querySelector('.os-agent-row[data-agent-key="' + k + '"] i');
          if (dot) dot.className = osTone(s.state);
        } catch { /* keep last known */ }
      }));
    } finally { busy = false; }
  }, 25000);
  window.stopAgentOs = () => { if (window._agentOsTimer) clearInterval(window._agentOsTimer); window._agentOsTimer = null; };
}

function osSurfaceLoading(label) {
  return `<div class="os-surface-wrap"><div class="os-connect"><div class="os-spinner"></div><p class="os-muted">${esc(label)}</p></div></div>`;
}

function osHead(s, extra = '') {
  return `<div class="os-surface-head">
      <span class="os-dot ${osTone(s.state)}"></span>
      <b>${esc(s.label)}</b>
      <em>${esc(osTitleCase(s.state))}${s.url ? ' · ' + esc(s.url) : ''}</em>
      <span class="os-surface-actions">${extra}</span>
    </div>`;
}
const osRecheckBtn = (s) => `<button class="os-cta-sm" data-os-recheck="${attr(s.agent)}" type="button">Re-check</button>`;

// Free Claude Code — a full-access, multi-turn terminal that mirrors the real
// CLI: streams stream-json events (text + tool calls), keeps the session alive
// across turns, and runs with --dangerously-skip-permissions (operator-chosen).
function osClaudeCodePanel(s) {
  if (!s.canRun) {
    return `<div class="os-surface-wrap">${osHead(s, osRecheckBtn(s))}
      <div class="os-connect"><div class="os-connect-icon ${esc(s.accent || '')}">${osLogo('free-claude-code', s.label)}</div>
        <h3>Claude Code is not installed</h3>
        <p class="os-muted">${esc(s.detail || '')}</p>
        ${s.installCommand ? `<code class="os-code">${esc(s.installCommand)}</code>` : ''}
        ${s.installCommand ? `<button class="os-cta copy-btn" data-copy-text="${attr(s.installCommand)}" type="button">Copy install</button>` : ''}
      </div></div>`;
  }
  const running = !!claudeSession?.running;
  const loginNotice = s.needsLogin
    ? `<div class="os-notice">Local Claude Code is logged out. Run <code>claude auth login --claudeai</code> in a terminal, then Re-check.</div>`
    : '';
  const extra = `${osRecheckBtn(s)}<button class="os-cta-sm" type="button" data-os-claude-new="1">New session</button>`;
  return `<div class="os-surface-wrap os-cc-panel">${osHead(s, extra)}
    <div class="os-cc-bar">
      <span class="os-badge bad" title="Runs with --dangerously-skip-permissions — all tools, no prompts">full access</span>
      <code>${esc(s.command || 'claude')}</code>
      <span class="os-muted">${esc(s.version || '')}</span>
      ${claudeSession?.id ? `<span class="os-muted">· session ${esc(String(claudeSession.id).slice(0, 8))}</span>` : ''}
      <span class="os-cc-cwd">${esc(s.workdir || '')}</span>
    </div>
    ${loginNotice}
    <div id="os-cc-term" class="os-cc-term">${osClaudeTermHtml()}</div>
    <form class="os-form os-claude-form">
      <textarea class="os-prompt" name="prompt" rows="2" placeholder="Ask Claude Code anything — full tools, full repo. (⌘/Ctrl+Enter to send)" ${running ? 'disabled' : ''}></textarea>
      <div class="os-form-row">
        <span class="os-muted">${running ? 'Working…' : (claudeSession?.id ? 'Multi-turn — continues this session' : 'New conversation')}</span>
        ${running ? '<button class="os-cta-sm os-stop" data-os-claude-stop="1" type="button">Stop</button>' : ''}
        <button class="os-cta" type="submit" ${running ? 'disabled' : ''}>Send</button>
      </div>
    </form>
  </div>`;
}

function osClaudeTermHtml() {
  if (!claudeSession || !claudeSession.turns.length) {
    return '<div class="os-muted os-cc-empty">Full Claude Code, right here. It can read, edit, and run anything in this repo — multi-turn, just like the terminal.</div>';
  }
  const blocks = claudeSession.turns.map(osCcBlockHtml).join('');
  const spin = claudeSession.running ? '<div class="os-cc-line"><span class="os-spinner sm"></span><span class="os-muted">thinking…</span></div>' : '';
  return blocks + spin;
}

function osCcBlockHtml(b) {
  if (b.kind === 'user') return `<div class="os-cc-user"><span>&rsaquo;</span><pre>${esc(b.text)}</pre></div>`;
  if (b.kind === 'text') return `<div class="os-cc-text">${esc(b.text)}</div>`;
  if (b.kind === 'tool') {
    const summary = ccToolSummary(b.name, b.input);
    return `<details class="os-cc-tool"><summary><span class="os-cc-dot">&#9679;</span> ${esc(b.name)}${summary ? ` <em>${esc(summary)}</em>` : ''}</summary><pre>${esc(JSON.stringify(b.input || {}, null, 2))}</pre></details>`;
  }
  if (b.kind === 'tool_result') return `<details class="os-cc-toolresult"><summary class="os-muted">result${b.isError ? ' · error' : ''}</summary><pre>${esc(b.text || '')}</pre></details>`;
  if (b.kind === 'result') {
    const bits = [];
    if (b.numTurns != null) bits.push(b.numTurns + ' turns');
    if (b.duration != null) bits.push((Math.round(b.duration / 100) / 10) + 's');
    if (b.cost != null) bits.push('$' + Number(b.cost).toFixed(4));
    return bits.length ? `<div class="os-cc-meta">${esc(bits.join(' · '))}</div>` : '';
  }
  if (b.kind === 'error') return `<div class="os-out-err">${esc(b.text)}</div>`;
  return '';
}

function ccToolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash') return String(input.command || '').slice(0, 120);
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return input.file_path || '';
  if (name === 'Grep' || name === 'Glob') return input.pattern || '';
  if (name === 'Task') return input.description || '';
  const k = Object.keys(input)[0];
  return k ? `${k}: ${String(input[k]).slice(0, 60)}` : '';
}

// Gemini — the user's logged-in Gemini CLI as a chat panel. Streams plain text;
// optional YOLO toggle auto-approves tools, and turns continue the latest session.
function osGeminiPanel(s) {
  if (s.needsLogin || s.action === 'login') {
    return `<div class="os-surface-wrap">${osHead(s, osRecheckBtn(s))}
      <div class="os-connect"><div class="os-connect-icon ${esc(s.accent || '')}">${osLogo('gemini', s.label)}</div>
        <h3>Log in to Gemini</h3>
        <p class="os-muted">${esc(s.detail || 'Gemini CLI is installed but not logged in.')}</p>
        <code class="os-code">${esc(s.loginCommand || 'gemini')}</code>
        <button class="os-cta copy-btn" data-copy-text="${attr(s.loginCommand || 'gemini')}" type="button">Copy login command</button>
        <p class="os-muted">Run it once in a terminal, choose "Login with Google", then Re-check.</p>
      </div></div>`;
  }
  if (!s.canRun) return osGenericSurface(s);
  const running = !!geminiSession?.running;
  const extra = `${osRecheckBtn(s)}<button class="os-cta-sm" type="button" data-os-gemini-new="1">New chat</button>`;
  return `<div class="os-surface-wrap os-cc-panel">${osHead(s, extra)}
    <div class="os-cc-bar">
      <span class="os-badge good" title="${attr(s.authHint || '')}">${esc(s.authMethod === 'api-key' ? 'API key' : 'Google login')}</span>
      <code>${esc(s.command || 'gemini')}</code>
      <span class="os-muted">${esc(s.version || '')}</span>
    </div>
    <div id="os-gem-term" class="os-cc-term">${osGeminiTermHtml()}</div>
    <form class="os-form os-gemini-form">
      <textarea class="os-prompt" name="prompt" rows="2" placeholder="Message Gemini…  (⌘/Ctrl+Enter to send)" ${running ? 'disabled' : ''}></textarea>
      <div class="os-form-row">
        <label class="os-check"><input type="checkbox" name="yolo" ${running ? 'disabled' : ''}> YOLO (auto-approve tools)</label>
        ${running ? '<button class="os-cta-sm os-stop" data-os-gemini-stop="1" type="button">Stop</button>' : ''}
        <button class="os-cta" type="submit" ${running ? 'disabled' : ''}>Send</button>
      </div>
    </form>
  </div>`;
}
function osGeminiTermHtml() {
  if (!geminiSession || !geminiSession.turns.length) {
    return '<div class="os-muted os-cc-empty">Your logged-in Gemini, right here. Ask anything; toggle YOLO to let it use tools.</div>';
  }
  const blocks = geminiSession.turns.map((b) => (b.kind === 'user'
    ? `<div class="os-cc-user"><span>&rsaquo;</span><pre>${esc(b.text)}</pre></div>`
    : b.kind === 'error' ? `<div class="os-out-err">${esc(b.text)}</div>`
      : `<div class="os-cc-text">${esc(b.text)}</div>`)).join('');
  const spin = geminiSession.running ? '<div class="os-cc-line"><span class="os-spinner sm"></span><span class="os-muted">thinking…</span></div>' : '';
  return blocks + spin;
}

// N2 Agent — local chat panel backed by OpenRouter/LiteLLM, or honest setup.
function osN2Panel(s) {
  const meta = `<div class="os-kv-grid">
      <div class="os-kv"><span>Model</span><code>${esc(s.model || '')}</code></div>
      <div class="os-kv"><span>Route</span><b>${esc(osTitleCase(s.route || ''))}</b></div>
      <div class="os-kv"><span>Endpoint</span><code>${esc(s.routerUrl || '')}</code></div>
      <div class="os-kv"><span>State</span><b>${esc(osTitleCase(s.state))}</b></div>
    </div>`;
  if (!s.hasKey) {
    const steps = [
      'cd OpenAgenticOS',
      "printf '\\nOPENROUTER_API_KEY=your_openrouter_key_here\\nN2_MODEL=nex-agi/nex-n2-pro:free\\n' >> .env",
      'npm start',
    ].join('\n');
    return `<div class="os-surface-wrap">${osHead(s, osRecheckBtn(s))}
      <div class="os-run-panel">${meta}
        <div class="os-setup">
          <h3>N2 needs a router key in this app</h3>
          <p class="os-muted">${esc(s.detail || '')} Add an OpenRouter key (or set <code>LITELLM_BASE_URL</code>), restart, then Re-check.</p>
          <code class="os-code os-code-block">${esc(steps)}</code>
          <button class="os-cta copy-btn" data-copy-text="${attr(steps)}" type="button">Copy setup</button>
        </div>
      </div></div>`;
  }
  const caps = (s.capabilities || []).map((c) => `<span class="os-pill">${esc(c)}</span>`).join('');
  return `<div class="os-surface-wrap">${osHead(s, osRecheckBtn(s))}
    <div class="os-run-panel">${meta}
      <div class="os-caps">${caps}</div>
      <div id="os-n2-thread" class="os-chat">${n2History.length ? n2History.map(osN2Bubble).join('') : '<span class="os-muted">Local N2 chat. Messages route through ' + esc(s.route) + '. Outbound actions still need your approval.</span>'}</div>
      <form class="os-form os-n2-form">
        <textarea class="os-prompt" name="prompt" rows="2" placeholder="Message N2…  (⌘/Ctrl+Enter to send)"></textarea>
        <div class="os-form-row">
          <input class="os-model-input" name="model" value="${attr(s.model || '')}" list="os-n2-models" spellcheck="false" autocapitalize="off" title="OpenRouter model slug — type or pick a free model (e.g. openrouter/owl-alpha)" placeholder="model slug — Owl Alpha, free models…">
          <datalist id="os-n2-models">${safeArray(n2Models).map((m) => `<option value="${attr(m.id)}">${attr(m.name || m.id)}</option>`).join('')}</datalist>
          <button class="os-cta-ghost" type="button" data-os-n2-clear="true">Clear</button>
          <button class="os-cta" type="submit">Send</button>
        </div>
        ${safeArray(n2Models).length ? `<div class="os-muted os-n2-modelhint">${n2Models.length} free models available · try <code>openrouter/owl-alpha</code></div>` : ''}
      </form>
    </div></div>`;
}
function osN2Bubble(m) {
  return `<div class="os-msg ${m.role === 'user' ? 'me' : 'bot'}"><span class="os-msg-role">${esc(m.role === 'user' ? 'You' : 'N2')}</span><div class="os-msg-body">${esc(m.content)}</div></div>`;
}

// OpenClaw — live gateway status + open-the-real-dashboard (iframe is blocked).
function osOpenClawPanel(s) {
  if (s.state !== 'connected') {
    // installed-not-running / not-installed — fall back to the generic panel.
    return osGenericSurface(s);
  }
  const g = s.gateway || {};
  const kv = (label, val) => val ? `<div class="os-kv"><span>${esc(label)}</span><b>${esc(val)}</b></div>` : '';
  return `<div class="os-surface-wrap">${osHead(s, `${osRecheckBtn(s)}<a class="os-cta-sm" href="${attr(s.url)}" target="_blank" rel="noopener">Open ↗</a>`)}
    <div class="os-run-panel">
      <div class="os-kv-grid">
        ${kv('Dashboard', g.dashboard || s.url)}
        ${kv('Runtime', g.runtime)}
        ${kv('Capability', g.capability)}
        ${kv('Gateway version', g.gatewayVersion)}
        ${kv('Connectivity', g.connectivity)}
        ${kv('Service', g.service)}
      </div>
      <div class="os-connect">
        <div class="os-connect-icon ${esc(s.accent || '')}">${osLogo('openclaw', s.label)}</div>
        <h3>OpenClaw gateway is live</h3>
        <p class="os-muted">OpenClaw sets <code>X-Frame-Options: DENY</code> and <code>frame-ancestors 'none'</code>, so it can't be embedded here. Open the real dashboard in its own tab.</p>
        <a class="os-cta" href="${attr(s.url)}" target="_blank" rel="noopener">Open OpenClaw Dashboard ↗</a>
      </div>
    </div></div>`;
}

// Render the central workspace for one agent: a REAL embedded surface when it's
// reachable + embeddable, else an honest open / start / install / external panel.
function osSurfaceHtml(s) {
  if (!s) return '<div class="os-surface-wrap"><div class="os-connect"><p class="os-muted">Select an agent.</p></div></div>';
  if (s.agent === 'council') return osCouncilPanel(s);
  if (s.agent === 'memory') return osMemoryPanel(s);
  if (s.agent === 'free-claude-code') return osClaudeCodePanel(s);
  if (s.agent === 'gemini') return osGeminiPanel(s);
  if (s.agent === 'n2-agent') return osN2Panel(s);
  if (s.agent === 'openclaw') return osOpenClawPanel(s);
  return osGenericSurface(s);
}

function osCouncilPanel(s) {
  return `<div class="os-surface-wrap os-council-panel">${osHead(s, osRecheckBtn(s))}
    <div class="os-council-grid">
      <form class="os-form os-council-form">
        <textarea class="os-prompt council" name="idea" rows="5" placeholder="Drop the idea, plan, offer, account angle, or workflow you want the council to deliberate."></textarea>
        <div class="os-form-row">
          <span class="os-muted">Memory, Claude Code, Hermes, OpenClaw, and N2 each return an angle.</span>
          <button class="os-cta" type="submit">Deliberate</button>
        </div>
      </form>
      <div id="os-council-out" class="os-council-out">${councilLastRun ? osCouncilResultHtml(councilLastRun) : osCouncilEmptyHtml()}</div>
    </div>
  </div>`;
}

function osCouncilEmptyHtml() {
  const samples = [
    'Turn this dashboard into a daily agentic GTM cockpit.',
    'Find a safer way to run outbound without inventing customer facts.',
    'Use OpenClaw and Hermes together for recurring research.',
  ];
  return `<div class="os-council-empty">
    ${samples.map((s) => `<button type="button" data-os-council-sample="${attr(s)}">${esc(s)}</button>`).join('')}
  </div>`;
}

function osCouncilResultHtml(r) {
  if (r.running) return `<div class="os-connect"><div class="os-spinner"></div><p class="os-muted">Council is deliberating…</p></div>`;
  if (r.error) return `<div class="os-notice">${esc(r.error)}</div>`;
  const synth = r.synthesis || {};
  const rows = (r.angles || []).map((a) => {
    const ff = safeArray(a.fallbackFields);
    const live = a.live === true && ff.length === 0;
    const badge = live
      ? '<span class="os-badge good">live</span>'
      : `<span class="os-badge warn" title="${attr('template fallback: ' + (ff.join(', ') || 'all'))}">fallback</span>`;
    const bullets = safeArray(a.bullets).map((x) => `<li>${esc(x)}</li>`).join('');
    const risk = safeArray(a.risks)[0] ? esc(a.risks[0]) : '<span class="os-muted">—</span>';
    const next = safeArray(a.nextActions)[0] ? esc(a.nextActions[0]) : '<span class="os-muted">—</span>';
    return `<tr>
      <td class="os-ct-agent"><span class="os-avatar sm ${esc((agentOsSurfaces[a.agent]?.accent) || 'teal')}">${osLogo(a.agent, a.label)}</span><div><b>${esc(a.label)}</b>${badge}</div></td>
      <td class="os-ct-stance">${esc(a.stance || '')}</td>
      <td><ul class="os-ct-points">${bullets || '<li class="os-muted">—</li>'}</ul></td>
      <td>${risk}</td>
      <td>${next}</td>
    </tr>`;
  }).join('');
  return `<div class="os-synthesis">
      <div><span>What</span><b>${esc(synth.what || r.idea || '')}</b></div>
      <div><span>So what</span><b>${esc(synth.soWhat || '')}</b></div>
      <div><span>Now what</span><b>${esc(safeArray(synth.nowWhat).join(' · '))}</b></div>
    </div>
    <div class="os-council-tablewrap">
      <table class="os-council-table">
        <thead><tr><th>Agent</th><th>Stance</th><th>Key points</th><th>Risk</th><th>Next</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="os-muted">No angles returned.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function osMemoryPanel(s) {
  const stats = s.graphStats || agentOsData?.brain?.graph || {};
  const vault = s.vault || { connected: false, notes: [], dir: '' };
  const vaultChip = vault.connected
    ? `<span class="os-badge good" title="${attr(vault.dir || '')}">Obsidian · ${esc(vault.count || vault.notes.length || 0)} notes</span>`
    : `<span class="os-badge bad" title="${attr(vault.error || '')}">Obsidian not found</span>`;
  const notes = safeArray(vault.notes).map((n) => `<div class="os-memory-row note">
      <b>${esc(n.name)}</b>
      <em class="os-note-when">${esc(shortDate(n.updated))}</em>
      <span>${esc(n.excerpt || '')}</span>
    </div>`).join('');
  return `<div class="os-surface-wrap os-memory-panel">${osHead(s, `${osRecheckBtn(s)}<a class="os-cta-sm" href="#/map">Open map</a>`)}
    <div class="os-memory-grid">
      <div class="os-memory-graph">
        <div class="os-orbit"><span></span><span></span><span></span><span></span><i></i></div>
      </div>
      <div class="os-memory-stats">
        ${osMetric(stats.accounts || 0, 'accounts')}
        ${osMetric(stats.contacts || 0, 'people')}
        ${osMetric(stats.hubs || 0, 'hubs')}
        ${osMetric(vault.connected ? (vault.count || vault.notes.length || 0) : 0, 'notes')}
      </div>
      <div class="os-memory-list">
        <div class="os-card-title">Obsidian Memory ${vaultChip}</div>
        <input class="os-memory-search" placeholder="Search the vault…" oninput="agentOsVaultSearch(this.value)">
        <div id="os-vault-results" class="os-vault-results"></div>
        <div id="os-vault-recent">
          ${vault.connected
    ? (notes || '<div class="os-muted">Vault connected, but no notes found yet.</div>')
    : `<div class="os-muted">Couldn't read the vault${vault.dir ? ` at ${esc(vault.dir)}` : ''}. Set OBSIDIAN_VAULT_DIR if it lives elsewhere.</div>`}
        </div>
      </div>
    </div>
  </div>`;
}
let vaultSearchTimer = null;
function agentOsVaultSearchInternal(q) {
  const recent = document.getElementById('os-vault-recent');
  const out = document.getElementById('os-vault-results');
  if (!out) return;
  const needle = String(q || '').trim();
  if (vaultSearchTimer) clearTimeout(vaultSearchTimer);
  if (!needle) { out.innerHTML = ''; if (recent) recent.style.display = ''; return; }
  if (recent) recent.style.display = 'none';
  out.innerHTML = '<div class="os-muted">Searching…</div>';
  vaultSearchTimer = setTimeout(async () => {
    try {
      const r = await api('/agent-os/memory/search?q=' + encodeURIComponent(needle));
      // Ignore results if the box was cleared or changed while the fetch was in flight.
      const live = document.querySelector('.os-memory-search');
      if (live && String(live.value || '').trim() !== needle) return;
      const rows = safeArray(r.results).map((n) => `<div class="os-memory-row note">
          <b>${esc(n.name)}</b><em class="os-note-when">${esc(shortDate(n.updated))}</em>
          <span>${esc(n.snippet || '')}</span>
        </div>`).join('');
      out.innerHTML = rows || '<div class="os-muted">No vault notes match.</div>';
    } catch (e) {
      out.innerHTML = `<div class="os-muted">Search failed: ${esc(e.message)}</div>`;
    }
  }, 220);
}
window.agentOsVaultSearch = agentOsVaultSearchInternal;
function osGenericSurface(s) {
  const icon = `<div class="os-connect-icon ${esc(s.accent || '')}">${osLogo(s.agent, s.label)}</div>`;
  const head = (extra = '') => osHead(s, extra);
  const recheck = osRecheckBtn(s);
  if (s.action === 'embed') {
    return `<div class="os-surface-wrap">
      ${head(`${recheck}<a class="os-cta-sm" href="${attr(s.url)}" target="_blank" rel="noopener">Open ↗</a>`)}
      <iframe class="os-embed" src="${attr(s.url)}" title="${attr(s.label)} dashboard"></iframe>
    </div>`;
  }
  if (s.action === 'open-tab') {
    return `<div class="os-surface-wrap">${head(recheck)}
      <div class="os-connect">${icon}
        <h3>${esc(s.label)} is live but blocks embedding</h3>
        <p class="os-muted">${esc(s.label)} sends headers that prevent iframe embedding. Open the real surface in its own tab.</p>
        <a class="os-cta" href="${attr(s.url)}" target="_blank" rel="noopener">Open ${esc(s.label)} ↗</a>
      </div></div>`;
  }
  if (s.action === 'api') {
    return `<div class="os-surface-wrap">${head(recheck)}
      <div class="os-connect">${icon}
        <h3>${esc(s.label)} model server is running</h3>
        <p class="os-muted">${esc(s.detail || '')}</p>
        <a class="os-cta-ghost" href="${attr(s.url)}" target="_blank" rel="noopener">Open ${esc(s.url)} ↗</a>
      </div></div>`;
  }
  if (s.action === 'start') {
    return `<div class="os-surface-wrap">${head(recheck)}
      <div class="os-connect">${icon}
        <h3>${esc(s.label)} is installed but not serving</h3>
        <p class="os-muted">${esc(s.detail || '')}</p>
        ${s.startCommand ? `<code class="os-code">${esc(s.startCommand)}</code>` : ''}
        <div class="os-cta-row">
          ${s.canStart ? `<button class="os-cta" data-os-start="${attr(s.agent)}" type="button">Start ${esc(s.label)}</button>` : ''}
          ${s.startCommand ? `<button class="os-cta-ghost copy-btn" data-copy-text="${attr(s.startCommand)}" type="button">Copy command</button>` : ''}
        </div>
      </div></div>`;
  }
  if (s.action === 'install') {
    return `<div class="os-surface-wrap">${head(recheck)}
      <div class="os-connect">${icon}
        <h3>${esc(s.label)} is not installed</h3>
        <p class="os-muted">${esc(s.detail || '')} Install it, then Re-check — I won't install it without your go-ahead.</p>
        ${s.installCommand ? `<code class="os-code">${esc(s.installCommand)}</code>` : ''}
        <div class="os-cta-row">
          ${s.installCommand ? `<button class="os-cta copy-btn" data-copy-text="${attr(s.installCommand)}" type="button">Copy install</button>` : ''}
        </div>
      </div></div>`;
  }
  if (s.action === 'local') {
    return `<div class="os-surface-wrap">${head(`<a class="os-cta-sm" href="${attr(s.url || '/')}">Open</a>`)}
      <div class="os-connect">${icon}
        <h3>${esc(s.label)} — local surface</h3>
        <p class="os-muted">${esc(s.detail || '')}</p>
        <a class="os-cta" href="${attr(s.url || '/')}">Open ${esc(s.label)}</a>
      </div></div>`;
  }
  return `<div class="os-surface-wrap">${head()}
    <div class="os-connect">${icon}
      <h3>${esc(s.label)}</h3>
      <p class="os-muted">${esc(s.detail || 'No local surface.')}</p>
      <span class="os-badge">external / sandboxed</span>
    </div></div>`;
}

function osAgentRow(s) {
  if (!s) return '';
  return `<button class="os-agent-row ${s.agent === agentOsSelected ? 'selected' : ''}" type="button" data-agent-key="${attr(s.agent)}">
    <span class="os-avatar ${esc(s.accent || '')}">${osLogo(s.agent, s.label)}</span>
    <span class="os-agent-meta"><b>${esc(s.label)}</b><em>${esc(s.role || '')}</em></span>
    <i class="${osTone(s.state)}"></i>
    <span class="os-hide-btn" data-os-hide="${attr(s.agent)}" role="button" tabindex="0" title="Hide ${attr(s.label)}" aria-label="Hide ${attr(s.label)}">&times;</span>
  </button>`;
}

function osHiddenRow(s) {
  if (!s) return '';
  return `<button class="os-agent-row hidden-row" type="button" data-os-show="${attr(s.agent)}" title="Show ${attr(s.label)}">
    <span class="os-avatar ${esc(s.accent || '')} dim">${osLogo(s.agent, s.label)}</span>
    <span class="os-agent-meta"><b>${esc(s.label)}</b><em>hidden — click to restore</em></span>
    <span class="os-show-ico">+</span>
  </button>`;
}

function osAgentTile(s) {
  if (!s) return '';
  const stats = s.agent === 'memory' && (s.graphStats || agentOsData?.brain?.graph)
    ? `<div class="os-tile-stats">${osMetric((s.graphStats || agentOsData?.brain?.graph).accounts || 0, 'accounts')}${osMetric((s.graphStats || agentOsData?.brain?.graph).hubs || 0, 'hubs')}</div>`
    : '';
  const detail = s.agent === 'free-claude-code'
    ? (s.needsLogin ? 'login needed' : (s.version || 'ready'))
    : s.agent === 'n2-agent'
      ? (s.reachable ? 'router live' : osTitleCase(s.state))
      : s.url || s.detail || osTitleCase(s.state);
  return `<button class="os-agent-tile ${s.agent === agentOsSelected ? 'selected' : ''}" type="button" data-agent-key="${attr(s.agent)}">
    <div class="os-tile-top"><span class="os-avatar ${esc(s.accent || '')}">${osLogo(s.agent, s.label)}</span><i class="${osTone(s.state)}"></i></div>
    <b>${esc(s.label)}</b>
    <span>${esc(s.role || '')}</span>
    <em>${esc(detail || '')}</em>
    ${stats}
    <span class="os-hide-btn tile" data-os-hide="${attr(s.agent)}" role="button" tabindex="0" title="Hide ${attr(s.label)}" aria-label="Hide ${attr(s.label)}">&times;</span>
  </button>`;
}

function osBrainRail(brain = {}) {
  const goals = safeArray(brain.goals).map(osGoalHtml).join('');
  const journal = safeArray(brain.journal).map((j) => `<li>${esc(j)}</li>`).join('');
  const skills = brain.skills || {};
  const skillRows = safeArray(skills.rows).slice(0, 6).map((s) => `<span>${esc(s.name)}</span>`).join('');
  return `<div class="os-brain-head"><span class="os-eyebrow">Brain</span><b>Self Layer</b></div>
    <section class="os-brain-section">${goals || '<div class="os-muted">No goals yet.</div>'}</section>
    <section class="os-brain-section">
      <div class="os-card-title">Journal</div>
      <ul class="os-journal">${journal || '<li>No journal lines yet.</li>'}</ul>
    </section>
    <section class="os-brain-section">
      <div class="os-card-title">Memory Search</div>
      <input class="os-memory-search" placeholder="Search local context" oninput="agentOsMemorySearch(this.value)">
      <div id="os-memory-results" class="os-memory-results">${osMemorySearchResults('')}</div>
    </section>
    <section class="os-brain-section">
      <div class="os-card-title">Skills</div>
      <div class="os-skill-meter"><b>${esc(skills.available || 0)}</b><span>/ ${esc(skills.total || 0)} available</span></div>
      <div class="os-mini-tags">${skillRows || '<span>none</span>'}</div>
    </section>`;
}

function osGoalHtml(g) {
  const progress = Math.max(0, Math.min(100, Number(g.progress || 0)));
  return `<div class="os-goal">
    <div><b>${esc(g.label)}</b><span>${esc(g.value || 0)} / ${esc(g.total || 0)}</span></div>
    <i><span style="width:${progress}%"></span></i>
  </div>`;
}

function osMemorySearchResults(q) {
  const brain = agentOsData?.brain || {};
  const hay = [
    ...safeArray(brain.memory?.priority).map((x) => ({ type: 'account', title: x.name, body: x.whyNow || x.next_action || '', href: `#/account/${x.id}` })),
    ...safeArray(brain.memory?.recentSignals).map((x) => ({ type: 'signal', title: x.account_name || 'Signal', body: x.label || x.detail || '', href: '#/signals' })),
    ...safeArray(brain.memory?.queued).map((x) => ({ type: 'queue', title: x.account_name || 'Queue', body: x.why_now || x.contact_name || '', href: '#/queue' })),
  ];
  const needle = String(q || '').trim().toLowerCase();
  const rows = hay.filter((x) => !needle || `${x.type} ${x.title} ${x.body}`.toLowerCase().includes(needle)).slice(0, 7);
  return rows.map((x) => `<a href="${attr(x.href)}"><span>${esc(x.type)}</span><b>${esc(x.title)}</b><em>${esc(x.body || '')}</em></a>`).join('') || '<div class="os-muted">No matching local context.</div>';
}
function osTone(state = '') {
  const s = String(state).toLowerCase();
  if (/online|connected|ready|active|configured|available|local/.test(s)) return 'good';
  if (/missing|offline|not[- ]installed|error/.test(s)) return 'bad';
  return 'warn'; // installed-not-running, needs_api_key_or_router, external, standby
}
function osTitleCase(v) {
  return String(v || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}
function osStatusChip(label, state) {
  return `<span class="os-status-chip ${osTone(state)}"><i></i>${esc(label)}: ${esc(osTitleCase(state || 'unknown'))}</span>`;
}
function osSystemLine(label, state, port) {
  return `<div class="os-system-line"><span class="os-dot ${osTone(state)}"></span><b>${esc(label)}</b><em>${port ? ':' + esc(port) : esc(osTitleCase(state || ''))}</em></div>`;
}
function osMetric(n, label) {
  return `<div><b>${esc(n)}</b><span>${esc(label)}</span></div>`;
}
function agentOsRefreshInternal() { return renderAgentOs(agentOsSelected); }
window.agentOsRefresh = agentOsRefreshInternal;
// Route the central workspace into the selected agent's real surface. Re-probes
// live for local agents so the state is current, and writes a shareable URL
// (#/agent-os/<key>) without re-rendering the whole shell.
async function selectAgentInternal(key, reprobe = true) {
  agentOsSelected = key;
  const targetHash = '#/agent-os/' + key;
  if (location.hash !== targetHash) {
    history.replaceState(null, '', targetHash);
    lastObservedHash = targetHash;
  }
  document.querySelectorAll('.os-agent-row').forEach((r) => r.classList.toggle('selected', r.dataset.agentKey === key));
  document.querySelectorAll('.os-agent-tile').forEach((r) => r.classList.toggle('selected', r.dataset.agentKey === key));
  const host = document.getElementById('os-surface');
  if (!host) return;
  let surface = agentOsSurfaces[key];
  if (reprobe && OS_LIVE_KEYS.includes(key)) {
    host.innerHTML = osSurfaceLoading('Checking ' + (surface?.label || key) + '…');
    try { surface = await api('/agent-os/surfaces/' + key); agentOsSurfaces[key] = surface; } catch (e) { /* keep cached */ }
    const dot = document.querySelector('.os-agent-row[data-agent-key="' + key + '"] i');
    if (dot && surface) dot.className = osTone(surface.state);
  }
  host.innerHTML = osSurfaceHtml(surface);
  bindCopyButtons();
  if (surface && surface.agent === 'n2-agent') ensureN2Models();
}
window.selectAgent = selectAgentInternal;
window.agentOsRecheck = (key) => selectAgentInternal(key, true);

// Lazily load the free/low-cost model list for the N2 picker, then refresh the
// panel's datalist if it's still open.
async function ensureN2Models() {
  if (n2Models) return;
  try { const r = await api('/agent-os/n2/models'); n2Models = r.models || []; }
  catch { n2Models = []; }
  if (agentOsSelected === 'n2-agent') {
    const host = document.getElementById('os-surface');
    if (host && agentOsSurfaces['n2-agent']) { host.innerHTML = osN2Panel(agentOsSurfaces['n2-agent']); bindCopyButtons(); }
  }
}

// Free Claude Code — full-access, multi-turn terminal. Streams stream-json
// events from the CLI, captures the session id for resume, and renders text +
// tool calls like the real TUI.
let claudeAbort = null;
function renderClaudeTerm() {
  const el = document.getElementById('os-cc-term');
  if (!el) return;
  el.innerHTML = osClaudeTermHtml();
  el.scrollTop = el.scrollHeight;
  bindCopyButtons();
}
function renderClaudePanel() {
  if (agentOsSelected !== 'free-claude-code') return;
  const host = document.getElementById('os-surface');
  if (host) { host.innerHTML = osClaudeCodePanel(agentOsSurfaces['free-claude-code'] || {}); bindCopyButtons(); }
}
function applyCcEvent(ev) {
  if (!claudeSession || !ev || typeof ev !== 'object') return;
  const t = claudeSession.turns;
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.session_id) claudeSession.id = ev.session_id;
  } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text) t.push({ kind: 'text', text: c.text });
      else if (c.type === 'tool_use') t.push({ kind: 'tool', name: c.name, input: c.input || {} });
    }
  } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'tool_result') {
        const text = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('') : (c.content || '');
        t.push({ kind: 'tool_result', text: String(text).slice(0, 6000), isError: !!c.is_error });
      }
    }
  } else if (ev.type === 'result') {
    if (ev.session_id) claudeSession.id = ev.session_id;
    t.push({ kind: 'result', numTurns: ev.num_turns, duration: ev.duration_ms, cost: ev.total_cost_usd });
    if (ev.subtype && ev.subtype !== 'success' && ev.result) t.push({ kind: 'error', text: String(ev.result) });
  }
}
async function agentOsClaudeRunInternal(ev) {
  ev.preventDefault();
  const form = ev.target.closest('form') || ev.target;
  const prompt = String(form.prompt.value || '').trim();
  if (!prompt) return toast('Enter a prompt for Claude Code', true);
  if (!claudeSession) claudeSession = { id: null, turns: [], running: false };
  if (claudeSession.running) return;
  if (claudeAbort) { try { claudeAbort.abort(); } catch { /* ignore */ } }
  claudeAbort = new AbortController();
  claudeSession.turns.push({ kind: 'user', text: prompt });
  claudeSession.running = true;
  form.prompt.value = '';
  renderClaudePanel();
  try {
    const res = await fetch('/api/agent-os/claude-code/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, sessionId: claudeSession.id }), signal: claudeAbort.signal,
    });
    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({}));
      claudeSession.turns.push({ kind: 'error', text: e.error || ('HTTP ' + res.status) });
      claudeSession.running = false;
      return renderClaudePanel();
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let ccStderr = '';
    const turnStart = claudeSession.turns.length;
    for (;;) {
      const { value, done } = await reader.read(); // eslint-disable-line no-await-in-loop
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.t === 'cc') applyCcEvent(m.event);
        else if (m.t === 'out' && m.d) claudeSession.turns.push({ kind: 'text', text: m.d });
        else if (m.t === 'err' && m.d) ccStderr += m.d;
        else if (m.t === 'error') claudeSession.turns.push({ kind: 'error', text: m.message });
        renderClaudeTerm();
      }
    }
    // If the CLI produced no visible output for this turn, don't leave it blank —
    // surface whatever it wrote to stderr (auth/login errors land here).
    if (claudeSession.turns.length === turnStart && ccStderr.trim()) {
      claudeSession.turns.push({ kind: 'error', text: ccStderr.trim() });
    }
  } catch (e) {
    if (e.name === 'AbortError') claudeSession.turns.push({ kind: 'error', text: 'Stopped.' });
    else claudeSession.turns.push({ kind: 'error', text: e.message });
  } finally {
    if (claudeSession) claudeSession.running = false;
    claudeAbort = null;
    renderClaudePanel();
  }
}
window.agentOsClaudeRun = agentOsClaudeRunInternal;
function agentOsClaudeStop() { if (claudeAbort) { try { claudeAbort.abort(); } catch { /* ignore */ } } }
function agentOsClaudeNew() {
  if (claudeSession?.running) return toast('Stop the current run first', true);
  claudeSession = { id: null, turns: [], running: false };
  renderClaudePanel();
}

// Gemini CLI — stream a turn's plain-text output into the panel; multi-turn via
// resume of the latest CLI session.
let geminiAbort = null;
function renderGeminiTerm() {
  const el = document.getElementById('os-gem-term');
  if (!el) return;
  el.innerHTML = osGeminiTermHtml();
  el.scrollTop = el.scrollHeight;
}
function renderGeminiPanel() {
  if (agentOsSelected !== 'gemini') return;
  const host = document.getElementById('os-surface');
  if (host) { host.innerHTML = osGeminiPanel(agentOsSurfaces['gemini'] || {}); bindCopyButtons(); }
}
async function agentOsGeminiSendInternal(ev) {
  ev.preventDefault();
  const form = ev.target.closest('form') || ev.target;
  const prompt = String(form.prompt.value || '').trim();
  if (!prompt) return toast('Enter a message for Gemini', true);
  if (!geminiSession) geminiSession = { turns: [], running: false, started: false };
  if (geminiSession.running) return;
  const yolo = !!form.yolo?.checked;
  if (geminiAbort) { try { geminiAbort.abort(); } catch { /* ignore */ } }
  geminiAbort = new AbortController();
  geminiSession.turns.push({ kind: 'user', text: prompt });
  const reply = { kind: 'bot', text: '' };
  geminiSession.turns.push(reply);
  geminiSession.running = true;
  form.prompt.value = '';
  renderGeminiPanel();
  try {
    const res = await fetch('/api/agent-os/gemini/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, yolo, resume: !!geminiSession.started }), signal: geminiAbort.signal,
    });
    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({}));
      reply.kind = 'error'; reply.text = e.error || ('HTTP ' + res.status);
      geminiSession.running = false; return renderGeminiPanel();
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let stderr = '';
    for (;;) {
      const { value, done } = await reader.read(); // eslint-disable-line no-await-in-loop
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.t === 'out' && m.d) { reply.text += m.d; geminiSession.started = true; }
        else if (m.t === 'err' && m.d) { stderr += m.d; }
        else if (m.t === 'error') { reply.kind = 'error'; reply.text += (reply.text ? '\n' : '') + m.message; }
        else if (m.t === 'done' && m.code && !reply.text.trim()) { reply.kind = 'error'; reply.text = stderr.trim() || ('Gemini exited with code ' + m.code); }
        renderGeminiTerm();
      }
    }
    if (!reply.text.trim()) { reply.text = stderr.trim() || '(no output)'; if (stderr.trim()) reply.kind = 'error'; }
  } catch (e) {
    reply.kind = 'error';
    reply.text = e.name === 'AbortError' ? 'Stopped.' : e.message;
  } finally {
    if (geminiSession) geminiSession.running = false;
    geminiAbort = null;
    renderGeminiPanel();
  }
}
window.agentOsGeminiSend = agentOsGeminiSendInternal;
function agentOsGeminiStop() { if (geminiAbort) { try { geminiAbort.abort(); } catch { /* ignore */ } } }
function agentOsGeminiNew() {
  if (geminiSession?.running) return toast('Stop the current run first', true);
  geminiSession = { turns: [], running: false, started: false };
  renderGeminiPanel();
}

// N2 Agent — send one turn through the configured router and append the reply.
async function agentOsN2SendInternal(ev) {
  ev.preventDefault();
  const form = ev.target.closest('form') || ev.target;
  const prompt = String(form.prompt.value || '').trim();
  if (!prompt) return;
  const model = String(form.model?.value || '').trim() || undefined;
  const history = n2History.slice(-8);
  n2History.push({ role: 'user', content: prompt });
  form.prompt.value = '';
  const thread = document.getElementById('os-n2-thread');
  const pending = { role: 'assistant', content: '…' };
  n2History.push(pending);
  if (thread) { thread.innerHTML = n2History.map(osN2Bubble).join(''); thread.scrollTop = thread.scrollHeight; }
  try {
    const r = await api('/agent-os/n2/chat', 'POST', { prompt, history, model });
    pending.content = r.reply || '(empty response)';
  } catch (e) {
    pending.content = 'Error: ' + e.message;
  }
  const thread2 = document.getElementById('os-n2-thread');
  if (thread2) { thread2.innerHTML = n2History.map(osN2Bubble).join(''); thread2.scrollTop = thread2.scrollHeight; }
}
window.agentOsN2Send = agentOsN2SendInternal;
function agentOsN2ClearInternal() {
  n2History = [];
  const thread = document.getElementById('os-n2-thread');
  if (thread) thread.innerHTML = '<span class="os-muted">Cleared.</span>';
}
window.agentOsN2Clear = agentOsN2ClearInternal;

async function agentOsCouncilInternal(ev) {
  ev.preventDefault();
  const form = ev.target.closest('form') || ev.target;
  const idea = String(form.idea.value || '').trim();
  if (!idea) return toast('Enter an idea for the council', true);
  councilLastRun = { running: true };
  const out = document.getElementById('os-council-out');
  if (out) out.innerHTML = osCouncilResultHtml(councilLastRun);
  try {
    councilLastRun = await api('/agent-os/council', 'POST', { idea });
  } catch (e) {
    councilLastRun = { error: e.message };
  }
  const out2 = document.getElementById('os-council-out');
  if (out2) out2.innerHTML = osCouncilResultHtml(councilLastRun);
}
window.agentOsCouncil = agentOsCouncilInternal;

function agentOsCouncilSample(text) {
  const form = document.querySelector('.os-council-form');
  if (!form) return;
  form.idea.value = text;
  form.idea.focus();
}
window.agentOsCouncilSample = agentOsCouncilSample;

function agentOsMemorySearchInternal(q) {
  const out = document.getElementById('os-memory-results');
  if (out) out.innerHTML = osMemorySearchResults(q);
}
window.agentOsMemorySearch = agentOsMemorySearchInternal;
// Start a real local surface (Hermes) and poll until it's serving, then embed it.
async function agentOsStartInternal(key) {
  const host = document.getElementById('os-surface');
  const label = agentOsSurfaces[key]?.label || key;
  if (host) host.innerHTML = osSurfaceLoading('Starting ' + label + '…');
  try { await api('/agent-os/surfaces/' + key + '/start', 'POST', {}); }
  catch (e) { toast(e.message, true); }
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const s = await api('/agent-os/surfaces/' + key);
      agentOsSurfaces[key] = s;
      if (s.state === 'connected') { toast(label + ' is up'); return selectAgentInternal(key, false); }
    } catch (e) { /* keep polling */ }
  }
  toast(label + ' is taking a while to start — try Re-check.', true);
  selectAgentInternal(key, false);
}
window.agentOsStart = agentOsStartInternal;

// ---------- CALL QUEUE ----------
function queueStatusTone(s) {
  if (s === 'done' || s === 'connected') return 'green';
  if (s === 'skipped') return 'red';
  if (s === 'dialed') return 'yellow';
  return 'gray';
}
async function renderQueue() {
  const list = await api('/queue');
  const rows = list.map((q) => {
    const c = q.contact;
    const who = c
      ? `<b>${esc(c.name || 'Unknown')}</b><br><span class="muted">${esc(c.title || c.persona_role || '')}</span>`
      : '<span class="muted">no contact</span>';
    const reach = c
      ? [c.phone ? esc(c.phone) : '', c.linkedin ? `<a href="${esc(c.linkedin)}" target="_blank">LinkedIn</a>` : '', c.email ? esc(c.email) : ''].filter(Boolean).join(' · ')
      : '';
    return `<tr>
      <td>${q.rank + 1}</td>
      <td>${pill(q.account.score)}</td>
      <td class="clickable" onclick="location.hash='#/account/${q.account.id}'"><b>${esc(q.account.name)}</b><br><span class="muted">${esc(q.account.domain || '')}</span></td>
      <td>${who}</td>
      <td>${reach || '<span class="muted">—</span>'}</td>
      <td>${esc(q.whyNow || 'Needs research')}</td>
      <td>${badge(q.status, queueStatusTone(q.status))}</td>
      <td><select class="sm" onchange="setQueueStatus(${q.id}, this.value)">${opts2(['queued','dialed','connected','done','skipped'], q.status)}</select></td>
    </tr>`;
  }).join('');
  view.innerHTML = `
    <div class="toolbar">
      <button class="btn primary" onclick="rebuildQueue()">Rebuild queue</button>
      <button class="btn" onclick="syncSheet()">Sync dial sheet</button>
      <span class="spacer"></span>
      <span class="muted">${list.length} contacts queued</span>
    </div>
    <h2>Call queue</h2>
      <p class="muted">Top-band accounts → top callable contacts, in dial order. This is what the optional Google Sheet and call cockpit read. Only contacts with a phone on workable accounts are queued.</p>
    <table class="queue"><thead><tr><th>#</th><th>Score</th><th>Account</th><th>Contact</th><th>Reach</th><th>Why now</th><th>Status</th><th>Set</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="empty">Queue empty. Click “Rebuild queue” once accounts have callable contacts (phone + top band).</td></tr>'}</tbody></table>`;
}
window.rebuildQueue = async () => { busy(true); try { const r = await api('/queue/rebuild', 'POST', {}); toast(`Queued ${r.queued} contacts from ${r.accounts} accounts`); render(); } catch (e) { toast(e.message, true); } busy(false); };
window.setQueueStatus = async (id, status) => { try { await api(`/queue/${id}/status`, 'POST', { status }); toast('Status updated'); } catch (e) { toast(e.message, true); } };
window.syncSheet = async () => { busy(true); try { const r = await api('/sheet/sync', 'POST', {}); toast(r.message || `Synced ${r.count || 0} rows`); } catch (e) { toast(e.message, true); } busy(false); };

// ---------- MEMORY MAP (Obsidian-style force-directed graph) ----------
const mapFilter = { bands: [], tech: true, limit: 150 };
const MAP_BANDS = [['work_today', 'Work today'], ['sequence_week', 'Sequence'], ['research_more', 'Research']];
function nodeColor(n) {
  if (n.type === 'account') return ({ work_today: '#3fb950', sequence_week: '#d29922', research_more: '#58a6ff' }[n.band] || '#6e7681');
  if (n.type === 'trigger') return '#e3b341';
  if (n.type === 'tech') return '#56607a';
  return ({ department_head: '#f0883e', decision_maker: '#f0883e', manager: '#a371f7', end_user: '#2dd4bf' }[n.persona] || '#8b949e');
}
function nodeRadius(n) {
  if (n.type === 'account') return 5 + Math.max(0, Math.min(140, n.score || 0)) / 14;
  if (n.type === 'tech' || n.type === 'trigger') return 5 + Math.min(14, n.count || 1) * 0.9;
  return 4;
}
const trimLabel = (s) => { s = String(s || ''); return s.length > 26 ? s.slice(0, 25) + '…' : s; };

async function renderMap() {
  const bandChecks = MAP_BANDS.map(([v, l]) => `<label><input type="checkbox" value="${v}" ${mapFilter.bands.includes(v) ? 'checked' : ''} onchange="mapToggleBand('${v}',this.checked)"> ${l}</label>`).join('');
  view.innerHTML = `<style>
    .map-wrap{position:relative;height:74vh;min-height:520px;border:1px solid #30363d;border-radius:12px;overflow:hidden;background:#0b0e14}
    #mapCanvas{width:100%;height:100%;display:block;cursor:grab}
    .map-toolbar{position:absolute;top:10px;left:10px;right:10px;z-index:3;display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:rgba(13,17,23,.82);backdrop-filter:blur(6px);border:1px solid #30363d;border-radius:10px;padding:7px 11px}
    .map-toolbar label{display:flex;align-items:center;gap:4px;font-size:12px;color:#c9d1d9;cursor:pointer}
    .map-toolbar input[type=number]{width:60px;background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:3px 6px}
    .map-toolbar .btn{padding:4px 10px}
    .map-stat{margin-left:auto;color:#8b949e;font-size:12px}
    .map-legend{position:absolute;bottom:10px;left:10px;z-index:3;display:flex;gap:14px;flex-wrap:wrap;background:rgba(13,17,23,.82);border:1px solid #30363d;border-radius:10px;padding:7px 11px;font-size:12px;color:#8b949e}
    .map-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:middle}
    .map-legend b{display:inline-block;width:11px;height:11px;border-radius:50%;border:2px solid #fff;margin-right:5px;vertical-align:middle}
    .map-tip{position:absolute;z-index:4;pointer-events:none;display:none;max-width:240px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:7px 9px;font-size:12px;color:#e6edf3;box-shadow:0 6px 20px rgba(0,0,0,.5)}
    .map-hint{position:absolute;top:10px;right:14px}
  </style>
  <div class="map-wrap">
    <div class="map-toolbar">
      <span style="font-weight:700">Memory Map</span>
      ${bandChecks}
      <label><input type="checkbox" ${mapFilter.tech ? 'checked' : ''} onchange="mapToggleTech(this.checked)"> Tech hubs</label>
      <label>Max <input type="number" min="10" max="400" value="${mapFilter.limit}" onchange="mapSetLimit(this.value)"></label>
      <button class="btn" onclick="mapReheat()">Reheat</button>
      <span class="map-stat" id="mapStat">loading…</span>
    </div>
    <canvas id="mapCanvas"></canvas>
    <div class="map-legend">
      <span><i style="background:#3fb950"></i>Work today</span>
      <span><i style="background:#d29922"></i>Sequence</span>
      <span><i style="background:#58a6ff"></i>Research</span>
      <span><i style="background:#f0883e"></i>Buyer</span>
      <span><i style="background:#a371f7"></i>Manager</span>
      <span><i style="background:#2dd4bf"></i>IC</span>
      <span><i style="background:#e3b341"></i>Trigger</span>
      <span><i style="background:#56607a"></i>Tech</span>
      <span><b style="background:transparent"></b>In call queue</span>
    </div>
    <div id="mapTip" class="map-tip"></div>
  </div>`;
  await mapLoad();
}
let mapController = null;
window.mapToggleBand = (v, on) => { mapFilter.bands = on ? [...new Set([...mapFilter.bands, v])] : mapFilter.bands.filter((b) => b !== v); mapLoad(); };
window.mapToggleTech = (on) => { mapFilter.tech = on; mapLoad(); };
window.mapSetLimit = (v) => { mapFilter.limit = Math.max(10, Math.min(400, Number(v) || 150)); mapLoad(); };
window.mapReheat = () => mapController && mapController.reheat();

async function mapLoad() {
  if (mapController) { mapController.stop(); mapController = null; }
  const qs = `?limit=${mapFilter.limit}&tech=${mapFilter.tech}` + (mapFilter.bands.length ? `&bands=${mapFilter.bands.join(',')}` : '');
  const data = await api('/graph' + qs);
  const stat = document.getElementById('mapStat');
  if (stat) stat.textContent = `${data.stats.accounts} accounts · ${data.stats.contacts} people · ${data.stats.hubs} hubs · ${data.stats.queued} queued`;
  if (!data.nodes.length) { if (stat) stat.textContent = 'No nodes — adjust filters or import accounts.'; return; }
  mapController = startGraph(data);
  stopMap = mapController.stop;
}

function startGraph(data) {
  const canvas = document.getElementById('mapCanvas');
  const tip = document.getElementById('mapTip');
  const ctx = canvas.getContext('2d');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  let W = 0, H = 0;

  const nodes = data.nodes.map((n) => ({ ...n, r: nodeRadius(n) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.map((e) => ({ source: byId.get(e.source), target: byId.get(e.target), kind: e.kind })).filter((e) => e.source && e.target);
  const adj = new Map(nodes.map((n) => [n.id, new Set()]));
  edges.forEach((e) => { adj.get(e.source.id).add(e.target.id); adj.get(e.target.id).add(e.source.id); });
  nodes.forEach((n, i) => { const ang = i * 2.399; const rad = 26 * Math.sqrt(i); n.x = Math.cos(ang) * rad; n.y = Math.sin(ang) * rad; n.vx = 0; n.vy = 0; });

  const t = { x: 0, y: 0, k: 1 };
  let alpha = 1, running = true, raf = 0, fitted = false;
  let hover = null, drag = null, panning = false, last = { x: 0, y: 0 }, moved = false;

  let centered = false;
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === W && h === H) return; // self-healing: only resize the buffer when the CSS box actually changes
    W = w; H = h;
    canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!centered && W > 0 && H > 0) { t.x = W / 2; t.y = H / 2; centered = true; }
  }
  resize();
  const reheat = () => { alpha = Math.max(alpha, 0.6); };

  function step() {
    const repel = 3200, spring = 0.04, damp = 0.85, grav = 0.009;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
        if (d2 > 160000) continue;
        const d = Math.sqrt(d2), f = repel / d2, fx = dx / d * f, fy = dy / d * f;
        a.vx += fx * alpha; a.vy += fy * alpha; b.vx -= fx * alpha; b.vy -= fy * alpha;
      }
    }
    for (const e of edges) {
      const rest = e.kind === 'tech' ? 150 : (e.kind === 'trigger' ? 130 : 74);
      let dx = e.target.x - e.source.x, dy = e.target.y - e.source.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - rest) * spring, fx = dx / d * f, fy = dy / d * f;
      e.source.vx += fx * alpha; e.source.vy += fy * alpha; e.target.vx -= fx * alpha; e.target.vy -= fy * alpha;
    }
    for (const n of nodes) {
      n.vx += -n.x * grav * alpha; n.vy += -n.y * grav * alpha;
      if (n === drag) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= damp; n.vy *= damp; n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.99; if (alpha < 0.02) alpha = 0;
  }

  const S = (n) => ({ x: n.x * t.k + t.x, y: n.y * t.k + t.y });
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, W, H);
    const hl = hover ? adj.get(hover.id) : null;
    ctx.lineWidth = 1;
    for (const e of edges) {
      const s = S(e.source), d = S(e.target);
      let a = 0.12, col = '#30363d';
      if (hover) { const on = e.source.id === hover.id || e.target.id === hover.id; a = on ? 0.6 : 0.035; if (on) col = '#58a6ff'; }
      ctx.strokeStyle = col; ctx.globalAlpha = a;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const rk = Math.max(0.6, Math.min(2.2, t.k));
    for (const n of nodes) {
      const s = S(n), rr = n.r * rk;
      if (s.x < -40 || s.x > W + 40 || s.y < -40 || s.y > H + 40) continue;
      const inSet = !hover || n.id === hover.id || (hl && hl.has(n.id));
      const col = nodeColor(n);
      ctx.globalAlpha = inSet ? 1 : 0.22;
      if (n === hover || n === drag || (n.queued && inSet)) { ctx.shadowColor = col; ctx.shadowBlur = 14; } else ctx.shadowBlur = 0;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(s.x, s.y, rr, 0, 6.2832); ctx.fill();
      ctx.shadowBlur = 0;
      if (n.queued) { ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = inSet ? 0.9 : 0.22; ctx.beginPath(); ctx.arc(s.x, s.y, rr + 2.6, 0, 6.2832); ctx.stroke(); }
      const showLabel = inSet && (n === hover || (hl && hl.has(n.id)) || t.k > 1.35 || (n.type === 'account' && n.score >= 90) || n.type === 'tech');
      if (showLabel) {
        ctx.globalAlpha = inSet ? 1 : 0.3; ctx.textAlign = 'center';
        ctx.font = (n.type === 'account' ? '600 11px ' : '11px ') + '-apple-system,Segoe UI,Roboto,sans-serif';
        ctx.lineWidth = 3; ctx.strokeStyle = '#0b0e14'; ctx.strokeText(trimLabel(n.label), s.x, s.y + rr + 11);
        ctx.fillStyle = '#c9d1d9'; ctx.fillText(trimLabel(n.label), s.x, s.y + rr + 11);
      }
    }
    ctx.globalAlpha = 1;
  }
  function fit() {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY), pad = 80;
    t.k = Math.max(0.15, Math.min(2.0, Math.min((W - pad) / spanX, (H - pad) / spanY)));
    t.x = W / 2 - (minX + maxX) / 2 * t.k; t.y = H / 2 - (minY + maxY) / 2 * t.k;
  }
  function frame() {
    if (!running) return;
    resize();
    if (alpha > 0) step();
    if (!fitted && W > 0 && alpha < 0.12) { fitted = true; fit(); } // one-time zoom-to-fit once settled
    draw();
    raf = requestAnimationFrame(frame);
  }
  frame();

  function evPos(e) { const r = canvas.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; return { mx, my, wx: (mx - t.x) / t.k, wy: (my - t.y) / t.k, inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom }; }
  function pick(mx, my) { let best = null, bd = 1e9; const rk = Math.max(0.6, Math.min(2.2, t.k)); for (const n of nodes) { const s = S(n); const rr = n.r * rk + 4; const dx = s.x - mx, dy = s.y - my, d = dx * dx + dy * dy; if (d <= rr * rr && d < bd) { bd = d; best = n; } } return best; }
  function tipHtml(n) {
    if (n.type === 'account') return `<b>${esc(n.label)}</b><br>${esc((n.band || '').replace(/_/g, ' '))} · score ${esc(n.score)}${n.queued ? ' · in queue' : ''}<br><span class="muted">click to open account</span>`;
    if (n.type === 'tech') return `<b>${esc(n.label)}</b><br>${esc(n.count)} accounts use this`;
    return `<b>${esc(n.label)}</b><br>${esc(n.title || '')}${n.queued ? '<br><span class="muted">in call queue</span>' : ''}<br><span class="muted">click to open account</span>`;
  }
  function onDown(e) { const p = evPos(e); if (!p.inside) return; const n = pick(p.mx, p.my); moved = false; last = { x: e.clientX, y: e.clientY }; if (n) { drag = n; n.x = p.wx; n.y = p.wy; reheat(); } else { panning = true; canvas.style.cursor = 'grabbing'; } }
  function onMove(e) {
    if (drag) { const p = evPos(e); drag.x = p.wx; drag.y = p.wy; drag.vx = 0; drag.vy = 0; moved = true; reheat(); return; }
    if (panning) { t.x += e.clientX - last.x; t.y += e.clientY - last.y; last = { x: e.clientX, y: e.clientY }; moved = true; return; }
    const p = evPos(e); if (!p.inside) { if (hover) { hover = null; tip.style.display = 'none'; } return; }
    const n = pick(p.mx, p.my); hover = n; canvas.style.cursor = n ? 'pointer' : 'grab';
    if (n) { tip.style.display = 'block'; tip.style.left = (p.mx + 14) + 'px'; tip.style.top = (p.my + 12) + 'px'; tip.innerHTML = tipHtml(n); } else tip.style.display = 'none';
  }
  function onUp() { drag = null; panning = false; canvas.style.cursor = 'grab'; }
  function onClick(e) { if (moved) { moved = false; return; } const p = evPos(e); const n = pick(p.mx, p.my) || hover; if (n && n.type !== 'tech' && n.accountId) location.hash = '#/account/' + n.accountId; }
  function onWheel(e) { e.preventDefault(); const p = evPos(e); const f = Math.exp(-e.deltaY * 0.0015); t.k = Math.max(0.15, Math.min(4, t.k * f)); t.x = p.mx - p.wx * t.k; t.y = p.my - p.wy * t.k; }
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function stop() { running = false; cancelAnimationFrame(raf); canvas.removeEventListener('mousedown', onDown); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); canvas.removeEventListener('click', onClick); canvas.removeEventListener('wheel', onWheel); }
  return { stop, reheat };
}

// ---------- CONTACTS ----------
async function renderContacts() {
  const list = await api('/contacts');
  const rows = list.map((c) => `<tr class="clickable" onclick="location.hash='#/account/${c.account_id}'">
    <td><b>${esc(c.name)}</b></td><td>${esc(c.title || '')}</td>
    <td>${esc((c.persona_level||'').replace(/_/g,' '))} <span class="muted">${esc(c.persona_role||'')}</span></td>
    <td>${esc(c.account_name)}</td><td>${esc(c.email||'')}</td><td>${esc(c.phone||'')}</td>
    <td>${c.linkedin?`<a href="${esc(c.linkedin)}" target="_blank">↗</a>`:''}</td><td>${c.confidence}</td><td class="muted">${esc(c.source||'')}</td>
  </tr>`).join('');
  view.innerHTML = `<h2>All contacts (${list.length})</h2>
    <table><thead><tr><th>Name</th><th>Title</th><th>Persona</th><th>Account</th><th>Email</th><th>Phone</th><th>LinkedIn</th><th>Conf</th><th>Source</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="9" class="empty">No contacts yet.</td></tr>'}</tbody></table>`;
}

// ---------- SIGNALS ----------
async function renderSignals() {
  const list = await api('/signals');
  const rows = list.map((s) => `<tr class="clickable" onclick="location.hash='#/account/${s.account_id}'">
    <td>${badge(s.kind.replace(/_/g,' '), s.kind==='missing_data'?'red':'blue')}</td>
    <td>${esc(s.account_name)}</td><td>${esc(s.label)}</td><td class="muted">${esc(s.detail||'')}</td>
    <td>${esc(s.source||'')}</td><td>${s.confidence}</td><td class="muted">${esc(s.detected_at.slice(0,16))}</td>
  </tr>`).join('');
  view.innerHTML = `<h2>Signals (${list.length})</h2>
    <table><thead><tr><th>Kind</th><th>Account</th><th>Label</th><th>Detail</th><th>Source</th><th>Conf</th><th>Detected</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="empty">No signals yet.</td></tr>'}</tbody></table>`;
}

// ---------- EXPORTS ----------
async function renderExports() {
  const list = await api('/exports');
  const rows = list.map((e) => `<tr><td>${esc(e.target)}</td><td>${e.account_count} accts / ${e.contact_count} rows</td>
    <td class="muted">${esc(e.file_path||'')}</td><td class="muted">${esc(e.notes||'')}</td><td class="muted">${esc(e.created_at.slice(0,16))}</td></tr>`).join('');
  view.innerHTML = `
    <h2>Exports</h2>
    <div class="section">
      <h3>Download now (browser)</h3>
      <p class="muted">Provider exports are upload-ready people, account notes, call openers, personalization, and why-now. This dashboard writes CSVs only unless you explicitly enable push flags.</p>
      <div class="toolbar">
        <button class="btn primary" onclick="downloadExport('apollo')">Download Apollo CSV (ready_to_sequence)</button>
        <button class="btn primary" onclick="downloadExport('amplemarket')">Download Amplemarket CSV (ready_to_sequence)</button>
        <button class="btn" onclick="downloadExportAll('apollo')">Download Apollo CSV (all)</button>
        <button class="btn" onclick="downloadExportAll('amplemarket')">Download Amplemarket CSV (all)</button>
        <span class="spacer"></span>
        <button class="btn" onclick="writeReadyExport('apollo')">Write Apollo file + log</button>
        <button class="btn" onclick="writeReadyExport('amplemarket')">Write Amplemarket file + log</button>
      </div>
      <p class="muted">Tip: approve accounts on their detail page to include them in the “ready_to_sequence” export. Use the CSV file here and upload it through your provider's current import flow.</p>
    </div>
    <h2>Export history</h2>
    <table><thead><tr><th>Target</th><th>Size</th><th>File</th><th>Notes</th><th>When</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="empty">No exports yet.</td></tr>'}</tbody></table>`;
}
window.downloadExport = (t) => { window.location = `/api/export?target=${t}&status=ready_to_sequence`; };
window.downloadExportAll = async (t) => {
  const cards = await api('/accounts');
  const ids = cards.map((c) => c.id).join(',');
  window.location = `/api/export?target=${t}&ids=${ids}`;
};
window.writeReadyExport = async (t) => {
  const cards = await api('/accounts?status=ready_to_sequence');
  const ids = cards.map((c) => c.id).join(',');
  if (!ids) return toast('No ready_to_sequence accounts to export', true);
  const out = await api('/export', 'POST', { target: t, ids });
  toast(exportToast(t, out));
  render();
};
window.exportOne = async (id, t) => {
  const out = await api('/export', 'POST', { target: t, ids: String(id) });
  toast(exportToast(t, out));
  render();
};
function exportToast(t, out) {
  return `Wrote ${out.count} ${t} rows${out.skipped?.length ? ' (no contacts)' : ''}${out.file ? ' → ' + out.file : ''}`;
}

// ---------- CLOSEOUT ----------
async function renderCloseout() {
  const d = await api('/closeout');
  const review = d.criticalReview.map((x) => `<li>${esc(x)}</li>`).join('');
  const tasks = d.pendingTasks.map((x) => `<li>${esc(x)}</li>`).join('');
  const rows = d.top.map((x) => `<tr class="clickable" onclick="location.hash='#/account/${x.id}'">
    <td>${pill(x.score)}</td>
    <td><b>${esc(x.account)}</b><br><span class="muted">${esc(x.domain || '')}</span></td>
    <td>${x.firstContact ? esc(x.firstContact.name) + '<br><span class="muted">' + esc(x.firstContact.title || x.firstContact.persona_role || '') + '</span>' : '<span class="muted">map contact</span>'}</td>
    <td>${esc(x.whyNow || 'Needs research')}</td>
    <td>${esc(x.trust.rootly)}<br><span class="muted">PD: ${esc(x.trust.pagerduty)} · Stack: ${esc(x.trust.incidentStack)}</span></td>
    <td>${esc(x.trust.sequence)}</td>
    <td>${exportChips(x)}</td>
  </tr>`).join('');
  view.innerHTML = `
    <h2>Daily closeout</h2>
    <div class="tiles">
      ${tile(d.stats.total, 'Accounts')}
      ${tile(d.stats.workToday, 'Work today', 'green')}
      ${tile(d.stats.readyToSequence, 'Ready to sequence', 'yellow')}
      ${tile(d.stats.contacts, 'Contacts', 'blue')}
      ${tile(d.stats.blocked, 'Blocked', 'red')}
    </div>
    <div class="home-grid" style="margin-top:16px">
      <div class="section"><h3>Critical review & edits</h3><ul>${review}</ul></div>
      <div class="section"><h3>Pending / forgotten tasks</h3><ul>${tasks || '<li>No top-queue pending tasks.</li>'}</ul></div>
    </div>
    <div class="toolbar" style="margin:16px 0">
      <button class="btn primary" onclick="writeTopExport('apollo')">Write top 20 Apollo CSV</button>
      <button class="btn primary" onclick="writeTopExport('amplemarket')">Write top 20 Amplemarket CSV</button>
      <a class="btn" href="#/exports">Export history</a>
    </div>
    <table><thead><tr><th>Score</th><th>Account</th><th>Call first</th><th>Why now</th><th>Trust</th><th>Sequence disposition</th><th>Export</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}
window.writeTopExport = async (t) => {
  const d = await api('/closeout');
  const ids = d.top.map((x) => x.id).join(',');
  const out = await api('/export', 'POST', { target: t, ids });
  toast(exportToast(t, out));
  render();
};

// ---------- SETTINGS ----------
async function renderSettings() {
  const c = await api('/config');
  const providers = c.providers || [];
  const providerCards = providers.map(providerSettingsCard).join('');
  view.innerHTML = `<h2>Settings & status</h2>
    <div class="section"><div class="kv">
      <span class="k">Seller</span><span>${esc(c.seller.name)} @ ${esc(c.seller.company)}</span>
      <span class="k">Call notes</span><span>${c.llm === 'available' || c.gemini === 'configured' ? 'LLM-enhanced when a provider key is available' : 'Templates only (no LLM key)'}</span>
      <span class="k">Sumble</span><span>${esc(c.sumble)}</span>
      <span class="k">Common Room</span><span>${esc(c.commonRoom)}</span>
      <span class="k">Gemini</span><span>${esc(c.gemini)}</span>
      <span class="k">Apollo</span><span>${esc(c.apollo)}</span>
      <span class="k">Amplemarket</span><span>${esc(c.amplemarket)}</span>
      <span class="k">Browser research</span><span>${c.flags.browserResearch ? 'ON (live web/provider)' : 'OFF (local/offline, safe)'}</span>
      <span class="k">Apollo push</span><span>${c.flags.apolloPush ? 'ON' : 'OFF (CSV only)'}</span>
      <span class="k">Amplemarket push</span><span>${c.flags.amplemarketPush ? 'ON' : 'OFF (CSV only)'}</span>
    </div></div>
    <div class="section provider-settings"><h3>Provider API keys</h3>
      <p class="muted">Keys are stored locally on this machine and are never shown after save, logged, exported, or returned by the API. Environment variables still work as backup.</p>
      <div class="provider-settings-grid">${providerCards}</div>
    </div>
    <div class="section"><h3>How provider enrichment works</h3>
      <p class="muted">With zero keys, the dashboard keeps using local/demo workflows. With provider keys, account research can add stack, people, activity, and richer summaries. Provider failures are recorded as source-specific errors and the rest of the brief still renders.</p>
    </div>`;
}
function providerSettingsCard(p) {
  const id = `key-${p.provider}`;
  const label = providerLabel(p.provider);
  const isGemini = p.provider === 'gemini';
  const placeholder = isGemini ? 'Optional Gemini API key' : `${label} API key`;
  const adcHelp = isGemini ? `<div class="adc-help">
      <b>Google ADC supported</b>
      <span>For orgs that disallow API keys, run this once in a terminal:</span>
      <code>bash &lt;(curl -sSL https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)</code>
      <span>Then set <code>GOOGLE_CLOUD_PROJECT</code> in <code>.env</code> and restart the dashboard. Location defaults to <code>us-central1</code>.</span>
    </div>` : '';
  return `<div class="provider-card">
    <div class="provider-top">
      <b>${esc(label)}</b>
      <span class="provider-status ${esc(p.status)}">${esc(p.status)}</span>
    </div>
    <div class="muted">${esc(p.message || '')}${p.source && p.source !== 'none' ? ' · source: ' + esc(p.source) : ''}</div>
    ${adcHelp}
    <input type="password" id="${id}" autocomplete="off" placeholder="${esc(placeholder)}" />
    <div class="toolbar">
      <button class="btn primary" onclick="saveProviderKey('${p.provider}')">Save</button>
      <button class="btn" onclick="testProviderKey('${p.provider}')">Test connection</button>
      <button class="btn danger" onclick="clearProviderKey('${p.provider}')">Clear</button>
    </div>
  </div>`;
}
window.saveProviderKey = async (provider) => {
  const key = document.getElementById(`key-${provider}`).value;
  if (!key.trim()) return toast('Paste a key first, or use Clear to remove it', true);
  await api(`/provider-settings/${provider}`, 'POST', { key });
  document.getElementById(`key-${provider}`).value = '';
  toast(`${providerLabel(provider)} key saved`);
  render();
};
window.clearProviderKey = async (provider) => {
  await api(`/provider-settings/${provider}`, 'POST', { key: '' });
  toast(`${providerLabel(provider)} key cleared`);
  render();
};
window.testProviderKey = async (provider) => {
  busy(true);
  try {
    const status = await api(`/provider-settings/${provider}/test`, 'POST', {});
    toast(`${providerLabel(provider)}: ${status.status}${status.message ? ' — ' + status.message : ''}`, status.status === 'error');
    render();
  } catch (e) { toast(e.message, true); }
  busy(false);
};

// ---------- ACTIONS ----------
function busy(on) { view.classList.toggle('spin', on); }
async function refreshAccountResearch(id, { autoReason = '' } = {}) {
  busy(true);
  try {
    await api(`/accounts/${id}/research`, 'POST');
    toast(autoReason ? `Research refreshed (${autoReason})` : 'Research refreshed');
    await render();
  } catch (e) {
    toast(autoReason ? `Auto research failed: ${e.message}` : e.message, true);
  }
  busy(false);
}
window.runResearch = async (id) => refreshAccountResearch(id);
window.researchAll = async () => { busy(true); try { const r = await api('/research-all', 'POST', {}); toast(`Researched ${r.count} accounts`); render(); } catch (e) { toast(e.message, true); } busy(false); };
window.rescoreAll = async () => { await api('/rescore-all', 'POST', {}); toast('Scores recomputed'); render(); };
window.approve = async (id) => { await api(`/accounts/${id}/approve`, 'POST'); toast('Approved for sequencing'); render(); };
window.setStatus = async (id, status) => { await api(`/accounts/${id}/status`, 'POST', { status }); toast('Status updated'); };
window.setCustomer = async (id, field, value) => { await api(`/accounts/${id}`, 'PATCH', { [field]: value }); toast('Saved'); render(); };
window.genCallNotes = async (id) => { busy(true); try { await api(`/accounts/${id}/callnotes`, 'POST', {}); toast('Call notes generated (per contact)'); render(); } catch (e) { toast(e.message, true); } busy(false); };
window.genCallNotesFor = async (id, contactId) => { busy(true); try { const r = await api(`/accounts/${id}/callnotes`, 'POST', { contactId }); toast(`Card regenerated (${r.generated_by || 'template'})`); render(); } catch (e) { toast(e.message, true); } busy(false); };
window.genResearchBrief = async (id, contactId) => {
  busy(true);
  try {
    const r = await api(`/accounts/${id}/research-brief`, 'POST', { contactId });
    toast(`Research brief generated (${r.generated_by || 'template'})`);
    render();
  } catch (e) { toast(e.message, true); }
  busy(false);
};
window.genProviderBrief = async (id) => {
  busy(true);
  try {
    const r = await api(`/accounts/${id}/provider-brief`, 'POST', {});
    const summary = (r.provider_status || []).map((s) => `${providerLabel(s.provider)}: ${s.status}`).join(', ');
    toast(`Account brief updated${summary ? ': ' + summary : ''}`);
    render();
  } catch (e) { toast(e.message, true); }
  busy(false);
};
window.saveNotes = async (id) => { await api(`/accounts/${id}`, 'PATCH', { notes: document.getElementById('notes').value }); toast('Notes saved'); };
async function copyFromButton(button) {
  const text = button?.dataset?.copyText || '';
  if (!text) return toast('Nothing to copy', true);
  const now = Date.now();
  if (Number(button.dataset.copyAt || 0) + 350 > now) return;
  button.dataset.copyAt = String(now);
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1400);
    toast('Copied');
  } catch (e) {
    toast(`Copy failed: ${e.message}`, true);
  }
}
window.copyFromButton = copyFromButton;
function bindCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach((button) => {
    if (button.dataset.copyBound === 'true') return;
    button.dataset.copyBound = 'true';
    const copy = (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyFromButton(button);
    };
    button.addEventListener('click', copy);
    button.addEventListener('pointerdown', copy);
    button.addEventListener('mousedown', copy);
  });
}
window.addContact = async (id) => {
  const body = { name: val('c-name'), title: val('c-title'), email: val('c-email'), phone: val('c-phone'), linkedin: val('c-li'), source: 'manual' };
  if (!body.name && !body.email) return toast('name or email required', true);
  await api(`/accounts/${id}/contacts`, 'POST', body); toast('Contact added'); render();
};
window.addAccount = () => openImportModal('single');
window.clearAcctFilter = () => { acctFilter = {}; render(); };

// ---------- modal system ----------
function openModal(html) {
  const root = document.getElementById('modal-root');
  if (!root) return null;
  root.innerHTML = `<div class="modal-overlay" data-modal-overlay><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const overlay = root.querySelector('[data-modal-overlay]');
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); window._closeModal = null; };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  root.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', close));
  requestAnimationFrame(() => overlay.classList.add('open'));
  window._closeModal = close;
  return { close };
}
function closeModal() { if (window._closeModal) window._closeModal(); }

const ICON_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>';

// ---------- import / add modal ----------
let importType = 'accounts';
window.triggerImport = (type) => openImportModal(type || 'accounts');

function openImportModal(type = 'accounts') {
  importType = type === 'single' ? 'accounts' : type;
  const initial = type;
  const tab = (t, label) => `<button class="modal-tab${t === initial ? ' active' : ''}" data-imp-tab="${t}">${label}</button>`;
  openModal(`
    <div class="modal-head">
      <div><h3>Import &amp; add</h3><p class="modal-sub">Bring accounts and contacts into OpenAgenticOS — drop a CSV, paste rows, or add one by hand.</p></div>
      <button class="modal-x" data-modal-close aria-label="Close">&times;</button>
    </div>
    <div class="modal-tabs">
      ${tab('accounts', 'Accounts CSV')}
      ${tab('contacts', 'Contacts CSV')}
      ${tab('single', 'Add one account')}
    </div>
    <div id="imp-body" class="modal-body"></div>
  `);
  let active = initial;
  const setTab = (t) => { active = t; importType = t === 'single' ? 'accounts' : t; document.querySelectorAll('[data-imp-tab]').forEach((x) => x.classList.toggle('active', x.dataset.impTab === t)); renderImportBody(t); };
  document.querySelectorAll('[data-imp-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.impTab)));
  renderImportBody(initial);
}

function renderImportBody(tab) {
  const body = document.getElementById('imp-body');
  if (!body) return;
  if (tab === 'single') {
    body.innerHTML = `
      <form class="modal-form" id="imp-single">
        <label>Account name<input name="acctname" required placeholder="Acme Corp" autocomplete="off" autofocus></label>
        <label>Website / domain <span class="opt">optional</span><input name="website" placeholder="acme.com" autocomplete="off"></label>
        <div class="modal-actions"><button type="button" class="btn ghost" data-modal-close>Cancel</button><button type="submit" class="btn primary">Add account</button></div>
      </form>`;
    body.querySelector('#imp-single').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const name = f.acctname.value.trim();
      if (!name) return toast('Account name is required', true);
      try { await api('/accounts', 'POST', { name, website: f.website.value.trim() }); toast('Account added'); closeModal(); render(); }
      catch (err) { toast(err.message, true); }
    });
    setTimeout(() => { const i = body.querySelector('input[name=acctname]'); if (i) i.focus(); }, 30);
    return;
  }
  const label = tab === 'contacts' ? 'contacts' : 'accounts';
  const cols = tab === 'contacts' ? 'name, email, title, phone, linkedin, account' : 'name, website, phone, persona, …';
  body.innerHTML = `
    <div class="dropzone" id="imp-drop">
      <div class="dz-ico">${ICON_UPLOAD}</div>
      <div class="dz-title">Drop a ${label} CSV here</div>
      <div class="dz-sub">or <button type="button" class="link-btn" id="imp-browse">browse your files</button></div>
      <div class="dz-cols">columns: <code>${esc(cols)}</code></div>
    </div>
    <div class="dz-or"><span>or paste CSV</span></div>
    <textarea id="imp-paste" class="modal-paste" placeholder="${esc(cols)}" spellcheck="false"></textarea>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-modal-close>Cancel</button>
      <button type="button" class="btn primary" id="imp-paste-go">Import pasted CSV</button>
    </div>`;
  const drop = body.querySelector('#imp-drop');
  body.querySelector('#imp-browse').addEventListener('click', () => fileInput.click());
  body.querySelector('#imp-paste-go').addEventListener('click', () => {
    const t = body.querySelector('#imp-paste').value.trim();
    if (t) doImport(t, 'pasted.csv'); else toast('Paste some CSV rows first', true);
  });
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  drop.addEventListener('dragleave', (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', async (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) doImport(await file.text(), file.name);
  });
}

async function doImport(csv, source) {
  try {
    const r = await api('/import', 'POST', { csv, type: importType, source });
    toast(`Imported — ${r.added || 0} added · ${r.updated || 0} updated${r.contacts ? ' · ' + r.contacts + ' contacts' : ''}`);
    closeModal();
    render();
  } catch (e) { toast(e.message, true); }
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]; if (!file) return;
  await doImport(await file.text(), file.name);
  fileInput.value = '';
});

render();

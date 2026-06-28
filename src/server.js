// Zero-dependency HTTP server: JSON API + static operator dashboard.
// Run: `npm start`. House style mirrors voice-prospecting/src/server.js.
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { connect } from './db.js';
import * as db from './models.js';
import * as svc from './service.js';
import { importAccountsCsv, importContactsCsv } from './importer.js';
import { runResearch, runResearchBatch } from './research/index.js';
import { generateAndSave, generateAllForAccount } from './callnotes.js';
import { generateResearchBrief } from './researchBriefs.js';
import { allProviderStatuses, getProviderKey, saveProviderKey, saveProviderTest } from './providers/keyStore.js';
import { testSumble } from './providers/sumble.js';
import { testCommonRoom } from './providers/commonRoom.js';
import { testGemini } from './providers/gemini.js';
import { testAmplemarket } from './providers/amplemarket.js';
import { generateProviderAccountBrief } from './providers/accountBrief.js';
import { buildApolloCsv, buildAmplemarketCsv, writeExport } from './exporter.js';
import { llmAvailable } from './llm.js';
import { buildQueue, getQueue } from './callQueue.js';
import { cockpitForQuery, cockpitForContactId, logOutcome } from './cockpit.js';
import { recordReplyWebhook } from './reply.js';
import { matchAccount, networkSummary } from './knowledge/network.js';
import { syncDialSheet } from './integrations/googleSheet.js';
import { runMonitor } from './jobs/sumbleMonitor.js';
import { buildGraph } from './graph.js';
import { corsOriginFor, isPrivileged } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASH_DIR = path.join(__dirname, 'dashboard');
const cfg = getConfig();
connect(); // open + migrate the DB up front

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const json = (res, code, obj) => send(res, code, obj);

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (!data) return resolve({});
      if (ct.includes('application/json')) { try { return resolve(JSON.parse(data)); } catch { return resolve({}); } }
      if (ct.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(data)));
      resolve({ _raw: data });
    });
  });
}

function serveStatic(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

// ---- routing ----
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
function match(pattern, pathname) {
  const pk = pattern.split('/').filter(Boolean);
  const ak = pathname.split('/').filter(Boolean);
  if (pk.length !== ak.length) return null;
  const params = {};
  for (let i = 0; i < pk.length; i++) {
    if (pk[i].startsWith(':')) params[pk[i].slice(1)] = decodeURIComponent(ak[i]);
    else if (pk[i] !== ak[i]) return null;
  }
  return params;
}
const idsFrom = (v) => String(v || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

function denyUnprivileged(req, res) {
  if (isPrivileged(req)) return false;
  json(res, 403, { error: 'forbidden: privileged endpoint (loopback or X-Ops-Token required)' });
  return true;
}

function commandExists(name) {
  try {
    execFileSync('/usr/bin/which', [name], { stdio: 'ignore', timeout: 700 });
    return true;
  } catch {
    return false;
  }
}

function tcpOpen(port, host = '127.0.0.1', timeout = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function readSkillDirs(root, depth = 2, prefix = '') {
  if (!fs.existsSync(root) || depth < 0) return [];
  const out = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const full = path.join(root, item.name);
    const label = prefix ? `${prefix}/${item.name}` : item.name;
    if (fs.existsSync(path.join(full, 'SKILL.md'))) out.push({ name: label, path: full });
    out.push(...readSkillDirs(full, depth - 1, label));
  }
  return out;
}

function discoverLocalSkills() {
  const home = os.homedir();
  const roots = [
    { root: path.join(home, '.codex', 'skills'), source: 'Codex' },
    { root: path.join(home, 'skills'), source: 'Local' },
    { root: path.join(home, '.hermes', 'skills'), source: 'Hermes' },
  ];
  const seen = new Set();
  const skills = [];
  for (const { root, source } of roots) {
    for (const skill of readSkillDirs(root)) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push({ ...skill, source });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Agent OS surface discovery ----
// HTTP probe: is a local surface reachable, and can it be iframe-embedded
// (no X-Frame-Options DENY/SAMEORIGIN and no CSP frame-ancestors)?
function httpProbeOnce(url, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const u = new URL(url);
      const req = http.get({ host: u.hostname, port: u.port, path: '/', timeout }, (r) => {
        const xfo = String(r.headers['x-frame-options'] || '').toLowerCase();
        const csp = String(r.headers['content-security-policy'] || '').toLowerCase();
        const blocked = /deny|sameorigin/.test(xfo) || /frame-ancestors/.test(csp);
        r.resume();
        done({ ok: true, status: r.statusCode, embedAllowed: !blocked });
      });
      req.on('timeout', () => { req.destroy(); done({ ok: false }); });
      req.on('error', () => done({ ok: false }));
    } catch { done({ ok: false }); }
  });
}
// Retry once: local agent servers (e.g. Hermes/uvicorn) can be slow on the first
// hit after idle, which would otherwise read as a false "not running".
async function httpProbe(url, { timeout = 2200, attempts = 2 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const r = await httpProbeOnce(url, timeout); // eslint-disable-line no-await-in-loop
    if (r.ok) return r;
  }
  return { ok: false };
}

// Resolve a local CLI binary by name. Checks the known install prefixes on this
// machine (Hermes-managed Node, ~/.local/bin, Homebrew) before falling back to
// `which`, so discovery works even when the server's PATH is minimal.
const BIN_PREFIXES = [
  path.join(os.homedir(), '.hermes', 'node', 'bin'),
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];
function resolveBin(name) {
  for (const dir of BIN_PREFIXES) {
    const full = path.join(dir, name);
    try { if (fs.existsSync(full)) return full; } catch { /* ignore */ }
  }
  try {
    const out = execFileSync('/usr/bin/which', [name], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 700 }).toString().trim();
    return out || null;
  } catch { return null; }
}

// Repo root — Free Claude Code jobs are scoped to this directory.
const PROJECT_ROOT = path.resolve(__dirname, '..');
const N2_DEFAULT_MODEL = 'nex-agi/nex-n2-pro:free';
const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api/v1';

// Where does N2 route? Prefer an OpenRouter key available to THIS app; fall back
// to a configured LiteLLM base URL. We never read Hermes' secrets. `hasKey`
// gates whether the chat panel is live vs. an honest setup state.
function n2Route() {
  const orKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (orKey) return { route: 'openrouter', baseUrl: (process.env.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT_URL).replace(/\/$/, ''), hasKey: true, key: orKey };
  const litellm = String(process.env.LITELLM_BASE_URL || '').trim();
  if (litellm) return { route: 'litellm', baseUrl: litellm.replace(/\/$/, ''), hasKey: true, key: String(process.env.LITELLM_API_KEY || '').trim() };
  return { route: 'openrouter', baseUrl: OPENROUTER_DEFAULT_URL, hasKey: false, key: '' };
}

// Strip ANSI color escapes — CLIs emit them when FORCE_COLOR is inherited.
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

// Parse `openclaw gateway status` into the few fields the OpenClaw panel shows.
function openClawGatewayStatus() {
  const bin = resolveBin('openclaw');
  if (!bin) return null;
  try {
    const raw = execFileSync(bin, ['gateway', 'status'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 6000,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    }).toString();
    const out = stripAnsi(raw);
    const pick = (re) => { const m = out.match(re); return m ? m[1].trim() : null; };
    return {
      service: pick(/Service:\s*(.+)/),
      runtime: pick(/Runtime:\s*(.+)/),
      capability: pick(/Capability:\s*(.+)/),
      gatewayVersion: pick(/Gateway version:\s*(.+)/),
      connectivity: pick(/Connectivity probe:\s*(.+)/),
      dashboard: pick(/Dashboard:\s*(\S+)/),
    };
  } catch { return null; }
}

// Each left-rail agent maps to a concrete local surface we can route into, or an
// honest connect/install/setup state. Definition order = left-rail order.
//   probe  — live HTTP/port check (Hermes, OpenClaw, Ollama)
//   cli    — local binary we can run scoped jobs against (Free Claude Code)
//   model  — OpenAI-compatible model surfaced as a local chat panel (N2)
//   local  — a page inside this app (Codex)
//   external — model/API with no local UI surface (Claude, Gemini, Antigravity)
const AGENT_SURFACES = {
  council: { label: 'Council', role: 'Multi-agent deliberation', accent: 'amber', kind: 'council', detail: 'Paste an idea and get grounded angles from the local agent stack.' },
  memory: { label: 'Memory', role: 'Vault + graph', accent: 'amber', kind: 'memory', url: '/#/map', detail: 'Local account graph, signals, tasks, and recent operating context.' },
  'free-claude-code': { label: 'Free Claude Code', role: 'Local coding agent', accent: 'green', kind: 'cli' },
  'n2-agent': { label: 'N2 Agent', role: 'OpenRouter reasoning', accent: 'violet', kind: 'model' },
  openclaw: {
    label: 'OpenClaw', role: 'Browser + computer control', accent: 'pink', kind: 'probe',
    ports: [18789], installed: () => !!resolveBin('openclaw'),
    installCommand: 'npm install -g openclaw@latest && openclaw onboard --install-daemon',
  },
  hermes: {
    label: 'Hermes', role: 'Agent orchestration', accent: 'blue', kind: 'probe',
    ports: [9119, 9120, 9138], canStart: true, startCommand: 'hermes dashboard --no-open --skip-build',
    installed: () => !!resolveBin('hermes') || fs.existsSync(path.join(os.homedir(), '.hermes', 'config.yaml')),
  },
  ollama: {
    label: 'Ollama', role: 'Local model server', accent: 'teal', kind: 'probe', api: true,
    ports: [11434], installed: () => !!resolveBin('ollama'),
  },
  codex: { label: 'Codex', role: 'Code + local builds', accent: 'teal', kind: 'local', url: '/', detail: 'OpenAgenticOS is your local build/operator surface.' },
  claude: { label: 'Claude', role: 'Executive reasoning', accent: 'rose', kind: 'external', detail: 'Anthropic API model powering the GTM brief/cockpit engines. No local UI surface.' },
  gemini: { label: 'Gemini', role: 'Google CLI agent', accent: 'blue', kind: 'gemini-cli' },
  antigravity: { label: 'Antigravity', role: 'Experimental workspace', accent: 'purple', kind: 'external', detail: 'Authorized for your Google account, but the Antigravity app is not installed on this Mac — install it to add a real surface, or hide this tile for now.' },
};

// Free Claude Code: detect the binary + version. Auth is verified at run time
// with `claude auth status`; credentials may live outside ~/.claude/.credentials.json.
function claudeAuthStatus(bin) {
  try {
    const raw = execFileSync(bin, ['auth', 'status'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
    const data = JSON.parse(stripAnsi(raw));
    return {
      loggedIn: !!data.loggedIn,
      hint: data.loggedIn ? `status: logged in via ${data.authMethod || 'Claude auth'}` : 'login required',
    };
  } catch {
    return { loggedIn: false, hint: 'login status unknown' };
  }
}

function discoverClaudeCode(base) {
  const bin = resolveBin('claude');
  if (!bin) {
    return { ...base, state: 'not-installed', action: 'install', canRun: false, embedAllowed: false,
      installCommand: 'npm install -g @anthropic-ai/claude-code',
      detail: 'Claude Code CLI was not found on this machine.' };
  }
  let version = null;
  try { version = execFileSync(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim(); } catch { /* version stays null */ }
  const auth = claudeAuthStatus(bin);
  return {
    ...base, state: 'available', action: 'run', kind: 'local-cli',
    command: bin, version, canRun: true, embedAllowed: false, workdir: PROJECT_ROOT,
    authHint: auth.hint, needsLogin: !auth.loggedIn,
    detail: `Claude Code ${version || ''} detected. Runs scoped, non-interactive jobs against ${PROJECT_ROOT}.`.replace('  ', ' '),
  };
}

// Gemini CLI: detect the binary + version and whether the user is logged in
// (OAuth creds on disk) or has an API key. Login is a one-time browser flow the
// user runs in a terminal (`gemini` → "Login with Google"); this app then runs
// jobs against that logged-in CLI, the same way Free Claude Code does.
function geminiAuthStatus() {
  const dir = path.join(os.homedir(), '.gemini');
  let hasOauth = false;
  try { hasOauth = fs.existsSync(path.join(dir, 'oauth_creds.json')); } catch { /* unreadable */ }
  const hasKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  if (hasOauth) return { loggedIn: true, method: 'google-login', hint: 'logged in via Google account' };
  if (hasKey) return { loggedIn: true, method: 'api-key', hint: 'using GEMINI_API_KEY' };
  return { loggedIn: false, method: null, hint: 'login required' };
}

// The Gemini CLI is slow to start (~7s for `--version`), and execFileSync would
// block the whole event loop on every surface discovery. So probe the version
// once in the background and cache it; discovery returns instantly with the last
// known value (null on the very first call, populated for subsequent ones).
let _geminiVersion = null;
let _geminiVersionProbing = false;
function geminiVersionCached(bin) {
  // Return the cached version if we have it. Only one probe runs at a time, and a
  // failed probe leaves the cache empty so a later call retries (the CLI may just
  // have been cold on first boot).
  if (_geminiVersion || _geminiVersionProbing) return _geminiVersion;
  _geminiVersionProbing = true;
  try {
    execFile(bin, ['--version'], { timeout: 10000 }, (err, stdout) => {
      _geminiVersionProbing = false;
      if (!err && stdout) _geminiVersion = String(stdout).trim();
    });
  } catch { _geminiVersionProbing = false; }
  return _geminiVersion;
}

function discoverGemini(base) {
  const bin = resolveBin('gemini');
  if (!bin) {
    return { ...base, state: 'not-installed', action: 'install', canRun: false, embedAllowed: false,
      installCommand: 'npm install -g @google/gemini-cli',
      detail: 'Gemini CLI was not found on this machine.' };
  }
  const version = geminiVersionCached(bin);
  const auth = geminiAuthStatus();
  return {
    ...base, kind: 'local-cli', command: bin, version, workdir: PROJECT_ROOT,
    canRun: auth.loggedIn, needsLogin: !auth.loggedIn,
    state: auth.loggedIn ? 'available' : 'needs_login',
    action: auth.loggedIn ? 'run' : 'login',
    authMethod: auth.method, authHint: auth.hint, embedAllowed: false,
    loginCommand: 'gemini',
    detail: auth.loggedIn
      ? `Gemini CLI ${version || ''} ready (${auth.hint}).`.replace('  ', ' ')
      : 'Gemini CLI is installed but not logged in. Run `gemini` once in a terminal, choose "Login with Google", then Re-check.',
  };
}

// ---- Obsidian vault memory: the Memory surface reads real recent notes ----
// The vault root holds the user's journal + the daily notes OpenClaw mirrors in.
const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR
  || path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents', 'Obsidian Vault');

function mdExcerpt(raw, max = 200) {
  return String(raw || '')
    .replace(/^---[\s\S]*?---/, '')        // strip YAML frontmatter
    .replace(/```[\s\S]*?```/g, ' ')        // code fences
    .replace(/!?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // wikilinks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')// md links
    .replace(/^#{1,6}\s*/gm, '')            // headings
    .replace(/[*_`>#]/g, ' ')               // md punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function listVaultNotes(limit = 8) {
  const entries = fs.readdirSync(VAULT_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map((e) => {
      // A synced (iCloud/Obsidian) vault can drop a file between readdir and stat;
      // skip the racing file instead of failing the whole listing.
      try {
        const file = path.join(VAULT_DIR, e.name);
        const st = fs.statSync(file);
        return { name: e.name.replace(/\.md$/, ''), file, mtime: st.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, limit);
}

function readVaultMemory(limit = 8) {
  try {
    const notes = listVaultNotes(limit).map((n) => {
      let excerpt = '';
      try { excerpt = mdExcerpt(fs.readFileSync(n.file, 'utf8')); } catch { /* unreadable */ }
      return { name: n.name, excerpt, updated: new Date(n.mtime).toISOString() };
    });
    return { connected: true, dir: VAULT_DIR, count: notes.length, notes };
  } catch (e) {
    return { connected: false, dir: VAULT_DIR, count: 0, notes: [], error: e.code || e.message };
  }
}

function searchVaultMemory(q, limit = 12) {
  const needle = String(q || '').trim().toLowerCase();
  try {
    const out = [];
    for (const n of listVaultNotes(60)) {
      let raw = '';
      try { raw = fs.readFileSync(n.file, 'utf8'); } catch { continue; }
      const hay = `${n.name}\n${raw}`.toLowerCase();
      if (needle && !hay.includes(needle)) continue;
      let snippet = mdExcerpt(raw);
      if (needle) {
        const flat = mdExcerpt(raw, 4000);
        const idx = flat.toLowerCase().indexOf(needle);
        if (idx >= 0) snippet = (idx > 40 ? '…' : '') + flat.slice(Math.max(0, idx - 40), idx + 160).trim();
      }
      out.push({ name: n.name, snippet, updated: new Date(n.mtime).toISOString() });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

// Does the configured router actually answer? Hitting /models confirms the
// endpoint is reachable and the key is accepted (3s budget). A 401/403 means the
// router answered but rejected the key — reported distinctly from "offline".
async function n2Health(r) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 3000);
  try {
    const resp = await fetch(`${r.baseUrl}/models`, { headers: { authorization: `Bearer ${r.key}` }, signal: controller.signal });
    if (resp.ok) return { state: 'ready', reachable: true };
    if (resp.status === 401 || resp.status === 403) return { state: 'key_rejected', reachable: true, note: `router rejected the key (HTTP ${resp.status})` };
    return { state: 'router_offline', reachable: false, note: `router returned HTTP ${resp.status}` };
  } catch (e) {
    return { state: 'router_offline', reachable: false, note: e.name === 'AbortError' ? 'router timed out' : e.message };
  } finally { clearTimeout(t); }
}

// N2: a local chat panel backed by an OpenAI-compatible endpoint (OpenRouter or
// LiteLLM). State is honest — `ready` only when the router actually answers.
async function discoverN2(base) {
  const r = n2Route();
  const model = String(process.env.N2_MODEL || N2_DEFAULT_MODEL);
  const common = {
    ...base, kind: 'openai-compatible-model', model, route: r.route, routerUrl: r.baseUrl,
    hasKey: r.hasKey, embedAllowed: false, localPanel: true,
    capabilities: ['reasoning', 'function calling', 'structured outputs', '262K context'],
  };
  if (!r.hasKey) {
    return { ...common, state: 'needs_api_key_or_router', action: 'setup',
      detail: 'N2 needs an OpenRouter key (or a LiteLLM route) available to this app. Hermes has OpenRouter configured, but its secrets are not read here.' };
  }
  const h = await n2Health(r);
  return {
    ...common, state: h.state, reachable: h.reachable,
    action: h.state === 'ready' ? 'chat' : 'setup',
    detail: h.state === 'ready'
      ? `N2 (${model}) is live through ${r.route} at ${r.baseUrl}.`
      : `N2 key is set but ${h.note}.`,
  };
}

async function discoverSurface(key) {
  const c = AGENT_SURFACES[key];
  if (!c) return null;
  const base = { agent: key, label: c.label, role: c.role, accent: c.accent, kind: c.kind };
  if (c.kind === 'council') return { ...base, state: 'ready', action: 'council', kind: 'local-council', embedAllowed: false, detail: c.detail };
  if (c.kind === 'memory') return discoverMemorySurface(base, c);
  if (c.kind === 'cli') return discoverClaudeCode(base);
  if (c.kind === 'gemini-cli') return discoverGemini(base);
  if (c.kind === 'model') return discoverN2(base);
  if (c.kind === 'local') return { ...base, state: 'local', action: 'local', url: c.url, embedAllowed: false, detail: c.detail };
  if (c.kind === 'external') return { ...base, state: 'external', action: 'external', url: null, embedAllowed: false, detail: c.detail };
  if (key === 'openclaw') return discoverOpenClawSurface(base, c);
  for (const port of c.ports) {
    const url = `http://127.0.0.1:${port}`;
    const p = await httpProbe(url); // eslint-disable-line no-await-in-loop
    if (p.ok) {
      const surface = {
        ...base, state: 'connected', url, embedAllowed: !!p.embedAllowed, httpStatus: p.status,
        action: c.api ? 'api' : (p.embedAllowed ? 'embed' : 'open-tab'),
        detail: c.api ? `${c.label} API is reachable at ${url} (model server — no embeddable UI).` : `${c.label} is live at ${url}.`,
      };
      if (key === 'openclaw') surface.gateway = openClawGatewayStatus();
      return surface;
    }
  }
  if (c.installed && c.installed()) {
    return {
      ...base, state: 'installed-not-running', action: c.canStart ? 'start' : 'external', url: null, embedAllowed: false,
      canStart: !!c.canStart, startCommand: c.startCommand || null,
      detail: `${c.label} is installed but no local surface is serving on ${c.ports.map((p) => ':' + p).join(', ')}.`,
    };
  }
  return { ...base, state: 'not-installed', action: 'install', url: null, embedAllowed: false, installCommand: c.installCommand || null, detail: `${c.label} is not installed on this machine.` };
}

async function discoverOpenClawSurface(base, c) {
  const gateway = openClawGatewayStatus();
  const urls = [];
  if (gateway?.dashboard) urls.push(gateway.dashboard);
  for (const port of c.ports) urls.push(`http://127.0.0.1:${port}`);
  const seen = new Set();
  for (const rawUrl of urls) {
    const url = String(rawUrl || '').replace(/\/$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const p = await httpProbe(url); // eslint-disable-line no-await-in-loop
    if (p.ok) {
      return {
        ...base,
        state: 'connected',
        url,
        embedAllowed: !!p.embedAllowed,
        httpStatus: p.status,
        action: p.embedAllowed ? 'embed' : 'open-tab',
        gateway,
        detail: `OpenClaw is live at ${url}${gateway?.runtime ? ` (${gateway.runtime})` : ''}.`,
      };
    }
  }
  if (c.installed && c.installed()) {
    return {
      ...base, state: 'installed-not-running', action: 'external', url: gateway?.dashboard || null,
      embedAllowed: false, gateway, detail: gateway?.dashboard
        ? `OpenClaw is installed, but its gateway dashboard at ${gateway.dashboard} did not answer.`
        : `${c.label} is installed but no local or tailnet surface is serving on ${c.ports.map((p) => ':' + p).join(', ')}.`,
    };
  }
  return { ...base, state: 'not-installed', action: 'install', url: null, embedAllowed: false, installCommand: c.installCommand || null, detail: `${c.label} is not installed on this machine.` };
}

async function discoverAllSurfaces() {
  const list = await Promise.all(Object.keys(AGENT_SURFACES).map((k) => discoverSurface(k)));
  return Object.fromEntries(list.filter(Boolean).map((s) => [s.agent, s]));
}

function discoverMemorySurface(base, c) {
  let graphStats = null;
  try { graphStats = buildGraph({ limit: 180, includeTech: true }).stats; } catch { /* optional */ }
  return {
    ...base,
    state: 'connected',
    action: 'memory',
    kind: 'local-memory',
    url: c.url,
    embedAllowed: false,
    graphStats,
    vault: readVaultMemory(8),
    recentSignals: db.listRecentSignals(5).filter((s) => s.kind !== 'missing_data').map((s) => ({
      account: s.account_name,
      label: s.label,
      source: s.source,
      detectedAt: s.detected_at,
    })),
    detail: c.detail,
  };
}

function clampText(s, max = 1400) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function parseJsonish(text) {
  const raw = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(raw || '{}');
  } catch (e) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw e;
  }
}

function pct(n, d) {
  if (!d) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(n || 0) / Number(d || 1)) * 100)));
}

function agentOsBrain(cards = null, skills = null) {
  const allCards = cards || svc.listCards({});
  const skillRows = skills || discoverLocalSkills();
  const stats = db.stats();
  const graph = buildGraph({ limit: 180, includeTech: true });
  const openTasks = db.listTasks({ status: 'open' }).slice(0, 8);
  const signals = db.listRecentSignals(12).filter((s) => s.kind !== 'missing_data');
  const queue = db.listQueue({}).slice(0, 8);
  const workable = Math.max(1, stats.total - stats.blocked);
  return {
    stats,
    graph: graph.stats,
    goals: [
      { label: 'Work-today coverage', value: stats.workToday, total: workable, progress: pct(stats.workToday, workable) },
      { label: 'Sequencing readiness', value: stats.readyToSequence, total: workable, progress: pct(stats.readyToSequence, workable) },
      { label: 'Contacts mapped', value: stats.contacts, total: Math.max(1, stats.total), progress: pct(stats.contacts, Math.max(1, stats.total)) },
    ],
    journal: [
      `${stats.total} accounts, ${stats.workToday} in work-today, ${stats.contacts} contacts mapped.`,
      `${openTasks.length} open tasks are visible to Agent OS right now.`,
      `${graph.stats.accounts || 0} accounts and ${graph.stats.hubs || 0} memory hubs are in the current graph.`,
    ],
    memory: {
      recentSignals: signals.slice(0, 8),
      priority: allCards.filter((c) => c.band !== 'blocked').slice(0, 6),
      queued: queue,
    },
    skills: {
      available: skillRows.length,
      total: Math.max(183, skillRows.length),
      rows: skillRows.slice(0, 12),
    },
  };
}

function agentBriefForCouncil(agent, idea, brain) {
  const signal = brain.memory.recentSignals[0];
  const priority = brain.memory.priority[0];
  const baseContext = priority
    ? `Anchor it to ${priority.name}: ${priority.whyNow || priority.next_action || 'needs research'}`
    : 'Anchor it to the current GTM queue before expanding.';
  const rows = {
    memory: {
      agent: 'memory',
      label: 'Memory',
      stance: 'Ground it in the self layer before shipping.',
      bullets: [
        `Current graph: ${brain.graph.accounts || 0} accounts, ${brain.graph.contacts || 0} people, ${brain.graph.hubs || 0} hubs.`,
        signal ? `Fresh signal to reuse: ${signal.account_name || 'account'} - ${signal.label}.` : 'No fresh non-gap signal is prominent; research should come first.',
        baseContext,
      ],
      risks: ['If the idea is not written back to memory, the stack will forget why it mattered.'],
      nextActions: ['Save the idea, decision, owner, and next action into the local memory/journal layer.'],
      source: 'local-memory',
    },
    'free-claude-code': {
      agent: 'free-claude-code',
      label: 'Free Claude Code',
      stance: 'Turn the idea into a small, testable repo change.',
      bullets: [
        'Prefer one thin implementation slice with syntax checks and focused tests.',
        'Use the existing Agent OS routes and dashboard components before inventing new architecture.',
        'Keep write actions reviewable; no outbound sends or destructive commands without approval.',
      ],
      risks: ['Scope creep: a dashboard idea can become a rewrite if the build boundary is not explicit.'],
      nextActions: ['Ask Claude Code for a scoped implementation plan, then run node --check and npm test.'],
      source: 'local-template',
    },
    hermes: {
      agent: 'hermes',
      label: 'Hermes',
      stance: 'Convert the idea into background work, skills, and repeatable operating tasks.',
      bullets: [
        `${brain.skills.available}/${brain.skills.total} local skills are discoverable for reuse.`,
        'Best fit: recurring research, queue upkeep, summaries, and small automations.',
        'Keep Hermes as the worker layer while Claude/Codex keep product judgment.',
      ],
      risks: ['Long-running tasks need a clear unblock condition or they turn into stale board noise.'],
      nextActions: ['Create one Hermes task with expected output, allowed tools, and a completion check.'],
      source: 'local-template',
    },
    openclaw: {
      agent: 'openclaw',
      label: 'OpenClaw',
      stance: 'Use it where browser/computer control or local gateway routing is the unlock.',
      bullets: [
        'Good for operating real local surfaces when APIs are missing.',
        'Keep gateway-scoped actions visible and reversible.',
        'Use memory context first so execution does not drift from the operator goal.',
      ],
      risks: ['UI automation can succeed mechanically while doing the wrong business action.'],
      nextActions: ['Draft a dry-run checklist before any browser/computer action is approved.'],
      source: 'local-template',
    },
    'n2-agent': {
      agent: 'n2-agent',
      label: 'N2',
      stance: 'Pressure-test the idea as a reasoning/research angle.',
      bullets: [
        'Look for hidden assumptions, alternate approaches, and cheap experiments.',
        'Use it for breadth before Claude Code makes implementation choices.',
        'Keep its output advisory until grounded by local data.',
      ],
      risks: ['Model breadth is useful, but it can over-generalize if the local account context is thin.'],
      nextActions: ['Ask N2 for objections, edge cases, and the smallest validation step.'],
      source: 'local-template',
    },
  };
  return rows[agent] || {
    agent,
    label: agent,
    stance: `Review the idea: ${idea}`,
    bullets: ['No local profile configured.'],
    risks: [],
    nextActions: [],
    source: 'fallback',
  };
}

function councilSynthesis(idea, angles, brain) {
  const connected = angles.filter((a) => a.source !== 'fallback').map((a) => a.label).join(', ');
  const firstAccount = brain.memory.priority[0];
  return {
    what: clampText(idea, 220),
    soWhat: firstAccount
      ? `The useful version should move an actual queue item forward, starting with ${firstAccount.name}.`
      : 'The useful version should create durable memory, a concrete task, or a tested dashboard improvement.',
    nowWhat: [
      'Pick the smallest reversible experiment.',
      'Save the decision and evidence into Memory.',
      'Use Claude Code for implementation, Hermes for recurring work, OpenClaw for UI execution, and N2 for pressure-testing.',
    ],
    agents: connected,
  };
}

async function n2CouncilAngle(idea, brain) {
  const r = n2Route();
  if (!r.hasKey) return null;
  const model = String(process.env.N2_MODEL || N2_DEFAULT_MODEL);
  const context = {
    stats: brain.stats,
    graph: brain.graph,
    priority: brain.memory.priority.slice(0, 3).map((c) => ({ name: c.name, score: c.score, whyNow: c.whyNow, nextAction: c.next_action })),
    recentSignals: brain.memory.recentSignals.slice(0, 4).map((s) => ({ account: s.account_name, label: s.label, source: s.source })),
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(`${r.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${r.key}`,
        'HTTP-Referer': 'http://localhost:4100/#/agent-os/council',
        'X-Title': 'OpenAgenticOS - Agent Council',
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        messages: [
          { role: 'system', content: 'You are N2 inside OpenAgenticOS, a local-first agent operating dashboard. Return concise JSON only with keys stance, bullets, risks, nextActions. Do not claim to execute actions.' },
          { role: 'user', content: JSON.stringify({ idea, context }) },
        ],
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || `router returned HTTP ${resp.status}`);
    const text = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    return {
      agent: 'n2-agent',
      label: 'N2',
      stance: clampText(parsed.stance, 260) || 'Pressure-test the idea as a reasoning/research angle.',
      bullets: (Array.isArray(parsed.bullets) ? parsed.bullets : []).map((x) => clampText(x, 220)).filter(Boolean).slice(0, 4),
      risks: (Array.isArray(parsed.risks) ? parsed.risks : []).map((x) => clampText(x, 220)).filter(Boolean).slice(0, 3),
      nextActions: (Array.isArray(parsed.nextActions) ? parsed.nextActions : []).map((x) => clampText(x, 220)).filter(Boolean).slice(0, 3),
      source: `${r.route}:${model}`,
    };
  } catch (e) {
    const fallback = agentBriefForCouncil('n2-agent', idea, brain);
    return { ...fallback, source: `fallback (${e.name === 'AbortError' ? 'timeout' : e.message})` };
  } finally {
    clearTimeout(t);
  }
}

function councilModelContext(brain) {
  return {
    stats: brain.stats,
    graph: brain.graph,
    goals: brain.goals,
    journal: brain.journal,
    priority: brain.memory.priority.slice(0, 5).map((c) => ({
      name: c.name,
      score: c.score,
      band: c.band,
      whyNow: c.whyNow,
      nextAction: c.next_action,
      incidentStack: c.incident_stack,
    })),
    recentSignals: brain.memory.recentSignals.slice(0, 8).map((s) => ({
      account: s.account_name,
      label: s.label,
      source: s.source,
      detectedAt: s.detected_at,
    })),
    queued: brain.memory.queued.slice(0, 5).map((q) => ({
      account: q.account_name,
      contact: q.contact_name,
      whyNow: q.why_now,
    })),
    skills: brain.skills.rows.slice(0, 10).map((s) => s.name),
  };
}

function councilIdeaStance(agent, idea) {
  const excerpt = clampText(idea, 120);
  const rows = {
    memory: `Ground "${excerpt}" in the current account graph, queue, and journal before anyone acts.`,
    'free-claude-code': `Turn "${excerpt}" into the smallest testable dashboard or workflow change.`,
    hermes: `Convert "${excerpt}" into repeatable background work with a clear done condition.`,
    openclaw: `Use OpenClaw only for the visible browser/control steps in "${excerpt}".`,
    'n2-agent': `Pressure-test "${excerpt}" for assumptions, edge cases, and a cheap validation step.`,
  };
  return rows[agent] || `Review "${excerpt}" from the ${agent} lens.`;
}

function councilList(v, max) {
  return (Array.isArray(v) ? v : []).map((x) => clampText(x, 240)).filter(Boolean).slice(0, max);
}

function sameTextList(a = [], b = []) {
  if (!a.length || a.length !== b.length) return false;
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return a.every((x, i) => norm(x) === norm(b[i]));
}

function normalizeCouncilAngle(agent, raw, fallback, source, idea) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const fallbackFields = [];
  let stance = clampText(obj.stance, 280);
  if (!stance || stance.toLowerCase() === String(fallback.stance || '').toLowerCase()) {
    stance = councilIdeaStance(agent, idea);
    fallbackFields.push('stance');
  }
  const bullets = councilList(obj.bullets, 4);
  const risks = councilList(obj.risks, 3);
  const nextActions = councilList(obj.nextActions, 3);
  if (!bullets.length || sameTextList(bullets, fallback.bullets)) fallbackFields.push('bullets');
  if (!risks.length || sameTextList(risks, fallback.risks)) fallbackFields.push('risks');
  if (!nextActions.length || sameTextList(nextActions, fallback.nextActions)) fallbackFields.push('nextActions');
  const finalSource = fallbackFields.length ? `${source}+fallback:${fallbackFields.join(',')}` : source;
  return {
    ...fallback,
    agent,
    label: clampText(obj.label, 80) || fallback.label,
    stance,
    bullets: bullets.length && !sameTextList(bullets, fallback.bullets) ? bullets : fallback.bullets,
    risks: risks.length && !sameTextList(risks, fallback.risks) ? risks : fallback.risks,
    nextActions: nextActions.length && !sameTextList(nextActions, fallback.nextActions) ? nextActions : fallback.nextActions,
    source: finalSource,
    live: fallbackFields.length === 0,
    fallbackFields,
  };
}

function normalizeCouncilSynthesis(raw, fallback, idea, source) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const nowWhat = Array.isArray(obj.nowWhat) ? obj.nowWhat.map((x) => clampText(x, 180)).filter(Boolean).slice(0, 4) : [];
  return {
    ...fallback,
    what: clampText(obj.what, 260) || fallback.what || clampText(idea, 220),
    soWhat: clampText(obj.soWhat, 320) || fallback.soWhat,
    nowWhat: nowWhat.length ? nowWhat : fallback.nowWhat,
    agents: clampText(obj.agents, 220) || fallback.agents,
    source,
  };
}

async function n2CouncilSingleAngle(idea, brain, fallback, sourceBase) {
  const r = n2Route();
  if (!r.hasKey) return { ...fallback, source: 'fallback:template (no router key)', live: false, fallbackFields: ['all'] };
  const model = String(process.env.N2_MODEL || N2_DEFAULT_MODEL);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(`${r.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${r.key}`,
        'HTTP-Referer': 'http://localhost:4100/#/agent-os/council',
        'X-Title': 'OpenAgenticOS - Agent Council',
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        max_tokens: 900,
        messages: [
          {
            role: 'system',
            content: [
              `You are the ${fallback.label} lens inside OpenAgenticOS, a local-first agent operating dashboard.`,
              'Return JSON only with keys agent, label, stance, bullets, risks, nextActions.',
              `The agent key must be "${fallback.agent}".`,
              'Every field must respond to the pasted idea specifically.',
              'Bullets must be 3 to 4 concrete, non-template bullets. Do not reuse generic fallback phrases.',
              'Do not claim to execute actions. Do not invent customer facts; use unknown/needs research when evidence is thin.',
            ].join(' '),
          },
          { role: 'user', content: JSON.stringify({ idea, localContext: councilModelContext(brain), lens: fallback.agent }) },
        ],
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || `router returned HTTP ${resp.status}`);
    const parsed = parseJsonish(data.choices?.[0]?.message?.content || '{}');
    return normalizeCouncilAngle(fallback.agent, parsed, fallback, `${sourceBase}:${fallback.agent}:retry`, idea);
  } catch (e) {
    return {
      ...fallback,
      stance: councilIdeaStance(fallback.agent, idea),
      source: `fallback:template (${e.name === 'AbortError' ? 'timeout' : e.message})`,
      live: false,
      fallbackFields: ['all'],
    };
  } finally {
    clearTimeout(t);
  }
}

async function n2CouncilDeliberation(idea, brain, fallbackAngles) {
  const r = n2Route();
  if (!r.hasKey) return null;
  const model = String(process.env.N2_MODEL || N2_DEFAULT_MODEL);
  const fallbackSynthesis = councilSynthesis(idea, fallbackAngles, brain);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(`${r.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${r.key}`,
        'HTTP-Referer': 'http://localhost:4100/#/agent-os/council',
        'X-Title': 'OpenAgenticOS - Agent Council',
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: 4200,
        messages: [
          {
            role: 'system',
            content: [
              'You are the deliberation engine inside OpenAgenticOS, a local-first agent operating dashboard.',
              'Return concise JSON only with keys angles and synthesis.',
              'angles must include exactly these agents: memory, free-claude-code, hermes, openclaw, n2-agent.',
              'Each angle must be idea-specific and written from that agent lens: Memory grounds in local context; Free Claude Code scopes implementation/tests; Hermes turns it into repeatable agent work; OpenClaw evaluates browser/computer execution; N2 pressure-tests assumptions.',
              'Make each stance mention a concrete part of the pasted idea; do not reuse generic fallback phrases.',
              'Do not claim any agent executed an action. Do not invent customer facts; use unknown/needs research when context is thin.',
              'Each angle object needs keys agent, label, stance, bullets, risks, nextActions.',
              'synthesis needs keys what, soWhat, nowWhat.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              idea,
              localContext: councilModelContext(brain),
              requiredAgents: fallbackAngles.map((a) => ({ agent: a.agent, label: a.label })),
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || `router returned HTTP ${resp.status}`);
    const parsed = parseJsonish(data.choices?.[0]?.message?.content || '{}');
    const rawAngles = parsed.angles || [];
    const source = `${r.route}:${model}:council`;
    const angles = fallbackAngles.map((fallback) => {
      const raw = Array.isArray(rawAngles)
        ? rawAngles.find((a) => a && a.agent === fallback.agent)
        : rawAngles[fallback.agent];
      return normalizeCouncilAngle(fallback.agent, raw, fallback, source, idea);
    });
    const repairedAngles = await Promise.all(angles.map((angle, i) => (
      angle.live ? angle : n2CouncilSingleAngle(idea, brain, fallbackAngles[i], source)
    )));
    return {
      angles: repairedAngles,
      synthesis: normalizeCouncilSynthesis(parsed.synthesis, fallbackSynthesis, idea, source),
    };
  } catch (e) {
    const source = `${r.route}:${model}:council`;
    const repairedAngles = await Promise.all(fallbackAngles.map((fallback) => n2CouncilSingleAngle(idea, brain, fallback, source)));
    return {
      angles: repairedAngles,
      synthesis: { ...fallbackSynthesis, source: `fallback (${e.name === 'AbortError' ? 'timeout' : e.message})` },
    };
  } finally {
    clearTimeout(t);
  }
}

async function runCouncil(idea) {
  const brain = agentOsBrain();
  const agents = ['memory', 'free-claude-code', 'hermes', 'openclaw', 'n2-agent'];
  const fallbackAngles = agents.map((a) => agentBriefForCouncil(a, idea, brain));
  const live = await n2CouncilDeliberation(idea, brain, fallbackAngles);
  const angles = live?.angles || fallbackAngles;
  const synthesis = live?.synthesis || councilSynthesis(idea, angles, brain);
  db.audit({ action: 'agent_os_council', source: 'agent-os', result: clampText(idea, 220), confidence: 100 });
  return { generatedAt: new Date().toISOString(), idea, angles, synthesis };
}

// If this server was started from inside another Claude Code session, the
// environment carries that session's auth/proxy vars (ANTHROPIC_BASE_URL,
// CLAUDE_CODE_*, CLAUDECODE). A spawned standalone `claude` would inherit them
// and fail to authenticate against the nested proxy — so strip them and let it
// use the machine's own login. When not nested, the env is passed through as-is.
function claudeRunEnv() {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  if (!env.CLAUDECODE && !env.CLAUDE_CODE_ENTRYPOINT) return env;
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_EFFORT') delete env[k];
  }
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

// Spawn a CLI job and stream its raw stdout/stderr to the caller as NDJSON
// events ({t:'out'|'err'|'done'|'error', ...}). The prompt (if any) goes in on
// stdin so it can't be swallowed by variadic options. Hard timeout; the child is
// killed if the client disconnects (Stop). Used by Gemini and any plain CLI run.
function streamCli(res, bin, args, prompt, { timeout = 600000, env = claudeRunEnv() } = {}) {
  let finished = false;
  const event = (obj) => { if (!finished) { try { res.write(JSON.stringify(obj) + '\n'); } catch { /* socket gone */ } } };
  const child = spawn(bin, args, { cwd: PROJECT_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const finish = (last) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { res.write(JSON.stringify(last) + '\n'); res.end(); } catch { /* already closed */ }
  };
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ t: 'error', message: 'Run timed out' }); }, timeout);
  res.on('close', () => { if (!finished && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } finished = true; clearTimeout(timer); } });
  child.stdout.on('data', (c) => event({ t: 'out', d: stripAnsi(c.toString()) }));
  child.stderr.on('data', (c) => event({ t: 'err', d: stripAnsi(c.toString()) }));
  child.on('error', (e) => finish({ t: 'error', message: e.message }));
  child.on('close', (code) => finish({ t: 'done', code }));
  child.stdin.on('error', () => { /* ignore EPIPE if the child exits early */ });
  child.stdin.end(prompt || '');
}

// Spawn a full-access Claude Code job in stream-json mode and forward each parsed
// Claude event to the client as {t:'cc', event}. This mirrors the real CLI's
// event stream (system/assistant/user/result) so the panel can render tool calls
// and assistant text like the TUI, and capture session_id for multi-turn resume.
// The prompt is fed on stdin; the child is killed on client disconnect or timeout.
function streamClaudeCodeJson(res, bin, args, prompt, { timeout = 900000 } = {}) {
  let finished = false;
  const send = (obj) => { if (!finished) { try { res.write(JSON.stringify(obj) + '\n'); } catch { /* socket gone */ } } };
  const child = spawn(bin, args, { cwd: PROJECT_ROOT, env: claudeRunEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const finish = (last) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { res.write(JSON.stringify(last) + '\n'); res.end(); } catch { /* already closed */ }
  };
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ t: 'error', message: 'Run timed out after 15m' }); }, timeout);
  res.on('close', () => { if (!finished && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } finished = true; clearTimeout(timer); } });
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { send({ t: 'cc', event: JSON.parse(line) }); }
      catch { send({ t: 'out', d: stripAnsi(line) + '\n' }); } // non-JSON safety net
    }
  });
  child.stderr.on('data', (c) => send({ t: 'err', d: stripAnsi(c.toString()) }));
  child.on('error', (e) => finish({ t: 'error', message: e.message }));
  child.on('close', (code) => finish({ t: 'done', code }));
  child.stdin.on('error', () => { /* ignore EPIPE if the child exits early */ });
  child.stdin.end(prompt);
}

function startHermesDashboard() {
  const local = path.join(os.homedir(), '.local', 'bin', 'hermes');
  const bin = fs.existsSync(local) ? local : 'hermes';
  const child = spawn(bin, ['dashboard', '--no-open', '--skip-build'], { detached: true, stdio: 'ignore' });
  child.unref();
  return { command: `${bin} dashboard --no-open --skip-build`, pid: child.pid };
}

const filterFromQuery = (q) => ({
  band: q.get('band') || undefined,
  status: q.get('status') || undefined,
  q: q.get('q') || undefined,
  pagerduty: q.get('pagerduty') === 'true' || undefined,
  hasStatusPage: q.get('status_page') === 'true' || undefined,
  signalKind: q.get('signal') || undefined,
  tech: q.get('tech') || undefined,
  persona: q.get('persona') || undefined,
  minScore: q.get('min_score') ? Number(q.get('min_score')) : undefined,
});

// ================= API =================
route('GET', '/api/health', (req, res) => json(res, 200, { ok: true }));

// Amplemarket reply webhook → triage through the reply-gate. Point your Amplemarket
// "Replies" webhook here (exposed via `tailscale serve`). Responds 200 fast.
route('POST', '/api/amplemarket/replies-webhook', async (req, res, { body, query }) => {
  // Shared-secret auth — Amplemarket doesn't sign webhooks, and this endpoint is
  // public once exposed. Require WEBHOOK_TOKEN via ?token= or x-webhook-token header.
  const want = process.env.WEBHOOK_TOKEN || '';
  if (want) {
    const got = query.get('token') || req.headers['x-webhook-token'] || '';
    if (got !== want) return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  try {
    const row = await recordReplyWebhook(body);
    json(res, 200, { ok: true, action: row.action || 'skipped', reason: row.reason || row.skipped || '' });
  } catch (e) {
    json(res, 200, { ok: false, error: e.message }); // 200 so Amplemarket doesn't retry-storm
  }
});

route('GET', '/api/config', (req, res) => json(res, 200, {
  seller: cfg.seller,
  flags: cfg.flags,
  llm: llmAvailable(cfg) ? 'available' : 'templates-only',
  sumble: getProviderKey('sumble', cfg) ? 'configured' : 'not set',
  commonRoom: getProviderKey('commonRoom', cfg) ? 'configured' : 'not set',
  gemini: getProviderKey('gemini', cfg) ? 'configured' : (llmAvailable(cfg) ? 'ADC configured' : 'not set'),
  apollo: cfg.apolloKey ? 'key set' : 'csv only',
  amplemarket: cfg.amplemarketKey ? 'key set' : 'csv only',
  providers: allProviderStatuses(cfg),
}));

route('GET', '/api/stats', (req, res) => json(res, 200, db.stats()));

// Trellus dialer sessions (synced by scripts/sync-trellus.mjs).
route('GET', '/api/trellus', (req, res, { query }) => json(res, 200, {
  summary: db.trellusSummary(),
  sessions: db.listTrellusSessions(Number(query.get('limit')) || 100),
}));

// Combined homepage payload.
route('GET', '/api/home', (req, res) => {
  const cards = svc.listCards({});
  const priority = cards.filter((c) => c.band !== 'blocked').slice(0, 25);
  json(res, 200, {
    stats: db.stats(),
    priority,
    freshSignals: db.listRecentSignals(40).filter((s) => s.kind !== 'missing_data').slice(0, 15),
    missing: db.listSignalsByKind('missing_data', 20),
    nextActions: db.listTasks({ status: 'open' }).slice(0, 20),
  });
});

route('GET', '/api/agent-os', async (req, res) => {
  const cards = svc.listCards({});
  const openTasks = db.listTasks({ status: 'open' }).slice(0, 8);
  const audits = db.listAudit(undefined, 20);
  const providers = allProviderStatuses(cfg);
  const skills = discoverLocalSkills();
  const brain = agentOsBrain(cards, skills);
  const hermesPorts = [9120, 9138, 9119];
  const hermesChecks = await Promise.all(hermesPorts.map((port) => tcpOpen(port).then((open) => ({ port, open }))));
  const hermesOpen = hermesChecks.find((x) => x.open);
  const ollamaOpen = await tcpOpen(11434);
  const openClawSurface = await discoverSurface('openclaw');
  const openClawOpen = openClawSurface?.state === 'connected';
  let openClawPort = 18789;
  try { openClawPort = Number(new URL(openClawSurface?.url || '').port) || 18789; } catch { /* keep default */ }
  const hermesInstalled = fs.existsSync(path.join(os.homedir(), '.hermes', 'config.yaml')) || commandExists('hermes');
  const openClawInstalled = commandExists('openclaw');
  const providerStatus = (name) => providers.find((p) => p.provider === name)?.status || 'missing';

  json(res, 200, {
    generatedAt: new Date().toISOString(),
    status: {
      app: { label: 'GTM OS', state: 'online', port: cfg.port },
      hermes: { label: 'Hermes', state: hermesOpen ? 'connected' : hermesInstalled ? 'configured' : 'missing', port: hermesOpen?.port || 9120 },
      ollama: { label: 'Ollama', state: ollamaOpen ? 'connected' : 'offline', port: 11434 },
      openClaw: { label: 'OpenClaw', state: openClawOpen ? 'connected' : openClawInstalled ? 'installed' : 'not installed', port: openClawPort, url: openClawSurface?.url || null },
      gemini: { label: 'Gemini', state: geminiAuthStatus().loggedIn ? 'connected' : 'needs login' },
      sumble: { label: 'Sumble', state: providerStatus('sumble') },
      amplemarket: { label: 'Amplemarket', state: providerStatus('amplemarket') },
    },
    agents: [
      { name: 'Claude', role: 'Executive reasoning', state: cfg.llm.anthropicKey ? 'ready' : 'external', accent: 'rose' },
      { name: 'OpenClaw', role: 'Browser + computer control', state: openClawOpen ? 'connected' : openClawInstalled ? 'installed' : 'setup needed', accent: 'pink', url: openClawSurface?.url || null },
      { name: 'Hermes', role: 'Agent orchestration', state: hermesOpen ? 'connected' : hermesInstalled ? 'configured' : 'setup needed', accent: 'blue' },
      { name: 'Gemini', role: 'Research + auxiliary tasks', state: providerStatus('gemini'), accent: 'violet' },
      { name: 'Antigravity', role: 'Experimental workspace', state: 'standby', accent: 'purple' },
      { name: 'Codex', role: 'Code + local builds', state: 'active', accent: 'teal' },
      { name: 'Free Claude Code', role: 'Untrusted coding lane', state: 'sandboxed', accent: 'green' },
    ],
    skills: {
      available: skills.length,
      total: Math.max(183, skills.length),
      rows: skills.slice(0, 60),
    },
    brain,
    gtm: {
      stats: db.stats(),
      priority: cards.filter((c) => c.band !== 'blocked').slice(0, 10),
      signals: db.listRecentSignals(12),
      tasks: openTasks,
      audits,
    },
    providers,
  });
});
// Real surface discovery for the Agent OS left rail.
route('GET', '/api/agent-os/brain', async (req, res) => json(res, 200, agentOsBrain()));
route('GET', '/api/agent-os/surfaces', async (req, res) => json(res, 200, { generatedAt: new Date().toISOString(), surfaces: await discoverAllSurfaces() }));
route('GET', '/api/agent-os/surfaces/:agent', async (req, res, { params }) => {
  const s = await discoverSurface(params.agent);
  if (!s) return json(res, 404, { error: 'unknown agent' });
  json(res, 200, s);
});
// Start a local agent surface (Hermes only; spawns the real dashboard detached).
route('POST', '/api/agent-os/surfaces/:agent/start', async (req, res, { params }) => {
  if (denyUnprivileged(req, res)) return;
  if (params.agent !== 'hermes') return json(res, 400, { error: 'start is only supported for Hermes' });
  try {
    const started = startHermesDashboard();
    db.audit({ action: 'agent_os_start_surface', source: 'agent-os', result: `hermes dashboard pid ${started.pid}`, confidence: 100 });
    json(res, 200, { started: true, ...started });
  } catch (e) { json(res, 400, { error: e.message }); }
});

// Free Claude Code: run a FULL-ACCESS Claude Code job against this repo, the way
// the real CLI works — all tools, no permission prompts (operator-authorized via
// the dashboard). Output is stream-json so the panel can render tool calls and
// assistant text like the TUI. Passing `sessionId` resumes that conversation, so
// the panel is multi-turn. The prompt is fed on stdin.
route('POST', '/api/agent-os/claude-code/run', async (req, res, { body }) => {
  if (denyUnprivileged(req, res)) return;
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json(res, 400, { error: 'prompt is required' });
  if (prompt.length > 16000) return json(res, 400, { error: 'prompt too long (max 16000 chars)' });
  const bin = resolveBin('claude');
  if (!bin) return json(res, 400, { error: 'Claude Code CLI not found on this machine' });
  const resume = typeof body.sessionId === 'string' && /^[\w-]{8,}$/.test(body.sessionId) ? body.sessionId : null;
  // stream-json requires --verbose in --print mode. --dangerously-skip-permissions
  // gives the panel the real Claude Code behaviour the operator asked for.
  const args = ['--print', '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--add-dir', PROJECT_ROOT];
  if (resume) args.push('--resume', resume);
  const shownCommand = `claude --print --output-format stream-json --verbose --dangerously-skip-permissions${resume ? ' --resume ' + resume : ''}`;
  db.audit({ action: 'agent_os_claude_run', source: 'agent-os', result: resume ? 'continued (full access)' : 'started (full access)', confidence: 100 });
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  res.write(JSON.stringify({ t: 'start', command: shownCommand, mode: 'full-access', resumed: !!resume }) + '\n');
  streamClaudeCodeJson(res, bin, args, prompt);
});

// Gemini CLI: run a job through the user's logged-in Gemini CLI. Text output is
// streamed back. `yolo` auto-approves all tools (full power); otherwise the CLI
// runs in default (read-mostly) mode. `resume` continues the latest session.
route('POST', '/api/agent-os/gemini/run', async (req, res, { body }) => {
  if (denyUnprivileged(req, res)) return;
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json(res, 400, { error: 'prompt is required' });
  if (prompt.length > 16000) return json(res, 400, { error: 'prompt too long (max 16000 chars)' });
  const bin = resolveBin('gemini');
  if (!bin) return json(res, 400, { error: 'Gemini CLI not found on this machine' });
  if (!geminiAuthStatus().loggedIn) return json(res, 400, { error: 'Gemini CLI is not logged in. Run `gemini` in a terminal and choose "Login with Google".' });
  const model = String(body.model || 'gemini-2.5-flash');
  const args = ['-p', prompt, '-o', 'text', '-m', model];
  if (body.yolo === true) args.push('-y'); else args.push('--approval-mode', 'default');
  if (body.resume === true) args.push('-r', 'latest');
  const shown = `gemini -p … -o text -m ${model}${body.yolo ? ' -y' : ''}${body.resume ? ' -r latest' : ''}`;
  db.audit({ action: 'agent_os_gemini_run', source: 'agent-os', result: body.yolo ? 'started (yolo)' : 'started', confidence: 100 });
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  res.write(JSON.stringify({ t: 'start', command: shown }) + '\n');
  streamCli(res, bin, args, '');
});

// Memory: search the Obsidian vault notes (the real memory the panel surfaces).
route('GET', '/api/agent-os/memory/search', (req, res, { query }) => {
  const q = String(query.get('q') || '').trim();
  json(res, 200, { query: q, dir: VAULT_DIR, results: searchVaultMemory(q, 12) });
});

route('POST', '/api/agent-os/council', async (req, res, { body }) => {
  const idea = String(body.idea || body.prompt || '').trim();
  if (!idea) return json(res, 400, { error: 'idea is required' });
  if (idea.length > 12000) return json(res, 400, { error: 'idea too long (max 12000 chars)' });
  try {
    json(res, 200, await runCouncil(idea));
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// N2 Agent: the free/low-cost models available through the configured router
// (OpenRouter). Same provider Hermes uses (its default is openrouter/owl-alpha),
// so the dashboard can pick Owl Alpha, Nex-N2, and any :free model. Cached 5 min.
let _n2ModelsCache = null;
let _n2ModelsAt = 0;
route('GET', '/api/agent-os/n2/models', async (req, res) => {
  const r = n2Route();
  if (!r.hasKey) return json(res, 200, { models: [], note: 'no router key' });
  const now = Date.now();
  if (_n2ModelsCache && now - _n2ModelsAt < 300000) return json(res, 200, { models: _n2ModelsCache, cached: true });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(`${r.baseUrl}/models`, { headers: { authorization: `Bearer ${r.key}` }, signal: controller.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || `router returned HTTP ${resp.status}`);
    const all = Array.isArray(data.data) ? data.data : [];
    const isFree = (m) => /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0);
    const featured = ['openrouter/owl-alpha', 'nex-agi/nex-n2-pro:free'];
    const free = all.filter(isFree).map((m) => ({ id: m.id, name: m.name || m.id }));
    free.sort((a, b) => {
      const ai = featured.indexOf(a.id); const bi = featured.indexOf(b.id);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.name.localeCompare(b.name);
    });
    _n2ModelsCache = free; _n2ModelsAt = now;
    json(res, 200, { models: free, count: free.length });
  } catch (e) {
    json(res, 200, { models: _n2ModelsCache || [], error: e.name === 'AbortError' ? 'router timed out' : e.message });
  } finally { clearTimeout(t); }
});

// N2 Agent: proxy a single turn to the configured OpenAI-compatible endpoint.
// The key never reaches the browser; if none is configured we return setup steps.
route('POST', '/api/agent-os/n2/chat', async (req, res, { body }) => {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json(res, 400, { error: 'prompt is required' });
  if (prompt.length > 16000) return json(res, 400, { error: 'prompt too long (max 16000 chars)' });
  const r = n2Route();
  // Model picker: honor a requested model, else the env default.
  const reqModel = String(body.model || '').trim();
  const model = (reqModel && reqModel.length <= 120) ? reqModel : String(process.env.N2_MODEL || N2_DEFAULT_MODEL);
  if (!r.hasKey) {
    return json(res, 400, {
      error: 'N2 is not configured for this app',
      state: 'needs_api_key_or_router',
      setup: [
        'cd OpenAgenticOS',
        "printf '\\nOPENROUTER_API_KEY=your_openrouter_key_here\\nN2_MODEL=nex-agi/nex-n2-pro:free\\n' >> .env",
        'npm start',
      ],
    });
  }
  const history = Array.isArray(body.history)
    ? body.history.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-8)
    : [];
  const messages = [
    { role: 'system', content: 'You are the N2 agent inside OpenAgenticOS, a local-first agent operating dashboard. Do not claim to have made external writes or sends. Ask for approval before any outbound action.' },
    ...history,
    { role: 'user', content: prompt },
  ];
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(`${r.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${r.key}`,
        'HTTP-Referer': 'http://localhost:4100/#/agent-os/n2-agent',
        'X-Title': 'OpenAgenticOS - N2 Agent',
      },
      body: JSON.stringify({ model, messages, temperature: 0.4 }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return json(res, 502, { error: data.error?.message || `router returned HTTP ${resp.status}`, status: resp.status, route: r.route });
    const reply = data.choices?.[0]?.message?.content || '';
    db.audit({ action: 'agent_os_n2_chat', source: 'agent-os', result: `${r.route} ${model}`, confidence: 100 });
    json(res, 200, { ok: true, reply, model, route: r.route, usage: data.usage || null });
  } catch (e) {
    json(res, 502, { error: e.name === 'AbortError' ? 'N2 request timed out after 60s' : e.message, route: r.route });
  } finally {
    clearTimeout(t);
  }
});

route('GET', '/api/closeout', (req, res) => json(res, 200, svc.closeoutView()));

route('GET', '/api/accounts', (req, res, { query }) => json(res, 200, svc.listCards(filterFromQuery(query))));
route('GET', '/api/planned-outreach', (req, res) => json(res, 200, svc.plannedOutreachView()));

route('GET', '/api/accounts/:id', (req, res, { params }) => {
  const d = svc.detailView(Number(params.id));
  if (!d) return json(res, 404, { error: 'not found' });
  d.warmNetwork = matchAccount(d.account); // who you already know here, from the brain
  json(res, 200, d);
});

// Personal network (brain) joined to the pipeline — who you know + which accounts.
route('GET', '/api/network', (req, res) => {
  const { people, byStatus, count, vault } = networkSummary();
  const accounts = db.listAccounts();
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const people2 = people.map((p) => {
    const hay = `${p.company} ${p.text}`.toLowerCase();
    const accts = accounts
      .filter((a) => String(a.name || '').length >= 3 && new RegExp(`\\b${reEsc(String(a.name).toLowerCase())}\\b`).test(hay))
      .slice(0, 3).map((a) => ({ id: a.id, name: a.name, score: a.score, band: a.band }));
    return { ...p, accounts: accts };
  });
  json(res, 200, { count, byStatus, vault, people: people2 });
});

route('POST', '/api/accounts', async (req, res, { body }) => {
  if (!body.name && !body.website) return json(res, 400, { error: 'name or website required' });
  const a = db.createAccount(body);
  svc.rescoreAccount(a.id);
  db.audit({ account_id: a.id, action: 'manual_add_account', source: 'operator', result: a.name, confidence: 100 });
  json(res, 200, svc.detailView(a.id));
});

route('PATCH', '/api/accounts/:id', async (req, res, { params, body }) => {
  const id = Number(params.id);
  if (!db.getAccount(id)) return json(res, 404, { error: 'not found' });
  const allowed = ['name', 'website', 'rootly_customer', 'pagerduty_customer', 'incident_stack',
    'status_page_url', 'status_page_provider', 'status', 'notes', 'do_not_contact', 'next_action'];
  const patch = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  db.updateAccount(id, patch);
  const out = svc.rescoreAccount(id);
  db.audit({ account_id: id, action: 'edit_account', source: 'operator', result: Object.keys(patch).join(','), confidence: 100 });
  json(res, 200, svc.detailView(id));
});

route('DELETE', '/api/accounts/:id', (req, res, { params }) => json(res, 200, { deleted: db.deleteAccount(Number(params.id)) }));

route('POST', '/api/accounts/:id/research', async (req, res, { params }) => {
  try { json(res, 200, await runResearch(Number(params.id), { cfg })); }
  catch (e) { json(res, 400, { error: e.message }); }
});

route('POST', '/api/accounts/:id/approve', (req, res, { params }) => json(res, 200, svc.approveForSequencing(Number(params.id))));
route('POST', '/api/accounts/:id/status', async (req, res, { params, body }) => json(res, 200, svc.setStatus(Number(params.id), body.status)));

route('POST', '/api/accounts/:id/contacts', async (req, res, { params, body }) => {
  const c = svc.classifyAndAddContact(Number(params.id), body);
  svc.rescoreAccount(Number(params.id));
  json(res, 200, c);
});

route('POST', '/api/accounts/:id/callnotes', async (req, res, { params, body }) => {
  try {
    // With a contactId → LLM-enhanced single card. Without → template card per contact.
    const out = body.contactId
      ? await generateAndSave(Number(params.id), { contactId: body.contactId, cfg })
      : generateAllForAccount(Number(params.id));
    json(res, 200, out);
  } catch (e) { json(res, 400, { error: e.message }); }
});

route('POST', '/api/accounts/:id/research-brief', async (req, res, { params, body }) => {
  try {
    const out = await generateResearchBrief(Number(params.id), { contactId: body.contactId, cfg });
    json(res, 200, out);
  } catch (e) { json(res, 400, { error: e.message }); }
});

route('POST', '/api/accounts/:id/provider-brief', async (req, res, { params }) => {
  try { json(res, 200, await generateProviderAccountBrief(Number(params.id), { cfg })); }
  catch (e) { json(res, 400, { error: e.message }); }
});

route('GET', '/api/provider-settings', (req, res) => json(res, 200, { providers: allProviderStatuses(cfg) }));

route('POST', '/api/provider-settings/:provider', async (req, res, { params, body }) => {
  try { json(res, 200, saveProviderKey(params.provider, body.key || '')); }
  catch (e) { json(res, 400, { error: e.message }); }
});

route('POST', '/api/provider-settings/:provider/test', async (req, res, { params }) => {
  try {
    const key = getProviderKey(params.provider, cfg);
    const test = params.provider === 'sumble' ? await testSumble(key)
      : params.provider === 'commonRoom' ? await testCommonRoom(key)
      : params.provider === 'gemini' ? await testGemini(key, { cfg })
      : params.provider === 'amplemarket' ? await testAmplemarket(key)
      : { status: 'error', message: 'unknown provider' };
    const status = saveProviderTest(params.provider, test);
    json(res, 200, status);
  } catch (e) { json(res, 400, { error: e.message }); }
});

// ---- call queue (dial-ready list for the sheet + cockpit) ----
route('GET', '/api/queue', (req, res, { query }) => json(res, 200, getQueue({ status: query.get('status') || undefined })));
route('POST', '/api/queue/rebuild', (req, res) => json(res, 200, buildQueue()));
route('POST', '/api/queue/:id/status', (req, res, { params, body }) => {
  const item = db.setQueueStatus(Number(params.id), body.status || 'queued', body.outcome);
  if (!item) return json(res, 404, { error: 'not found' });
  json(res, 200, item);
});
route('POST', '/api/sheet/sync', async (req, res) => {
  try { json(res, 200, await syncDialSheet({ cfg })); }
  catch (e) { json(res, 400, { error: e.message }); }
});
// Manual trigger for the optional account monitor.
route('POST', '/api/monitor/run', async (req, res) => {
  try { json(res, 200, await runMonitor({ cfg })); }
  catch (e) { json(res, 400, { error: e.message }); }
});

// ---- cockpit (read by the Chrome-extension cockpit + /cockpit fallback page) ----
route('GET', '/api/cockpit/by-contact', (req, res, { query }) => {
  const payload = cockpitForQuery({
    phone: query.get('phone') || undefined,
    email: query.get('email') || undefined,
    linkedin: query.get('linkedin') || undefined,
    name: query.get('name') || undefined,
    account: query.get('account') || undefined,
  });
  if (!payload) return json(res, 404, { error: 'no matching contact', matched: false });
  json(res, 200, payload);
});
route('GET', '/api/cockpit/contact/:id', (req, res, { params }) => {
  const payload = cockpitForContactId(params.id);
  if (!payload) return json(res, 404, { error: 'not found' });
  json(res, 200, payload);
});
route('POST', '/api/cockpit/outcome', (req, res, { body }) => {
  const out = logOutcome(body || {});
  if (out.error) return json(res, 400, out);
  json(res, 200, out);
});

// ---- memory map graph (accounts ↔ people ↔ shared tech) ----
route('GET', '/api/graph', (req, res, { query }) => {
  const bands = (query.get('bands') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = query.get('limit') ? Math.max(1, Math.min(400, Number(query.get('limit')))) : 120;
  json(res, 200, buildGraph({ bands: bands.length ? bands : undefined, limit, includeTech: query.get('tech') !== 'false' }));
});

route('GET', '/api/contacts', (req, res) => json(res, 200, db.listAllContacts()));
route('GET', '/api/signals', (req, res, { query }) =>
  json(res, 200, query.get('kind') ? db.listSignalsByKind(query.get('kind'), 100) : db.listRecentSignals(100)));
route('GET', '/api/tasks', (req, res, { query }) => json(res, 200, db.listTasks({ status: query.get('status') || undefined })));
route('POST', '/api/tasks/:id/done', (req, res, { params }) => json(res, 200, db.completeTask(Number(params.id))));
route('GET', '/api/audit', (req, res, { query }) => json(res, 200, db.listAudit(query.get('accountId') ? Number(query.get('accountId')) : undefined, 150)));
route('GET', '/api/exports', (req, res) => json(res, 200, db.listExports()));

route('POST', '/api/import', async (req, res, { body }) => {
  if (denyUnprivileged(req, res)) return;
  let text = body.csv;
  if (!text && body.path) {
    if (!fs.existsSync(body.path)) return json(res, 400, { error: 'file not found: ' + body.path });
    text = fs.readFileSync(body.path, 'utf8');
  }
  if (!text) return json(res, 400, { error: 'provide { csv } text or { path }' });
  const out = body.type === 'contacts' ? importContactsCsv(text, { source: body.source || 'csv' }) : importAccountsCsv(text, { source: body.source || 'csv' });
  json(res, 200, out);
});

route('POST', '/api/research-all', async (req, res, { body }) => {
  try { json(res, 200, await runResearchBatch(idsFrom(body.ids), { cfg })); }
  catch (e) { json(res, 400, { error: e.message }); }
});
route('POST', '/api/rescore-all', (req, res) => json(res, 200, svc.rescoreAll()));

// Download a CSV directly (no file written).
route('GET', '/api/export', (req, res, { query }) => {
  const target = query.get('target') || 'apollo';
  const ids = query.get('status')
    ? db.listAccounts({ status: query.get('status') }).map((a) => a.id)
    : idsFrom(query.get('ids'));
  const built = target === 'amplemarket' ? buildAmplemarketCsv(ids) : buildApolloCsv(ids);
  send(res, 200, built.csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${target}_export.csv"` });
});

// Write a CSV to data/exports and log it.
route('POST', '/api/export', async (req, res, { body }) => {
  const out = writeExport(body.target === 'amplemarket' ? 'amplemarket' : 'apollo', idsFrom(Array.isArray(body.ids) ? body.ids.join(',') : body.ids));
  json(res, 200, { file: out.file, count: out.count, skipped: out.skipped });
});

// ================= STATIC =================
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS (cockpit endpoints + any allowlisted origins). Set before routing so
    // both preflight and real responses carry the headers.
    const allowOrigin = corsOriginFor(pathname, req.headers.origin);
    if (allowOrigin) {
      res.setHeader('access-control-allow-origin', allowOrigin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return serveStatic(res, path.join(DASH_DIR, 'index.html'));
    if (req.method === 'GET' && pathname === '/cockpit') return serveStatic(res, path.join(DASH_DIR, 'cockpit.html'));
    if (req.method === 'GET' && /^\/(app\.js|styles\.css|cockpit\.js)$/.test(pathname)) return serveStatic(res, path.join(DASH_DIR, pathname.slice(1)));

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = match(r.pattern, pathname);
      if (!params) continue;
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      return await r.handler(req, res, { params, body, query: url.searchParams });
    }
    send(res, 404, { error: 'not found', path: pathname });
  } catch (e) {
    console.error('[server] unhandled', e);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(cfg.port, cfg.host, () => {
  const displayHost = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host;
  console.log(`\n  OpenAgenticOS → http://${displayHost}:${cfg.port}`);
  console.log(`  research: ${cfg.flags.browserResearch ? 'LIVE web/provider' : 'local/offline (safe)'} | call notes: ${llmAvailable(cfg) ? 'LLM-enhanced' : 'templates'} | pushes: ${cfg.flags.apolloPush || cfg.flags.amplemarketPush ? 'ENABLED' : 'CSV-only'}`);
  console.log('');
});

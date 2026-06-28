// Tiny zero-dependency .env loader + typed config. No external packages.
// Mirrors the house style from voice-prospecting/src/config.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');

// Load .env into process.env (does not overwrite already-set vars).
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const str = (v, d = '') => (v === undefined ? d : v);

// sqlite:./data/gtm.db | ./data/gtm.db | /abs/path.db | :memory:
function resolveDbFile(url) {
  if (!url) return path.join(DATA_DIR, 'gtm.db');
  let p = url.replace(/^sqlite:(\/\/)?/i, '');
  if (p === ':memory:') return p;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export function getConfig() {
  loadEnv();
  const e = process.env;
  return {
    port: num(e.PORT, 4100),
    host: str(e.HOST, '127.0.0.1'),
    databaseFile: process.env.DATABASE_FILE || resolveDbFile(str(e.DATABASE_URL)),

    seller: {
      name: str(e.SELLER_NAME, 'Your Name'),
      company: str(e.SELLER_COMPANY, 'Your Company'),
    },

    sumble: {
      email: str(e.SUMBLE_EMAIL),
      password: str(e.SUMBLE_PASSWORD),
      apiKey: str(e.SUMBLE_API_KEY),
    },
    commonRoom: {
      apiKey: str(e.COMMON_ROOM_API_KEY),
    },
    apolloKey: str(e.APOLLO_API_KEY),
    amplemarketKey: str(e.AMPLEMARKET_API_KEY),

    llm: {
      openaiKey: str(e.OPENAI_API_KEY),
      anthropicKey: str(e.ANTHROPIC_API_KEY),
      geminiKey: str(e.GEMINI_API_KEY),
      googleKey: str(e.GOOGLE_API_KEY),
      googleProject: str(e.GOOGLE_CLOUD_PROJECT, str(e.GCLOUD_PROJECT, str(e.GOOGLE_PROJECT_ID))),
      googleLocation: str(e.GOOGLE_CLOUD_LOCATION, str(e.GOOGLE_VERTEX_LOCATION, 'us-central1')),
      model: str(e.LLM_MODEL, e.OPENAI_API_KEY ? 'gpt-4.1-mini' : 'claude-sonnet-4-6'),
    },

    flags: {
      browserResearch: bool(e.ENABLE_BROWSER_RESEARCH, false),
      apolloPush: bool(e.ENABLE_APOLLO_PUSH, false),
      amplemarketPush: bool(e.ENABLE_AMPLEMARKET_PUSH, false),
    },

    // Google Sheet dial list (optional call queue export) — see integrations/googleSheet.js.
    sheets: {
      credentials: str(e.GOOGLE_SHEETS_CREDENTIALS),        // path to service-account JSON
      credentialsJson: str(e.GOOGLE_SHEETS_CREDENTIALS_JSON), // or inline JSON
      sheetId: str(e.DIAL_SHEET_ID),
      tab: str(e.DIAL_SHEET_TAB, 'Dial List'),
      publicBase: str(e.COCKPIT_PUBLIC_URL),                 // base URL for /cockpit links in the sheet
    },

    // Optional local memory folder for persona talk tracks + hard copy rules.
    brainDir: str(e.BRAIN_DIR),
  };
}

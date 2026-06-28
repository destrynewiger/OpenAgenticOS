// SQLite schema for the command center. One source of truth for every research
// artifact the dashboard renders. Kept as plain DDL so it is trivial to audit.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  domain             TEXT,                       -- normalized host, used for dedupe
  website            TEXT,
  rootly_customer    TEXT NOT NULL DEFAULT 'unknown',   -- yes | no | unknown
  pagerduty_customer TEXT NOT NULL DEFAULT 'unknown',   -- yes | no | unknown
  incident_stack     TEXT,                       -- one-liner summary
  status_page_url    TEXT,
  status_page_provider TEXT,                      -- atlassian | incident.io | instatus | custom | unknown
  score              INTEGER NOT NULL DEFAULT 0,
  band               TEXT NOT NULL DEFAULT 'low', -- work_today | sequence_week | research_more | low | blocked
  status             TEXT NOT NULL DEFAULT 'research_needed',
                     -- research_needed | ready_to_sequence | ready_to_call | already_worked | blocked
  do_not_contact     INTEGER NOT NULL DEFAULT 0,
  next_action        TEXT,
  score_reasons      TEXT,                        -- JSON array of strings
  notes              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_domain ON accounts(domain) WHERE domain IS NOT NULL AND domain <> '';

CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT,
  title         TEXT,
  email         TEXT,
  phone         TEXT,
  linkedin      TEXT,
  location      TEXT,        -- city / region / country, from Amplemarket
  persona_level TEXT,        -- end_user | manager | decision_maker | department_head
  persona_role  TEXT,        -- e.g. SRE, CTO, Platform Manager
  source        TEXT,
  confidence    INTEGER NOT NULL DEFAULT 50,  -- 0-100
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);

CREATE TABLE IF NOT EXISTS signals (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,   -- new_to_role | pagerduty_detected | incident_stack | status_page |
                               -- outage | eval | infra_scaling | ai_initiative | filing_quote | missing_data
  label       TEXT NOT NULL,
  detail      TEXT,
  source      TEXT,
  url         TEXT,
  confidence  INTEGER NOT NULL DEFAULT 50,
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_account ON signals(account_id);
CREATE INDEX IF NOT EXISTS idx_signals_kind ON signals(kind);

CREATE TABLE IF NOT EXISTS tech_stack (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  category   TEXT,            -- incident | observability | chatops | itsm | cloud | other
  source     TEXT,
  confidence INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stack_account ON tech_stack(account_id);

CREATE TABLE IF NOT EXISTS status_pages (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url           TEXT,
  provider      TEXT,
  last_incident TEXT,
  source        TEXT,
  checked_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_account ON status_pages(account_id);

CREATE TABLE IF NOT EXISTS research_quotes (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  quote          TEXT NOT NULL,
  source_name    TEXT,
  source_date    TEXT,
  url            TEXT,
  interpretation TEXT,        -- "Why this matters"
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_account ON research_quotes(account_id);

CREATE TABLE IF NOT EXISTS call_notes (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id     INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  why_person     TEXT,
  likely_pain    TEXT,
  opening_line   TEXT,
  rootly_angle   TEXT,
  good_question  TEXT,
  likely_objection TEXT,
  best_response  TEXT,
  next_step      TEXT,
  generated_by   TEXT NOT NULL DEFAULT 'template',  -- template | llm
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_callnotes_account ON call_notes(account_id);
CREATE INDEX IF NOT EXISTS idx_callnotes_contact ON call_notes(contact_id);

CREATE TABLE IF NOT EXISTS research_briefs (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  likely_pain      TEXT NOT NULL,
  questions_json   TEXT NOT NULL,
  linkedin_touch   TEXT NOT NULL,
  email_draft      TEXT NOT NULL,
  prompt_version   TEXT NOT NULL,
  generated_by     TEXT NOT NULL DEFAULT 'template', -- openai | anthropic | gemini | template
  model            TEXT,
  source_snapshot  TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_briefs_account ON research_briefs(account_id);
CREATE INDEX IF NOT EXISTS idx_research_briefs_contact ON research_briefs(contact_id);

CREATE TABLE IF NOT EXISTS account_briefs (
  id                 INTEGER PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  company_overview   TEXT NOT NULL,
  incident_stack     TEXT NOT NULL,
  recent_signals_json TEXT NOT NULL,
  people_json        TEXT NOT NULL,
  why_care           TEXT NOT NULL,
  outbound_angle     TEXT NOT NULL,
  call_prep_notes    TEXT NOT NULL,
  sources_json       TEXT NOT NULL,
  provider_status_json TEXT NOT NULL,
  generated_by       TEXT NOT NULL DEFAULT 'system',
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_briefs_account ON account_briefs(account_id);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  kind       TEXT,            -- next_action | missing_data | follow_up
  status     TEXT NOT NULL DEFAULT 'open',  -- open | done
  created_at TEXT NOT NULL,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);

CREATE TABLE IF NOT EXISTS sequence_exports (
  id            INTEGER PRIMARY KEY,
  target        TEXT NOT NULL,   -- apollo | amplemarket
  file_path     TEXT,
  account_count INTEGER NOT NULL DEFAULT 0,
  contact_count INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_exports (
  id             INTEGER PRIMARY KEY,
  export_id      INTEGER REFERENCES sequence_exports(id) ON DELETE CASCADE,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target         TEXT NOT NULL,   -- apollo | amplemarket
  contact_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_exports_account ON account_exports(account_id);
CREATE INDEX IF NOT EXISTS idx_account_exports_target ON account_exports(target);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,   -- what was searched / done
  query      TEXT,
  source     TEXT,            -- sumble | web | fixture | manual | apollo | amplemarket | system
  result     TEXT,            -- short human summary of what came back
  confidence INTEGER,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log(account_id);

CREATE TABLE IF NOT EXISTS call_queue (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id     INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  rank           INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'queued',  -- queued | dialed | connected | done | skipped
  why_now        TEXT,
  sheet_row      INTEGER,
  outcome        TEXT,
  last_dialed_at TEXT,
  queued_at      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_queue_rank ON call_queue(rank);
CREATE INDEX IF NOT EXISTS idx_call_queue_contact ON call_queue(contact_id);

CREATE TABLE IF NOT EXISTS call_log (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  queue_id    INTEGER REFERENCES call_queue(id) ON DELETE SET NULL,
  outcome     TEXT NOT NULL,   -- connected | voicemail | no_answer | meeting_booked | not_interested | bad_number | callback | other
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_log_account ON call_log(account_id);
CREATE INDEX IF NOT EXISTS idx_call_log_contact ON call_log(contact_id);

-- Trellus dialer sessions, synced verbatim from the Trellus API (read-only mirror).
-- Not FK'd to accounts/contacts: Trellus is its own source of truth, matched by
-- phone/name in the UI rather than at write time. ponytail: flat mirror, add
-- account_id resolution only if the dashboard needs cross-linking.
CREATE TABLE IF NOT EXISTS trellus_sessions (
  session_id     TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,        -- ISO 8601
  started_unix   INTEGER NOT NULL,     -- epoch seconds, for ordering/range
  direction      TEXT,                 -- inbound | outbound
  duration_sec   REAL,
  sip_code       INTEGER,
  customer_name  TEXT,
  company_name   TEXT,
  customer_phone TEXT,
  agent_phone    TEXT,
  disposition    TEXT,
  sentiment      TEXT,
  purpose        TEXT,
  synced_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trellus_started ON trellus_sessions(started_unix DESC);
`;

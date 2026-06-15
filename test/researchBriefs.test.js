import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetForTests } from '../src/db.js';
import * as db from '../src/models.js';
import { classifyAndAddContact, rescoreAccount, detailView } from '../src/service.js';
import { generateResearchBrief, RESEARCH_SYSTEM_PROMPT } from '../src/researchBriefs.js';
import { llmProvider } from '../src/llm.js';

const noLlmCfg = {
  llm: { openaiKey: '', anthropicKey: '', geminiKey: '', googleKey: '', model: '' },
};

test('research system prompt requires strict JSON and no invented facts', () => {
  assert.match(RESEARCH_SYSTEM_PROMPT, /STRICT JSON/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /Do not invent customer status/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /under 60 words/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /likely_pain/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /questions_to_ask/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /linkedin_touch/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /email_draft/);
});

test('OpenAI key selects the OpenAI provider', () => {
  assert.equal(llmProvider({ llm: { openaiKey: 'sk-test', anthropicKey: '', geminiKey: '' } }), 'openai');
});

test('research brief fallback persists structured JSON without inventing stack facts', async () => {
  resetForTests();
  const a = db.createAccount({
    name: 'Acme Reliability',
    website: 'acme.example',
    rootly_customer: 'unknown',
    pagerduty_customer: 'unknown',
  });
  const c = classifyAndAddContact(a.id, {
    name: 'Jane Doe',
    title: 'VP of Engineering',
    email: 'jane@acme.example',
    source: 'unit',
  });
  rescoreAccount(a.id);
  const brief = await generateResearchBrief(a.id, { contactId: c.id, cfg: noLlmCfg });
  assert.equal(brief.generated_by, 'template');
  assert.ok(!/PagerDuty usage is unknown|Incident stack is unknown|needs verification/i.test(brief.likely_pain));
  assert.ok(!/PagerDuty|incident stack/i.test(brief.likely_pain));
  assert.ok(Array.isArray(brief.questions_to_ask));
  assert.ok(brief.questions_to_ask.length >= 3);
  assert.ok(brief.linkedin_touch.includes('Jane'));
  assert.ok(brief.email_draft.split(/\s+/).filter(Boolean).length <= 60);

  const detail = detailView(a.id);
  assert.equal(detail.latestResearchBrief.id, brief.id);
  assert.equal(detail.researchBriefs.length, 1);
});

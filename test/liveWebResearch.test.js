import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchWeb } from '../src/research/web.js';
import { resetForTests } from '../src/db.js';
import * as db from '../src/models.js';
import { runResearch } from '../src/research/index.js';

function response(body, { url = '', ok = true, status = 200, contentType = 'text/html' } = {}) {
  return {
    ok,
    status,
    url,
    headers: new Map([['content-type', contentType]]),
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

test('browserResearch performs real public web research from search results and pages', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://duckduckgo.com/html/') || u.startsWith('https://html.duckduckgo.com/html/')) {
      return response(`
        <div class="result results_links web-result">
          <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.pagerduty.com%2Fcustomers%2Facme-reliability%2F&amp;rut=abc">Acme Reliability improves incident response with PagerDuty</a></h2>
          <a class="result__snippet">Acme Reliability uses PagerDuty for on-call escalation and incident response across its cloud platform.</a>
        </div>
        <div class="result results_links web-result">
          <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.acme.example/news/ai-scale">Acme Reliability launches AI operations platform</a></h2>
          <a class="result__snippet">Acme Reliability is scaling AI workflows for enterprise financial-services teams.</a>
        </div>
        <div class="result results_links web-result">
          <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://status.acme.example/">Acme Reliability Status</a></h2>
          <a class="result__snippet">All systems operational.</a>
        </div>
      `, { url: u });
    }
    if (u === 'https://status.acme.example' || u === 'https://status.acme.example/') {
      return response('<html><title>Acme Reliability Status</title><body>All Systems Operational</body></html>', { url: 'https://status.acme.example/' });
    }
    if (u === 'https://acme.example' || u === 'https://www.acme.example') {
      return response('<html><title>Acme Reliability</title><body>Enterprise AI operations platform for financial services.</body></html>', { url: u });
    }
    if (u.includes('pagerduty.com/customers/acme-reliability')) {
      return response('<html><title>Acme Reliability and PagerDuty</title><body>Acme Reliability uses PagerDuty for on-call escalation, incident response, and service reliability.</body></html>', { url: u });
    }
    return response('', { url: u, ok: false, status: 404 });
  };

  const out = await researchWeb({
    name: 'Acme Reliability',
    domain: 'acme.example',
    cfg: { flags: { browserResearch: true } },
  });

  assert.equal(out.source, 'web-live');
  assert.equal(out.pagerDutyCustomer, 'yes');
  assert.equal(out.statusPage.url, 'https://status.acme.example/');
  assert.ok(out.tech.some((t) => t.tool === 'PagerDuty'));
  assert.ok(out.signals.some((s) => s.kind === 'ai_initiative'));
  assert.ok(out.quotes.some((q) => /PagerDuty|AI operations/.test(q.quote)));
  assert.match(out.note, /live public web research/);
});

test('runResearch persists live web tech, incident stack, signals, and quotes', async (t) => {
  resetForTests();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://duckduckgo.com/html/') || u.startsWith('https://html.duckduckgo.com/html/')) {
      return response(`
        <div class="result results_links web-result">
          <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.pagerduty.com/customers/acme-reliability/">Acme Reliability improves incident response with PagerDuty</a></h2>
          <a class="result__snippet">Acme Reliability uses PagerDuty for on-call escalation and incident response.</a>
        </div>
        <div class="result results_links web-result">
          <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.acme.example/news/ai-scale">Acme Reliability launches AI operations platform</a></h2>
          <a class="result__snippet">Acme Reliability is scaling AI workflows for enterprise financial-services teams.</a>
        </div>
      `, { url: u });
    }
    if (u === 'https://status.acme.example' || u === 'https://status.acme.example/') {
      return response('<html><title>Acme Status</title><body>All Systems Operational</body></html>', { url: 'https://status.acme.example/' });
    }
    if (u === 'https://acme.example' || u === 'https://www.acme.example') {
      return response('<html><title>Acme Reliability</title><body>Enterprise AI operations platform.</body></html>', { url: u });
    }
    if (u.includes('pagerduty.com/customers/acme-reliability')) {
      return response('<html><body>Acme Reliability uses PagerDuty for on-call escalation and incident response.</body></html>', { url: u });
    }
    return response('', { url: u, ok: false, status: 404 });
  };

  const a = db.createAccount({ name: 'Acme Reliability', website: 'acme.example' });
  await runResearch(a.id, { cfg: { flags: { browserResearch: true }, sumble: {}, llm: {} }, withCallNotes: false });

  const fresh = db.getAccount(a.id);
  assert.equal(fresh.pagerduty_customer, 'yes');
  assert.match(fresh.incident_stack, /PagerDuty/);
  assert.ok(db.listTech(a.id).some((t) => t.tool === 'PagerDuty'));
  assert.ok(db.listSignals(a.id).some((s) => s.kind === 'ai_initiative'));
  assert.ok(db.listQuotes(a.id).length >= 1);
});

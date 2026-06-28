import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEBBRIDGE = 'http://127.0.0.1:10086';
const SESSION = 'account-cockpit-sync';

function curl(body) {
  const cmd = `curl -s -X POST ${WEBBRIDGE}/command -H 'Content-Type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
  return execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
}

function parse(res) {
  try {
    const data = JSON.parse(res);
    if (!data.ok) throw new Error(data.error?.message || JSON.stringify(data.error));
    return data.data;
  } catch (e) {
    throw new Error(`WebBridge error: ${e.message}. Raw: ${res.slice(0, 200)}`);
  }
}

async function navigate(url, newTab = false) {
  return parse(curl({ action: 'navigate', args: { url, newTab, group_title: 'Account Cockpit — Apollo' }, session: SESSION }));
}

async function evaluate(code) {
  return parse(curl({ action: 'evaluate', args: { code: `(() => { ${code} })()` }, session: SESSION }));
}

async function click(selector) {
  return parse(curl({ action: 'click', args: { selector }, session: SESSION }));
}

async function fill(selector, value) {
  return parse(curl({ action: 'fill', args: { selector, value }, session: SESSION }));
}

async function snapshot() {
  return parse(curl({ action: 'snapshot', args: {}, session: SESSION }));
}

async function screenshot() {
  return parse(curl({ action: 'screenshot', args: { format: 'png', quality: 80 }, session: SESSION }));
}

async function closeSession() {
  return parse(curl({ action: 'close_session', args: {}, session: SESSION }));
}

// Apollo browser automation: create a note on the company page with the brief
export async function syncBriefToApolloBrowser({ companyId, domain, briefText, skipTour = true }) {
  if (!companyId && !domain) throw new Error('Need companyId or domain');

  try {
    // Navigate to company page
    if (companyId) {
      await navigate(`https://app.apollo.io/#/accounts/${companyId}`);
    } else {
      // Search by domain via people search, extract company link, then navigate
      await navigate(`https://app.apollo.io/#/people?q_keywords=${encodeURIComponent(domain)}`);
      await new Promise(r => setTimeout(r, 2000));
      const link = await evaluate(`
        const cells = Array.from(document.querySelectorAll('td, [role="gridcell"]'));
        const companyCell = cells.find(c => c.textContent.includes('${domain.split('.')[0]}'));
        if (!companyCell) return null;
        const link = companyCell.querySelector('a[href*="/accounts/"]');
        return link ? link.href : null;
      `);
      if (link?.value) {
        await navigate(link.value);
      } else {
        throw new Error(`Could not find Apollo company for domain ${domain}`);
      }
    }

    await new Promise(r => setTimeout(r, 2000));

    // Click "Create note"
    await evaluate(`
      const btn = Array.from(document.querySelectorAll('button')).find(el => el.getAttribute('aria-label') === 'Create note');
      if (btn) btn.click();
    `);

    await new Promise(r => setTimeout(r, 1500));

    // Dismiss tour if present
    if (skipTour) {
      await evaluate(`
        const el = document.querySelector('a.zp_sEcm8.zp_zDpQp.text-body-sm-regular.zp_kQjro');
        if (el) el.click();
      `);
      await new Promise(r => setTimeout(r, 500));
    }

    // Fill note editor
    await fill('.tiptap.ProseMirror', briefText);

    // Save note
    await evaluate(`
      const btn = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim().includes('Save note'));
      if (btn) btn.click();
    `);

    await new Promise(r => setTimeout(r, 1500));

    return { ok: true, provider: 'apollo', method: 'browser', companyId: companyId || 'resolved-from-domain' };
  } catch (e) {
    return { ok: false, provider: 'apollo', method: 'browser', error: e.message };
  }
}

// Amplemarket browser automation: update account notes
export async function syncBriefToAmplemarketBrowser({ companyId, domain, briefText }) {
  if (!companyId && !domain) throw new Error('Need companyId or domain');

  try {
    if (companyId) {
      await navigate(`https://app.amplemarket.com/dashboard/company/${companyId}?tab=activity`, true);
    } else {
      // TODO: implement search by domain in Amplemarket browser
      throw new Error('Amplemarket browser automation requires companyId. Domain search not yet implemented.');
    }

    await new Promise(r => setTimeout(r, 2000));

    // TODO: find the notes/activity field and fill it
    // Amplemarket UI exploration needed: the notes field might be in the activity tab
    // or in a "Notes" section of the company page

    return { ok: false, provider: 'amplemarket', method: 'browser', error: 'Not yet implemented — Amplemarket UI patterns need exploration.' };
  } catch (e) {
    return { ok: false, provider: 'amplemarket', method: 'browser', error: e.message };
  }
}

// Main entry point: sync brief to both CRMs via browser
export async function syncBriefToCrmBrowser(accountId, briefText, { apolloCompanyId = null, apolloDomain = null, amplemarketCompanyId = null, amplemarketDomain = null } = {}) {
  const results = { apollo: null, amplemarket: null };

  if (apolloCompanyId || apolloDomain) {
    results.apollo = await syncBriefToApolloBrowser({ companyId: apolloCompanyId, domain: apolloDomain, briefText });
  }

  if (amplemarketCompanyId || amplemarketDomain) {
    results.amplemarket = await syncBriefToAmplemarketBrowser({ companyId: amplemarketCompanyId, domain: amplemarketDomain, briefText });
  }

  return results;
}

// CLI entry point
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const briefText = process.argv[2] || 'Account Brief — test';
  const apolloId = process.argv[3] || null;
  const apolloDomain = process.argv[4] || null;

  syncBriefToApolloBrowser({ companyId: apolloId, domain: apolloDomain, briefText })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      return closeSession();
    })
    .catch(e => {
      console.error('Browser sync failed:', e);
      closeSession().catch(() => {});
      process.exit(1);
    });
}

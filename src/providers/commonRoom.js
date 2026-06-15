import { fetchJson, safeError } from './http.js';

const BASE = 'https://api.commonroom.io/community/v1';

function auth(key) {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

export async function testCommonRoom(key, { fetchFn } = {}) {
  if (!key) return { status: 'missing', message: 'No Common Room key provided' };
  try {
    const data = await fetchJson(`${BASE}/api-token-status`, { headers: auth(key), fetchFn });
    return { status: 'connected', message: `Connected${data.communityName ? ` to ${data.communityName}` : ''}` };
  } catch (e) {
    return { status: 'error', message: safeError(e) };
  }
}

export async function researchWithCommonRoom(account, contacts, key, { fetchFn } = {}) {
  if (!key) return { provider: 'commonRoom', used: false, error: 'missing key', data: null };
  const out = { provider: 'commonRoom', used: true, error: '', data: { members: [], signals: [], sources: [] } };
  try {
    for (const c of contacts.slice(0, 8)) {
      let data = null;
      if (c.email) {
        try { data = await fetchJson(`${BASE}/user/${encodeURIComponent(c.email)}`, { headers: auth(key), fetchFn }); }
        catch (e) { if (e.status !== 404) throw e; }
      }
      if (!data && c.linkedin) {
        const li = c.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\//, '');
        try { data = await fetchJson(`${BASE}/members?linkedin=${encodeURIComponent(li)}`, { headers: auth(key), fetchFn }); }
        catch (e) { if (e.status !== 404) throw e; }
      }
      const member = Array.isArray(data) ? data[0] : data;
      if (!member) continue;
      out.data.members.push({
        name: member.fullName || c.name,
        title: member.title || c.title,
        organization: member.organization || account.name,
        activities_count: member.activities_count ?? '',
        first_seen: member.first_seen || '',
        last_active: member.last_active || '',
        tags: member.member_tags || [],
        segments: (member.segments || []).map((s) => s.name || s.id).filter(Boolean),
        url: member.common_room_member_url || member.url || '',
      });
      if (member.last_active || member.activities_count) {
        out.data.signals.push({
          label: `${member.fullName || c.name} has Common Room activity`,
          detail: `activities=${member.activities_count ?? 'unknown'}; last_active=${member.last_active || 'unknown'}`,
          url: member.common_room_member_url || member.url || '',
        });
      }
    }
    out.data.sources.push({ provider: 'commonRoom', label: 'Member lookup', url: 'https://api.commonroom.io/community/v1' });
  } catch (e) {
    out.error = safeError(e);
  }
  return out;
}

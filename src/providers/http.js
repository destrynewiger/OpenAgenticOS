export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 12000, fetchFn = fetch } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method,
      signal: ctrl.signal,
      headers: { accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { text: text.slice(0, 500) }; }
    if (!res.ok) {
      const msg = data?.reason || data?.message || data?.error?.message || res.statusText || 'request failed';
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

export function safeError(e) {
  return String(e?.message || e || 'unknown error').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]').slice(0, 260);
}

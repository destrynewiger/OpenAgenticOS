export function isPrivileged(req, env = process.env) {
  const token = String(env.OPS_TOKEN || '').trim();
  if (token && req.headers?.['x-ops-token'] === token) return true;
  const ra = req.socket?.remoteAddress || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

export function corsOriginFor(pathname, origin, env = process.env) {
  const allow = String(env.COCKPIT_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes('*')) return '*';
  if (origin && allow.includes(origin)) return origin;
  if ((pathname.startsWith('/api/cockpit') || pathname === '/cockpit')
      && origin && origin.startsWith('chrome-extension://')) return origin;
  return null;
}

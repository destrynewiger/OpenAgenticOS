// Robust, zero-dependency CSV parser + stringifier.
// Handles quoted fields, embedded commas/newlines, and "" escaped quotes.
// (Same battle-tested parser used across the GTM tooling.)

// Parse raw CSV text into an array of string arrays (rows).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  let sawAny = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  while (i < text.length) {
    const c = text[i];
    sawAny = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  if (sawAny && (field !== '' || row.length > 0)) endRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// Parse CSV into array of objects keyed by (trimmed) header row.
export function parseCsvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, records };
}

const needsQuote = (s) => /[",\n\r]/.test(s);
const escapeField = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return needsQuote(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// Stringify array of objects into CSV. `headers` controls column order.
export function stringifyCsv(objects, headers) {
  if (!headers) {
    const seen = [];
    const set = new Set();
    for (const o of objects) {
      for (const k of Object.keys(o)) {
        if (!set.has(k)) { set.add(k); seen.push(k); }
      }
    }
    headers = seen;
  }
  const lines = [headers.map(escapeField).join(',')];
  for (const o of objects) lines.push(headers.map((h) => escapeField(o[h])).join(','));
  return lines.join('\n') + '\n';
}

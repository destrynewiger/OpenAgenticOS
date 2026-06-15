// LLM provider abstraction. Zero deps — uses global fetch. The whole app works
// with NO key (callers fall back to deterministic templates). When a key exists,
// callers may ask for a better-written version. Never the source of facts.
import { getConfig } from './config.js';
import { generateGeminiText } from './providers/gemini.js';
import { hasGoogleAdcConfig } from './providers/googleAuth.js';

export function llmProvider(cfg = getConfig()) {
  if (cfg.llm.openaiKey) return 'openai';
  if (cfg.llm.anthropicKey) return 'anthropic';
  if (cfg.llm.geminiKey || cfg.llm.googleKey || hasGoogleAdcConfig(cfg)) return 'gemini';
  return null;
}
export function llmAvailable(cfg = getConfig()) { return !!llmProvider(cfg); }

async function withTimeout(promise, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await promise(ctrl.signal); } finally { clearTimeout(t); }
}

// Returns generated text, or null on any failure / missing key (→ template).
export async function generateText(prompt, { system = '', cfg = getConfig() } = {}) {
  const provider = llmProvider(cfg);
  if (!provider) return null;
  try {
    if (provider === 'openai') {
      const r = await withTimeout((signal) => fetch('https://api.openai.com/v1/responses', {
        method: 'POST', signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.llm.openaiKey}`,
        },
        body: JSON.stringify({
          model: cfg.llm.model || 'gpt-4.1-mini',
          input: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
          max_output_tokens: 1400,
        }),
      }));
      if (!r.ok) return null;
      const data = await r.json();
      if (data.output_text) return String(data.output_text).trim() || null;
      return (data.output || [])
        .flatMap((o) => o.content || [])
        .map((c) => c.text || '')
        .join('')
        .trim() || null;
    }
    if (provider === 'anthropic') {
      const r = await withTimeout((signal) => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.llm.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.llm.model || 'claude-sonnet-4-6',
          max_tokens: 1024,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
      }));
      if (!r.ok) return null;
      const data = await r.json();
      return (data.content || []).map((c) => c.text || '').join('').trim() || null;
    }
    if (provider === 'gemini') {
      return await generateGeminiText(cfg.llm.geminiKey || cfg.llm.googleKey || '', prompt, {
        cfg,
        system,
        maxOutputTokens: 1400,
      });
    }
  } catch {
    return null;
  }
  return null;
}

// Ask for JSON and parse it. Returns object or null. Tolerates ```json fences.
export async function generateJSON(prompt, opts = {}) {
  const text = await generateText(prompt, opts);
  if (!text) return null;
  try {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return JSON.parse(m ? m[1] : text);
  } catch {
    return null;
  }
}

import { fetchJson, safeError } from './http.js';
import { getGoogleAccessToken, hasGoogleAdcConfig, vertexGenerateContentUrl } from './googleAuth.js';

const MODEL = 'gemini-2.5-flash';

export async function testGemini(key, { fetchFn, cfg } = {}) {
  if (!key && !hasGoogleAdcConfig(cfg)) return { status: 'missing', message: 'No Gemini key provided; ADC needs GOOGLE_CLOUD_PROJECT' };
  try {
    const data = await generateGeminiText(key, 'Return exactly: ok', { fetchFn, cfg, maxOutputTokens: 64 });
    const source = key ? 'API key' : 'Google ADC';
    return data ? { status: 'connected', message: `Connected via ${source}` } : { status: 'error', message: `Connected via ${source}, but no text was returned` };
  } catch (e) {
    return { status: 'error', message: safeError(e) };
  }
}

export async function generateGeminiText(key, prompt, { fetchFn, cfg, maxOutputTokens = 900, system = '' } = {}) {
  if (!key && !hasGoogleAdcConfig(cfg)) throw new Error('No Gemini API key or Google ADC project configured');
  const url = key
    ? `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`
    : vertexGenerateContentUrl(cfg);
  const headers = key
    ? { 'content-type': 'application/json' }
    : { 'content-type': 'application/json', authorization: `Bearer ${getGoogleAccessToken()}` };
  const data = await fetchJson(url, {
    method: 'POST',
    headers,
    body: {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
    },
    fetchFn,
  });
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

export async function summarizeWithGemini(key, account, providerResults, { fetchFn, cfg } = {}) {
  if (!key && !hasGoogleAdcConfig(cfg)) return { provider: 'gemini', used: false, error: 'missing key or ADC config', data: null };
  try {
    const seller = String(cfg?.seller?.company || '').trim() || 'the seller';
    const prompt = `You are helping ${seller}. Summarize the grounded provider data into concise account research. Do not invent unknown facts. Return STRICT JSON with keys company_overview, why_care, outbound_angle, call_prep_notes.\n\nAccount:\n${JSON.stringify(account, null, 2)}\n\nProvider data:\n${JSON.stringify(providerResults, null, 2)}`;
    const text = await generateGeminiText(key, prompt, { fetchFn, cfg, maxOutputTokens: 1200 });
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const parsed = JSON.parse(m ? m[1] : text);
    return { provider: 'gemini', used: true, error: '', data: parsed };
  } catch (e) {
    return { provider: 'gemini', used: true, error: safeError(e), data: null };
  }
}

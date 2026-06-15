import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export function googleAdcConfig(cfg = {}) {
  const env = process.env;
  return {
    project: cfg.llm?.googleProject || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GOOGLE_PROJECT_ID || '',
    location: cfg.llm?.googleLocation || env.GOOGLE_CLOUD_LOCATION || env.GOOGLE_VERTEX_LOCATION || DEFAULT_LOCATION,
    model: /gemini/i.test(cfg.llm?.model || '') ? cfg.llm.model : DEFAULT_MODEL,
  };
}

export function hasGoogleAdcConfig(cfg = {}) {
  return !!googleAdcConfig(cfg).project;
}

export function googleAdcStatus(cfg = {}) {
  const adc = googleAdcConfig(cfg);
  if (!adc.project) {
    return {
      status: 'missing',
      source: 'none',
      message: 'No Gemini key saved; ADC needs GOOGLE_CLOUD_PROJECT',
    };
  }
  return {
    status: 'missing',
    source: 'google-adc',
    message: `ADC project ${adc.project}; test connection to verify local auth`,
  };
}

export function googleAdcSetupCommand() {
  return 'bash <(curl -sSL https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)';
}

export function getGoogleAccessToken() {
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const home = process.env.HOME || '';
  const localGcloud = home ? path.join(home, 'google-cloud-sdk', 'bin', 'gcloud') : '';
  const gcloud = localGcloud && fs.existsSync(localGcloud) ? localGcloud : 'gcloud';
  const python311 = home ? path.join(home, '.local', 'bin', 'python3.11') : '';
  const env = {
    ...process.env,
    ...(process.env.CLOUDSDK_PYTHON || !fs.existsSync(python311) ? {} : { CLOUDSDK_PYTHON: python311 }),
  };
  const out = spawnSync(gcloud, ['auth', 'application-default', 'print-access-token'], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  if (out.error?.code === 'ENOENT') {
    throw new Error(`Google ADC is not installed. Run: ${googleAdcSetupCommand()}`);
  }
  if (out.error) throw out.error;
  if (out.status !== 0) {
    const msg = (out.stderr || out.stdout || '').trim();
    throw new Error(msg || `Google ADC is not authenticated. Run: ${googleAdcSetupCommand()}`);
  }
  const token = (out.stdout || '').trim();
  if (!token) throw new Error(`Google ADC returned no token. Run: ${googleAdcSetupCommand()}`);
  return token;
}

export function vertexGenerateContentUrl(cfg = {}) {
  const adc = googleAdcConfig(cfg);
  if (!adc.project) throw new Error('GOOGLE_CLOUD_PROJECT is required for Google ADC');
  const loc = encodeURIComponent(adc.location);
  const project = encodeURIComponent(adc.project);
  const model = encodeURIComponent(adc.model);
  return `https://${loc}-aiplatform.googleapis.com/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`;
}

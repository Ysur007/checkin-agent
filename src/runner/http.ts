import { request } from 'undici';
import type { PluginRecord, RequestSpec } from '../types.js';
import { matchError } from '../plugins/rules.js';
import type { RunnerError } from './errors.js';

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  text: string;
  bytes: number;
  latencyMs: number;
  requestId: string | null;
  contentType: string;
}

export interface HttpOutcome {
  result?: HttpResult;
  error?: RunnerError;
}

export type Operation = 'summary' | 'claim' | 'verify';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '';
}

export async function performRequest(
  plugin: PluginRecord,
  operation: Operation,
  cookie: string,
  timeoutMs: number,
): Promise<HttpResult> {
  const spec = (operation === 'verify' ? plugin.adapter.requests.summary : plugin.adapter.requests[operation]) as RequestSpec;
  const url = new URL(spec.path, plugin.adapter.baseUrl);
  const started = Date.now();

  const headers: Record<string, string> = {
    ...plugin.adapter.defaultHeaders,
    cookie,
  };
  if (spec.method === 'GET') {
    delete headers['content-type'];
  }

  const response = await request(url, {
    method: spec.method,
    headers,
    body: spec.method === 'POST' ? JSON.stringify(spec.body ?? {}) : undefined,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  const text = await response.body.text();
  const latencyMs = Date.now() - started;
  const headersOut: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    headersOut[key.toLowerCase()] = headerValue(value);
  }

  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    status: response.statusCode,
    headers: headersOut,
    json,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    latencyMs,
    requestId: headersOut['cf-ray'] ?? headersOut['x-request-id'] ?? null,
    contentType: headersOut['content-type'] ?? '',
  };
}

export async function requestWithRetry(
  plugin: PluginRecord,
  operation: Operation,
  cookie: string,
  timeoutMs: number,
): Promise<HttpOutcome> {
  const maxAttempts = Math.min(plugin.adapter.retry.maxAttempts, plugin.manifest.limits.maxAttempts);
  const backoff = plugin.adapter.retry.backoffMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await performRequest(plugin, operation, cookie, timeoutMs);
      const match = matchError(result, plugin.adapter.errors);
      if (!match) {
        return { result };
      }
      if (match.retry && attempt < maxAttempts) {
        await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1500);
        continue;
      }
      return {
        result,
        error: {
          code: match.error as RunnerError['code'],
          message: `HTTP ${result.status}: ${match.error}`,
          httpStatus: result.status,
          retryable: match.retry,
        },
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timeout|aborted/i.test(`${name} ${message}`);
      const code = timedOut ? 'TIMEOUT' : 'NETWORK';
      if (attempt < maxAttempts) {
        await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1500);
        continue;
      }
      return { error: { code, message, retryable: true } };
    }
  }

  return { error: { code: 'NETWORK', message: 'request failed', retryable: true } };
}

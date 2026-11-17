import type { RunDetail } from './types';

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'HTTP_ERROR', status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function csrfToken(): string {
  const row = document.cookie.split('; ').find((item) => item.startsWith('ca_csrf='));
  const raw = row ? row.slice('ca_csrf='.length) : '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = csrfToken();

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
  });

  if (response.status === 204) return null as T;

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const payload = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      payload?.error?.code ?? 'HTTP_ERROR',
      response.status,
    );
  }

  return data as T;
}

export const get = <T>(path: string) => api<T>(path);

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

const TERMINAL = new Set([
  'succeeded',
  'already_claimed',
  'unverified',
  'needs_reauth',
  'rate_limited',
  'skipped',
  'failed',
]);

export async function waitForRun(runId: string, timeoutMs = 150000): Promise<RunDetail> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const detail = await get<RunDetail>(`/api/runs/${runId}`);
    if (TERMINAL.has(detail.run.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('等待运行结果超时，请到运行记录里查看');
}

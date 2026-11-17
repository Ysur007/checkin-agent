import type { ErrorRule, Rule } from '../types.js';

export interface HttpResponseLike {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  text: string;
}

export function evaluateRules(
  rules: Rule[],
  values: { summary?: Record<string, unknown>; claim?: Record<string, unknown>; verify?: Record<string, unknown> },
): string | null {
  for (const rule of rules) {
    const source = values[rule.source] ?? {};
    const actual = source[rule.field];
    if (compare(actual, rule.op, rule.value)) return rule.result;
  }
  return null;
}

function compare(actual: unknown, op: Rule['op'], expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'includes':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    default:
      return false;
  }
}

export interface ErrorMatch {
  error: string;
  retry: boolean;
}

export function matchError(response: HttpResponseLike, rules: ErrorRule[]): ErrorMatch | null {
  const json = (response.json ?? {}) as Record<string, unknown>;
  const bodyCode =
    typeof json.code === 'string' ? json.code : typeof json.error === 'string' ? json.error : undefined;
  const message = [json.detail, json.message, json.error, response.text]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const contentType = (response.headers['content-type'] ?? '').toLowerCase();

  for (const rule of rules) {
    if (rule.bodyCode && bodyCode !== rule.bodyCode) continue;
    if (rule.status && !rule.status.includes(response.status)) continue;
    if (rule.statusMin !== undefined && response.status < rule.statusMin) continue;
    if (rule.messageIncludes && !message.includes(rule.messageIncludes.toLowerCase())) continue;
    if (rule.contentTypeIncludes && !contentType.includes(rule.contentTypeIncludes.toLowerCase())) continue;
    return { error: rule.error, retry: Boolean(rule.retry) };
  }
  return null;
}

import crypto from 'node:crypto';

const SENSITIVE = /(breeze_blue_session|ca_session|ca_csrf|session|token|csrf|authorization|cookie|secret)/gi;
const PAIR = /([a-z0-9_\-]+)=([^;\s,]+)/gi;

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function fingerprintCookie(cookie: string): string {
  return sha256(cookie).slice(0, 12);
}

export function cookieFields(cookie: string): string[] {
  return cookie
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .filter(Boolean);
}

export function redactText(value: string, max = 500): string {
  const masked = value.replace(PAIR, (match, name: string) => {
    SENSITIVE.lastIndex = 0;
    return SENSITIVE.test(name) ? `${name}=***` : match;
  });
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}

export function redactDetail(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDetail);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(cookie|authorization|password|secret|token|csrf)/i.test(key)) {
        out[key] = '***';
      } else {
        out[key] = redactDetail(item);
      }
    }
    return out;
  }
  return value;
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactText(raw, 300);
}

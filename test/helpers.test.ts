import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seal, open } from '../src/crypto/seal';
import { redactText, redactDetail } from '../src/crypto/redact';
import { getPath } from '../src/plugins/jsonpath';
import { matchError } from '../src/plugins/rules';
import { hashJitter, localDate } from '../src/lib/time';
import adapterJson from '../plugins/breezeblue/adapter.json';

const adapter = adapterJson as unknown as {
  errors: Parameters<typeof matchError>[1];
};

describe('credential sealing', () => {
  const key = crypto.randomBytes(32);

  it('round-trips with AAD', () => {
    const sealed = seal('breeze_blue_session=secret', 'account:a:v1', key);
    expect(open(sealed, 'account:a:v1', key)).toBe('breeze_blue_session=secret');
  });

  it('fails on AAD mismatch', () => {
    const sealed = seal('breeze_blue_session=secret', 'account:a:v1', key);
    expect(() => open(sealed, 'account:b:v1', key)).toThrow();
  });

  it('never stores the plaintext in the envelope', () => {
    const sealed = seal('breeze_blue_session=secret', 'account:a:v1', key);
    expect(sealed.includes('breeze_blue_session')).toBe(false);
  });
});

describe('redaction', () => {
  it('masks cookie values but keeps the field name', () => {
    const text = 'cookie: breeze_blue_session=abc123; other=ok; token=xyz';
    const masked = redactText(text);
    expect(masked).toContain('breeze_blue_session=***');
    expect(masked).toContain('token=***');
    expect(masked).not.toContain('abc123');
  });

  it('masks sensitive object keys recursively', () => {
    const result = redactDetail({ cookie: 'secret', nested: { authorization: 'Bearer x', balance: 400 } }) as Record<string, unknown>;
    expect(result.cookie).toBe('***');
    expect((result.nested as Record<string, unknown>).authorization).toBe('***');
    expect((result.nested as Record<string, unknown>).balance).toBe(400);
  });
});

describe('path extraction', () => {
  it('reads nested objects and arrays', () => {
    const data = { a: { b: [{ c: 42 }] }, 'x-y': true };
    expect(getPath(data, '$.a.b[0].c')).toBe(42);
    expect(getPath(data, "$['x-y']")).toBe(true);
    expect(getPath(data, '$.missing.deep')).toBeUndefined();
  });
});

describe('error classification', () => {
  const response = (status: number, json: unknown = {}, contentType = 'application/json') => ({
    status,
    headers: { 'content-type': contentType },
    json,
    text: JSON.stringify(json),
  });

  it('classifies an expired cookie', () => {
    expect(matchError(response(401, { code: 'AUTH_REQUIRED' }), adapter.errors)?.error).toBe('AUTH_REQUIRED');
  });

  it('classifies a missing Origin', () => {
    expect(
      matchError(response(403, { detail: 'Request origin is not allowed' }), adapter.errors)?.error,
    ).toBe('ORIGIN_BLOCKED');
  });

  it('classifies a rate limit', () => {
    expect(matchError(response(429), adapter.errors)?.error).toBe('RATE_LIMITED');
  });

  it('classifies 5xx as retryable', () => {
    const match = matchError(response(503), adapter.errors);
    expect(match?.error).toBe('HTTP_5XX');
    expect(match?.retry).toBe(true);
  });

  it('classifies an HTML challenge', () => {
    expect(matchError(response(200, {}, 'text/html'), adapter.errors)?.error).toBe('CHALLENGE_DETECTED');
  });
});

describe('time helpers', () => {
  it('uses Asia/Shanghai for the local date', () => {
    expect(localDate('Asia/Shanghai', new Date('2026-11-16T23:00:00Z'))).toBe('2026-11-17');
    expect(localDate('Asia/Shanghai', new Date('2026-11-17T16:30:00Z'))).toBe('2026-11-18');
  });

  it('keeps jitter deterministic', () => {
    expect(hashJitter('account-1', 240)).toBe(hashJitter('account-1', 240));
    expect(hashJitter('account-1', 240)).toBeLessThan(240);
  });
});

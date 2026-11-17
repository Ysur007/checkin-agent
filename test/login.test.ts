import { describe, expect, it } from 'vitest';
import { buildCookieHeader, cookieNamesOf, earliestExpiry, type BrowserCookie } from '../src/login/cookies.js';
import { assertSafeLoginUrl, safeDisplayUrl } from '../src/login/url.js';
import { cookieInScope, domainsFromLoginUrl, mergeDomains } from '../src/providers/catalog.js';

const cookies: BrowserCookie[] = [
  { name: 'session', value: 'abc', domain: '.example.com', path: '/', expires: 4_000_000_000 },
  { name: 'session', value: 'short', domain: '.example.com', path: '/', expires: 4_000_000_000 },
  { name: 'old', value: 'gone', domain: '.example.com', path: '/', expires: 1 },
  { name: 'theme', value: 'dark', domain: 'example.com', path: '/' },
];

describe('cookie header builder', () => {
  it('drops expired cookies and keeps one value per name', () => {
    const header = buildCookieHeader(cookies, 1_700_000_000_000);
    expect(header).toContain('session=short');
    expect(header).not.toContain('gone');
    expect(header.split('session=')).toHaveLength(2);
  });

  it('prefers the longer path for duplicate names', () => {
    const header = buildCookieHeader(
      [
        { name: 'sid', value: 'root', path: '/' },
        { name: 'sid', value: 'deep', path: '/app' },
      ],
      1_700_000_000_000,
    );
    expect(header).toBe('sid=deep');
  });

  it('reports the earliest expiry and ignores session cookies', () => {
    expect(earliestExpiry(cookies)).toBe(new Date(4_000_000_000 * 1000).toISOString());
    expect(earliestExpiry([{ name: 'a', value: 'b' }])).toBeNull();
  });

  it('lists names without values', () => {
    const names = cookieNamesOf(cookies);
    expect(names.sort()).toEqual(['old', 'session', 'theme']);
    expect(names.join(',')).not.toContain('abc');
  });
});

describe('cookie scoping', () => {
  it('stays inside the declared domain and its subdomains', () => {
    expect(cookieInScope('.breezeblue.ai', ['breezeblue.ai'])).toBe(true);
    expect(cookieInScope('app.breezeblue.ai', ['breezeblue.ai'])).toBe(true);
    expect(cookieInScope('.evilbreezeblue.ai', ['breezeblue.ai'])).toBe(false);
    expect(cookieInScope('.other.com', ['breezeblue.ai'])).toBe(false);
  });

  it('derives a scope from the login page and merges duplicates', () => {
    expect(domainsFromLoginUrl('https://www.example.com/login?x=1')).toEqual(['example.com']);
    expect(mergeDomains(['a.com', '.a.com'], ['b.a.com', ''])).toEqual(['a.com', 'b.a.com']);
    expect(domainsFromLoginUrl('not a url')).toEqual([]);
  });
});

describe('login url guard', () => {
  it('rejects private hosts unless explicitly allowed', () => {
    expect(() => assertSafeLoginUrl('https://127.0.0.1/login', false)).toThrow(/内网/);
    expect(() => assertSafeLoginUrl('https://192.168.1.8/login', false)).toThrow(/内网/);
    expect(assertSafeLoginUrl('http://127.0.0.1:8899/login', true).port).toBe('8899');
  });

  it('requires https and no embedded credentials', () => {
    expect(() => assertSafeLoginUrl('http://example.com', false)).toThrow(/https/);
    expect(() => assertSafeLoginUrl('https://user:pass@example.com', false)).toThrow(/账号密码/);
    expect(assertSafeLoginUrl('https://example.com/login', false).host).toBe('example.com');
  });

  it('strips query strings from display urls', () => {
    expect(safeDisplayUrl('https://example.com/app?token=secret#x')).toBe('https://example.com/app');
    expect(safeDisplayUrl('nope')).toBeNull();
  });
});

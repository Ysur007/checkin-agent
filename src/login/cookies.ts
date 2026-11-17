export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** 秒级时间戳；-1 表示会话 Cookie。 */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** 组装 Cookie 请求头：丢弃过期项，同名 Cookie 保留路径更长的一条。 */
export function buildCookieHeader(cookies: BrowserCookie[], now = Date.now()): string {
  const alive = cookies.filter((cookie) => {
    if (!cookie.name || cookie.value === undefined) return false;
    if (cookie.expires === undefined || cookie.expires <= 0) return true;
    return cookie.expires * 1000 > now;
  });

  const best = new Map<string, BrowserCookie>();
  for (const cookie of alive) {
    const current = best.get(cookie.name);
    if (!current || (cookie.path?.length ?? 0) >= (current.path?.length ?? 0)) {
      best.set(cookie.name, cookie);
    }
  }

  return [...best.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** 最早过期的那个 Cookie 的 ISO 时间；全是会话 Cookie 时返回 null。 */
export function earliestExpiry(cookies: BrowserCookie[], now = Date.now()): string | null {
  const times = cookies
    .map((cookie) => cookie.expires)
    .filter((value): value is number => typeof value === 'number' && value > 0 && value * 1000 > now)
    .map((value) => value * 1000);
  if (times.length === 0) return null;
  return new Date(Math.min(...times)).toISOString();
}

export function cookieNamesOf(cookies: BrowserCookie[]): string[] {
  return [...new Set(cookies.map((cookie) => cookie.name).filter(Boolean))].sort();
}

/** 在日志与运行事件里只出现字段名，不出现值。 */
export function describeCookieSet(cookies: BrowserCookie[]): string {
  return cookieNamesOf(cookies).join(', ');
}

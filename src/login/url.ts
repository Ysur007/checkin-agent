export class LoginError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
  }
}

/** 只允许 https（测试环境可显式放开 http），并拒绝把浏览器指向内网。 */
export function assertSafeLoginUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LoginError('INVALID_URL', '登录页地址无效，请填写完整的 https 地址');
  }
  if (url.username || url.password) {
    throw new LoginError('INVALID_URL', '登录页地址不能包含账号密码');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new LoginError('INVALID_URL', '登录页必须是 https 地址');
  }
  if (url.href.length > 600) throw new LoginError('INVALID_URL', '登录页地址过长');

  if (!allowPrivate) {
    const host = url.hostname.toLowerCase();
    const isPrivate =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^\[?::1\]?$/.test(host);
    if (isPrivate) {
      throw new LoginError('URL_NOT_ALLOWED', '不允许把登录窗口指向内网地址');
    }
  }
  return url;
}

/** 去掉查询串与片段，避免把 token 写进数据库或日志。 */
export function safeDisplayUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

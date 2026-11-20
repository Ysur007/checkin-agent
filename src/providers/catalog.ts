/**
 * 平台目录：只描述「怎么登录、抓哪些 Cookie、能否执行签到」。
 * 不包含任何平台密码，也不保存用户的登录凭据。
 *
 * 只收录已经接入签到适配器的平台：没有 adapter 的平台不会出现在这里，
 * 以免用户添加账号后才发现不能签到。新增平台时先写 plugins/<id>/，再在此登记。
 */
export interface ProviderDef {
  id: string;
  name: string;
  short: string;
  tint: string;
  description: string;
  loginUrl: string | null;
  /** Cookie 作用域（主机名后缀）。空数组表示从登录页地址推导。 */
  cookieDomains: string[];
  /** 判断登录完成的主 Cookie；null 表示用「页面没有密码框 + 已有 Cookie」判断。 */
  primaryCookie: string | null;
  checkIn: 'adapter' | 'none';
  adapterId?: string;
  category: 'agent' | 'custom';
  /** 首页/帮助链接，用于界面上的「打开官网」。 */
  homepage?: string;
  /** 额外的登录提示，显示在登录窗口里。 */
  hint?: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'breezeblue',
    name: 'BreezeBlue',
    short: 'B',
    tint: '#2563eb',
    description: '每日领取 400 免费积分，北京时间 08:00 重置',
    loginUrl: 'https://breezeblue.ai/app/home',
    cookieDomains: ['breezeblue.ai'],
    primaryCookie: 'breeze_blue_session',
    checkIn: 'adapter',
    adapterId: 'breezeblue',
    category: 'agent',
    homepage: 'https://breezeblue.ai',
  },
  {
    id: 'modelscope',
    name: '魔搭 ModelScope',
    short: '魔',
    tint: '#4f46e5',
    description: '每日登录领 200 魔粒，绑定阿里云账号再 +50',
    loginUrl: 'https://modelscope.cn/magicube/usage',
    cookieDomains: ['modelscope.cn'],
    primaryCookie: 'm_session_id',
    checkIn: 'adapter',
    adapterId: 'modelscope',
    category: 'agent',
    homepage: 'https://modelscope.cn/magicube/usage',
  },
];

export const CUSTOM_PROVIDER_ID = 'custom';

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function isKnownProvider(id: string): boolean {
  return PROVIDERS.some((provider) => provider.id === id);
}

/** 从登录页地址推导 Cookie 作用域：去掉 www.，其余子域都归入该后缀。 */
export function domainsFromLoginUrl(rawUrl: string): string[] {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!host || host.includes('..')) return [];
    return [host];
  } catch {
    return [];
  }
}

/** 只保留落在声明作用域内的 Cookie，避免把浏览器里其它站点的登录态一起带走。 */
export function cookieInScope(domain: string | undefined, allowed: string[]): boolean {
  if (!domain) return false;
  if (allowed.length === 0) return false;
  const host = domain.replace(/^\./, '').toLowerCase();
  return allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function mergeDomains(primary: string[], extra: string[]): string[] {
  const set = new Set<string>();
  for (const item of [...primary, ...extra]) {
    const value = item.trim().toLowerCase().replace(/^\./, '');
    if (value && !value.includes('/') && !value.includes(' ')) set.add(value);
  }
  return [...set];
}

/**
 * 平台目录：只描述「怎么登录、抓哪些 Cookie、能否执行签到」。
 * 不包含任何平台密码，也不保存用户的登录凭据。
 *
 * loginUrl 为 null 的平台，添加账号时必须由用户填写登录页地址；
 * 捕获时只接受该地址所在域及其子域的 Cookie。
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
    id: 'workbuddy',
    name: 'WorkBuddy',
    short: 'W',
    tint: '#0f9d6e',
    description: '登录后自动采集 Cookie；签到接口待适配',
    loginUrl: 'https://www.workbuddy.cn',
    cookieDomains: ['workbuddy.cn'],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
    homepage: 'https://www.workbuddy.cn',
    hint: '如果登录页跳转到其它域名，可在下方地址栏里改成实际登录页。',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    short: 'Q',
    tint: '#111827',
    description: '登录后自动采集 Cookie；签到接口待适配',
    loginUrl: 'https://qoder.com',
    cookieDomains: ['qoder.com'],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
    homepage: 'https://qoder.com',
  },
  {
    id: 'trae',
    name: 'Trae',
    short: 'T',
    tint: '#15803d',
    description: '登录后自动采集 Cookie；签到接口待适配',
    loginUrl: 'https://www.trae.ai',
    cookieDomains: ['trae.ai'],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
    homepage: 'https://www.trae.ai',
  },
  {
    id: 'cline',
    name: 'Cline',
    short: 'C',
    tint: '#0284c7',
    description: '登录后自动采集 Cookie；签到接口待适配',
    loginUrl: 'https://app.cline.bot',
    cookieDomains: ['cline.bot'],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
    homepage: 'https://cline.bot',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    short: 'K',
    tint: '#7c3aed',
    description: '登录后自动采集 Cookie；签到接口待适配',
    loginUrl: 'https://kiro.dev',
    cookieDomains: ['kiro.dev'],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
    homepage: 'https://kiro.dev',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    short: 'Cu',
    tint: '#18181b',
    description: '登录后自动采集 Cookie；签到接口待适配',
    loginUrl: 'https://cursor.com',
    cookieDomains: ['cursor.com'],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
    homepage: 'https://cursor.com',
  },
  {
    id: 'zhipu',
    name: '智谱清言',
    short: '智',
    tint: '#2563eb',
    description: '登录后自动采集 Cookie；签到接口待适配',
    loginUrl: 'https://chatglm.cn',
    cookieDomains: ['chatglm.cn'],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
    homepage: 'https://chatglm.cn',
  },
  {
    id: 'codearts',
    name: 'CodeArts',
    short: 'CA',
    tint: '#dc2626',
    description: '华为云登录态；签到接口待适配',
    loginUrl: 'https://codearts.huaweicloud.com',
    cookieDomains: ['huaweicloud.com'],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
    homepage: 'https://codearts.huaweicloud.com',
  },
  {
    id: 'zcode',
    name: 'ZCode',
    short: 'Z',
    tint: '#334155',
    description: '需要填写登录页地址后采集 Cookie',
    loginUrl: null,
    cookieDomains: [],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
  },
  {
    id: 'kukuai',
    name: 'KukuAI',
    short: 'Ku',
    tint: '#b45309',
    description: '需要填写登录页地址后采集 Cookie',
    loginUrl: null,
    cookieDomains: [],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
  },
  {
    id: 'monkeycode',
    name: 'MonkeyCode',
    short: 'M',
    tint: '#b45309',
    description: '需要填写登录页地址后采集 Cookie',
    loginUrl: null,
    cookieDomains: [],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
  },
  {
    id: 'accio',
    name: 'Accio',
    short: 'A',
    tint: '#0f766e',
    description: '需要填写登录页地址后采集 Cookie',
    loginUrl: null,
    cookieDomains: [],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
  },
  {
    id: 'catpaw',
    name: 'CatPaw',
    short: 'P',
    tint: '#4d7c0f',
    description: '需要填写登录页地址后采集 Cookie',
    loginUrl: null,
    cookieDomains: [],
    primaryCookie: null,
    checkIn: 'none',
    category: 'agent',
  },
];

export const CUSTOM_PROVIDER_ID = 'custom';

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function isKnownProvider(id: string): boolean {
  return id === CUSTOM_PROVIDER_ID || PROVIDERS.some((provider) => provider.id === id);
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

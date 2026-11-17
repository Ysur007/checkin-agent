import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { config } from '../config.js';
import {
  createLoginSessionRow,
  expireLoginSessions,
  getLoginSession,
  listOpenLoginSessions,
  updateLoginSession,
} from '../db/repo.js';
import { newId, nowIso } from '../db/repo.js';
import { logger } from '../logger.js';
import { redactText } from '../crypto/redact.js';
import { getProvider, mergeDomains, cookieInScope } from '../providers/catalog.js';
import type { LoginSessionRow, LoginSessionStatus } from '../types.js';
import { buildCookieHeader, cookieNamesOf, earliestExpiry, type BrowserCookie } from './cookies.js';
import { LoginError, assertSafeLoginUrl, safeDisplayUrl } from './url.js';

export type LoginAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; dy: number }
  | { type: 'goto'; url: string }
  | { type: 'reload' }
  | { type: 'back' };

const ALLOWED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

const LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface Runtime {
  session: LoginSessionRow;
  providerId: string;
  allowedDomains: string[];
  context: BrowserContext;
  page: Page;
  pollTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout;
  busy: boolean;
  closed: boolean;
}

interface StartInput {
  providerId: string;
  loginUrl: string;
  label: string;
  ownerSession: string;
  accountId: string | null;
}

function pickCookies(cookies: BrowserCookie[], allowed: string[]): BrowserCookie[] {
  return cookies.filter((cookie) => cookieInScope(cookie.domain, allowed));
}

async function hasPasswordField(page: Page): Promise<boolean> {
  try {
    return (await page.locator('input[type="password"]').count()) > 0;
  } catch {
    return false;
  }
}

export class LoginSessionManager {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly options: {
      allowPrivate: boolean;
      ttlMs: number;
      profileRoot: string;
      chromiumPath?: string;
    },
  ) {
    if (!fs.existsSync(this.options.profileRoot)) {
      fs.mkdirSync(this.options.profileRoot, { recursive: true, mode: 0o700 });
    }
    this.recoverOrphans();
  }

  private recoverOrphans(): void {
    const open = listOpenLoginSessions();
    for (const session of open) {
      updateLoginSession(session.id, {
        status: 'failed',
        lastError: '服务重启，登录窗口已关闭，请重新发起登录',
        closedAt: nowIso(),
      });
    }
    expireLoginSessions();
  }

  async available(): Promise<boolean> {
    try {
      await import('playwright-core');
      return true;
    } catch {
      return false;
    }
  }

  private runtime(id: string, owner: string): Runtime {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      const row = getLoginSession(id);
      if (!row) throw new LoginError('NOT_FOUND', '登录窗口不存在', 404);
      if (row.owner_session !== owner) throw new LoginError('FORBIDDEN', '这个登录窗口不属于当前会话', 403);
      throw new LoginError('SESSION_CLOSED', '登录窗口已关闭，请重新发起登录', 410);
    }
    if (runtime.session.owner_session !== owner) throw new LoginError('FORBIDDEN', '这个登录窗口不属于当前会话', 403);
    if (runtime.closed) throw new LoginError('SESSION_CLOSED', '登录窗口已关闭，请重新发起登录', 410);
    return runtime;
  }

  async start(input: StartInput): Promise<LoginSessionRow> {
    if (!config.browserLogin) {
      throw new LoginError('BROWSER_DISABLED', '当前部署关闭了浏览器登录，请使用手动 Cookie 录入', 503);
    }
    if (this.runtimes.size >= 3) {
      throw new LoginError('TOO_MANY_SESSIONS', '同时打开的登录窗口太多，请先关闭其它窗口', 429);
    }
    if (input.accountId) {
      for (const runtime of this.runtimes.values()) {
        if (runtime.session.account_id === input.accountId) {
          throw new LoginError('ALREADY_OPEN', '这个账号已经有一个登录窗口，请先关闭它', 409);
        }
      }
    }

    let chromium;
    try {
      ({ chromium } = await import('playwright-core'));
    } catch {
      throw new LoginError('BROWSER_UNAVAILABLE', '服务端没有安装浏览器组件，无法打开登录窗口', 503);
    }

    const provider = getProvider(input.providerId);
    const loginUrl = assertSafeLoginUrl(input.loginUrl, this.options.allowPrivate).href;
    const derived = new URL(loginUrl).hostname.replace(/^www\./, '');
    const allowedDomains = mergeDomains(provider?.cookieDomains ?? [], [derived]);
    if (allowedDomains.length === 0) throw new LoginError('INVALID_URL', '无法确定 Cookie 作用域');

    const id = newId();
    const expiresAt = new Date(Date.now() + this.options.ttlMs).toISOString();
    const row = createLoginSessionRow({
      id,
      providerId: input.providerId,
      accountId: input.accountId,
      ownerSession: input.ownerSession,
      label: input.label,
      loginUrl,
      expiresAt,
    });

    const profileDir = path.join(this.options.profileRoot, input.accountId ?? `guest-${id}`);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        viewport: { width: 1200, height: 760 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        userAgent: LOGIN_UA,
        ignoreHTTPSErrors: this.options.allowPrivate,
        acceptDownloads: false,
        executablePath: this.options.chromiumPath || undefined,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--hide-scrollbars',
          '--disable-features=Translate,MediaRouter',
        ],
      });
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error), 200);
      updateLoginSession(id, { status: 'failed', lastError: `无法启动浏览器：${message}`, closedAt: nowIso() });
      logger.error({ sessionId: id, error: message }, 'failed to launch login browser');
      throw new LoginError('BROWSER_LAUNCH_FAILED', '无法启动登录浏览器，请检查容器里的 Chromium 是否可用', 500);
    }

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(20_000);
    const runtime: Runtime = {
      session: row,
      providerId: input.providerId,
      allowedDomains,
      context,
      page,
      busy: false,
      closed: false,
      pollTimer: setInterval(() => void this.poll(id), 2_000),
      expiryTimer: setTimeout(() => void this.expire(id), this.options.ttlMs),
    };
    runtime.pollTimer.unref?.();
    runtime.expiryTimer.unref?.();
    this.runtimes.set(id, runtime);

    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error), 160);
      updateLoginSession(id, { status: 'waiting', lastError: `页面加载较慢：${message}` });
    }

    await this.sync(id);
    logger.info({ sessionId: id, providerId: input.providerId, host: new URL(loginUrl).host }, 'login session started');
    return getLoginSession(id)!;
  }

  list(): LoginSessionRow[] {
    return listOpenLoginSessions();
  }

  get(id: string, owner: string): LoginSessionRow {
    const row = getLoginSession(id);
    if (!row) throw new LoginError('NOT_FOUND', '登录窗口不存在', 404);
    if (row.owner_session !== owner) throw new LoginError('FORBIDDEN', '这个登录窗口不属于当前会话', 403);
    return row;
  }

  async frame(id: string, owner: string): Promise<Buffer> {
    const runtime = this.runtime(id, owner);
    if (runtime.busy) throw new LoginError('BUSY', '页面正在操作，请稍后', 409);
    try {
      return await runtime.page.screenshot({ type: 'jpeg', quality: 68, timeout: 10_000 });
    } catch (error) {
      throw new LoginError('FRAME_FAILED', `无法获取页面画面：${redactText(String(error), 120)}`, 502);
    }
  }

  async act(id: string, owner: string, action: LoginAction): Promise<void> {
    const runtime = this.runtime(id, owner);
    if (runtime.busy) throw new LoginError('BUSY', '上一步操作还没完成', 409);
    runtime.busy = true;
    try {
      const { page } = runtime;
      switch (action.type) {
        case 'click': {
          const x = Math.round(action.x);
          const y = Math.round(action.y);
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1400 || y > 1000) {
            throw new LoginError('INVALID_ACTION', '点击位置超出页面范围');
          }
          await page.mouse.click(x, y);
          break;
        }
        case 'type': {
          const text = String(action.text ?? '');
          if (!text || text.length > 200) throw new LoginError('INVALID_ACTION', '输入内容长度不合法');
          await page.keyboard.type(text, { delay: 12 });
          break;
        }
        case 'press': {
          if (!ALLOWED_KEYS.has(action.key)) throw new LoginError('INVALID_ACTION', '不支持的按键');
          await page.keyboard.press(action.key);
          break;
        }
        case 'scroll': {
          const dy = Math.round(Number(action.dy) || 0);
          await page.mouse.wheel(0, Math.max(-1200, Math.min(1200, dy)));
          break;
        }
        case 'goto': {
          assertSafeLoginUrl(action.url, this.options.allowPrivate);
          await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          break;
        }
        case 'reload':
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
          break;
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
          break;
        default:
          throw new LoginError('INVALID_ACTION', '不支持的操作');
      }
      await this.sync(id);
    } catch (error) {
      if (error instanceof LoginError) throw error;
      const message = redactText(error instanceof Error ? error.message : String(error), 160);
      updateLoginSession(id, { lastError: `操作失败：${message}` });
      throw new LoginError('ACTION_FAILED', `操作失败：${message}`, 502);
    } finally {
      runtime.busy = false;
    }
  }

  /**
   * 提取当前浏览器里属于该平台的 Cookie。
   * 不关闭窗口；调用方校验通过后再 close('captured')，失败时用户可以继续登录。
   */
  async capture(id: string, owner: string): Promise<{
    header: string;
    names: string[];
    expiresAt: string | null;
    domains: string[];
  }> {
    const runtime = this.runtime(id, owner);
    await this.sync(id);
    const raw = (await runtime.context.cookies()) as BrowserCookie[];
    const scoped = pickCookies(raw, runtime.allowedDomains);
    const header = buildCookieHeader(scoped);
    if (!header || scoped.length === 0) {
      throw new LoginError('COOKIE_EMPTY', '还没有捕捉到登录 Cookie，请先在窗口里完成登录', 409);
    }
    const provider = getProvider(runtime.providerId);
    if (provider?.primaryCookie && !scoped.some((cookie) => cookie.name === provider.primaryCookie)) {
      throw new LoginError('COOKIE_INCOMPLETE', `没有找到 ${provider.primaryCookie}，登录可能还没完成`, 409);
    }
    return {
      header,
      names: cookieNamesOf(scoped),
      expiresAt: earliestExpiry(scoped),
      domains: [...new Set(scoped.map((cookie) => cookie.domain?.replace(/^\./, '') ?? '').filter(Boolean))],
    };
  }

  async close(id: string, owner: string, reason: LoginSessionStatus = 'closed'): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime) {
      if (runtime.session.owner_session !== owner) throw new LoginError('FORBIDDEN', '这个登录窗口不属于当前会话', 403);
      runtime.closed = true;
      clearInterval(runtime.pollTimer);
      clearTimeout(runtime.expiryTimer);
      this.runtimes.delete(id);
      await runtime.context.close().catch(() => undefined);
    }
    const row = getLoginSession(id);
    if (!row) return;
    if (row.owner_session !== owner) throw new LoginError('FORBIDDEN', '这个登录窗口不属于当前会话', 403);
    if (row.status !== 'captured') {
      updateLoginSession(id, { status: reason, closedAt: nowIso() });
    }
  }

  async markCaptured(id: string, owner: string, accountId: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime && runtime.session.owner_session !== owner) {
      throw new LoginError('FORBIDDEN', '这个登录窗口不属于当前会话', 403);
    }
    updateLoginSession(id, { status: 'captured', accountId, closedAt: nowIso() });
    await this.close(id, owner, 'closed');
  }

  private async expire(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    updateLoginSession(id, { status: 'expired', lastError: '登录超时，请重新发起', closedAt: nowIso() });
    runtime.closed = true;
    clearInterval(runtime.pollTimer);
    this.runtimes.delete(id);
    await runtime.context.close().catch(() => undefined);
    logger.info({ sessionId: id }, 'login session expired');
  }

  private async sync(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed) return;
    try {
      const raw = (await runtime.context.cookies()) as BrowserCookie[];
      const scoped = pickCookies(raw, runtime.allowedDomains);
      const names = cookieNamesOf(scoped);
      const provider = getProvider(runtime.providerId);
      let ready = false;
      if (provider?.primaryCookie) {
        ready = names.includes(provider.primaryCookie);
      } else if (names.length > 0) {
        ready = !(await hasPasswordField(runtime.page));
      }
      const title = await runtime.page.title().catch(() => '');
      updateLoginSession(id, {
        currentUrl: safeDisplayUrl(runtime.page.url()),
        pageTitle: title.slice(0, 120) || null,
        detectedCookies: names.join(',') || null,
        status: ready ? 'ready' : 'waiting',
        lastError: null,
      });
    } catch (error) {
      logger.warn({ sessionId: id, error: redactText(String(error), 120) }, 'failed to sync login session');
    }
  }

  private async poll(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.closed || runtime.busy) return;
    await this.sync(id);
  }

  async shutdown(): Promise<void> {
    for (const [id, runtime] of this.runtimes) {
      runtime.closed = true;
      clearInterval(runtime.pollTimer);
      clearTimeout(runtime.expiryTimer);
      await runtime.context.close().catch(() => undefined);
      updateLoginSession(id, { status: 'closed', closedAt: nowIso() });
    }
    this.runtimes.clear();
  }
}

export function createLoginManager(): LoginSessionManager {
  return new LoginSessionManager({
    allowPrivate: config.loginAllowPrivate,
    ttlMs: config.loginSessionMinutes * 60_000,
    profileRoot: config.profileDir,
    chromiumPath: config.chromiumPath,
  });
}

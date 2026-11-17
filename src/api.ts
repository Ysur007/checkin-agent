import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { logger } from './logger.js';
import { db } from './db/index.js';
import {
  audit,
  backupDatabase,
  claimDaysSince,
  countClaimDays,
  countRunsForAccount,
  createAccount,
  dailyStatsSince,
  deleteAccount,
  getAccount,
  getAuthSetting,
  getClaimDay,
  getLoginSession,
  getPluginRow,
  getRun,
  getRunEvents,
  getSchedule,
  listAccounts,
  listAudit,
  listClaimDaysSince,
  listPluginRows,
  listRuns,
  isAutomationPaused,
  recordRiskEvent,
  setAutomationPaused,
  latestRunForAccount,
  runForDate,
  setAccountConfig,
  setPluginEnabled,
  setSchedule,
  statsSince,
  updateAccountCookie,
  updateAccountSummary,
  updateLoginSession,
  updateSessionCsrf,
  upsertPlugin,
  type ScheduleSettings,
} from './db/repo.js';
import {
  endSession,
  ensureEnvPassword,
  requireAuth,
  requireCsrf,
  readSession,
  savePassword,
  setupRequired,
  startSession,
  verifyPassword,
} from './auth.js';
import { getLoadedPlugin, listLoadedPlugins, loadBuiltinPlugins } from './plugins/loader.js';
import { extractFields } from './plugins/jsonpath.js';
import { requestWithRetry } from './runner/http.js';
import { friendlyMessage, type ErrorCode } from './runner/errors.js';
import type { AccountRow, PluginRecord, RunRow } from './types.js';
import { cookieFields, fingerprintCookie, sha256, errorMessage } from './crypto/redact.js';
import { seal, open } from './crypto/seal.js';
import { localDate, nextRunLabel } from './lib/time.js';
import type { ClaimRunner } from './runner/claimRunner.js';
import { CUSTOM_PROVIDER_ID, PROVIDERS, getProvider, isKnownProvider } from './providers/catalog.js';
import { getAutomationPolicy } from './providers/policy.js';
import { checkPlatform, getRiskOverview, recentRiskEvents, resetAllBreakers, resetBreaker } from './risk/breaker.js';
import { isCookieExpired, verifyAccount } from './accounts/health.js';
import type { LoginSessionManager } from './login/manager.js';
import { safeDisplayUrl } from './login/url.js';

interface AppDeps {
  runner: ClaimRunner;
  login: LoginSessionManager;
  appKey: Buffer;
  keyFingerprint: string;
}

function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function providerMeta(pluginId: string) {
  const def = getProvider(pluginId);
  const plugin = getLoadedPlugin(pluginId);
  if (def) {
    return {
      id: def.id,
      name: def.name,
      short: def.short,
      tint: def.tint,
      description: def.description,
      primaryCookie: def.primaryCookie,
      checkIn: Boolean(plugin?.adapter),
      policy: getAutomationPolicy(def.id),
    };
  }
  if (plugin) {
    return {
      id: plugin.id,
      name: plugin.name,
      short: plugin.name.slice(0, 1).toUpperCase(),
      tint: '#52525b',
      description: plugin.manifest.description,
      primaryCookie: plugin.manifest.auth.primaryCookie,
      checkIn: true,
      policy: getAutomationPolicy(plugin.id),
    };
  }
  return {
    id: pluginId,
    name: pluginId === CUSTOM_PROVIDER_ID ? '自定义平台' : pluginId,
    short: '自',
    tint: '#52525b',
    description: '用户自定义登录平台',
    primaryCookie: null,
    checkIn: false,
    policy: getAutomationPolicy(pluginId),
  };
}

function sanitizeAccount(account: AccountRow, today?: string) {
  const fields = (() => {
    try {
      return JSON.parse(account.cookie_keys ?? '[]') as string[];
    } catch {
      return [];
    }
  })();
  const claim = today ? getClaimDay(account.id, today) : undefined;
  const provider = providerMeta(account.plugin_id);
  const hasCookie = Boolean(account.cookie_sealed);
  const expired = isCookieExpired(account);

  return {
    id: account.id,
    label: account.label,
    pluginId: account.plugin_id,
    provider,
    enabled: Boolean(account.enabled),
    status: expired ? 'needs_reauth' : account.status,
    authSource: account.auth_source,
    loginUrl: safeDisplayUrl(account.login_url),
    cookie: {
      configured: hasCookie,
      fingerprint: account.cookie_fp,
      length: account.cookie_len,
      fields,
      updatedAt: account.cookie_updated_at,
      expiresAt: account.cookie_expires_at,
      expiresHint: account.expires_hint,
      checkedAt: account.cookie_checked_at,
      verified: Boolean(account.cookie_verified),
      expired,
    },
    scheduleTime: account.schedule_time,
    lastOkAt: account.last_ok_at,
    lastRunAt: account.last_run_at,
    lastErrorCode: account.last_error_code,
    failStreak: account.fail_streak,
    balance: account.last_balance,
    claimedToday: account.last_claimed_today === null ? null : account.last_claimed_today === 1,
    available: account.last_available === null ? null : account.last_available === 1,
    amount: account.last_amount,
    resetAt: account.last_reset_at,
    summaryAt: account.last_summary_at,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
    canCheckIn:
      provider.checkIn && hasCookie && Boolean(account.enabled) && !claim && !expired && account.status !== 'needs_reauth',
    today: claim
      ? {
          status: claim.status,
          credits: claim.credits,
          verified: Boolean(claim.verified),
          runId: claim.run_id,
          at: claim.created_at,
          httpStatus: claim.http_status,
        }
      : null,
  };
}

function sanitizeRun(run: RunRow | undefined) {
  if (!run) return null;
  const evidence = parseJson(run.evidence);
  return {
    id: run.id,
    trigger: run.trigger,
    localDate: run.local_date,
    status: run.status,
    attempt: run.attempt,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    httpStatus: run.http_status,
    preBalance: run.pre_balance,
    postBalance: run.post_balance,
    creditsIssued: run.credits_issued,
    claimed: run.claimed_flag === null ? null : run.claimed_flag === 1,
    latencyMs: run.latency_ms,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    verified: Boolean(evidence.verified),
    evidence,
  };
}

function loginSessionDto(sessionId: string, status?: string) {
  const row = getLoginSession(sessionId);
  if (!row) return null;
  return {
    id: row.id,
    providerId: row.provider_id,
    provider: providerMeta(row.provider_id),
    accountId: row.account_id,
    label: row.label,
    status: status ?? row.status,
    loginUrl: safeDisplayUrl(row.login_url),
    currentUrl: row.current_url,
    pageTitle: row.page_title,
    cookieNames: row.detected_cookies ? row.detected_cookies.split(',').filter(Boolean) : [],
    error: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function pluginDto(plugin: PluginRecord) {
  const row = getPluginRow(plugin.id);
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.manifest.description,
    homepage: plugin.manifest.homepage,
    source: plugin.source,
    enabled: row ? Boolean(row.enabled) : true,
    checksum: plugin.checksum.slice(0, 8),
    auth: plugin.manifest.auth,
    permissions: plugin.manifest.permissions,
    schedule: plugin.manifest.schedule,
    baseUrl: plugin.adapter.baseUrl,
    requests: {
      summary: { method: plugin.adapter.requests.summary.method, path: plugin.adapter.requests.summary.path },
      claim: { method: plugin.adapter.requests.claim.method, path: plugin.adapter.requests.claim.path },
    },
  };
}

function readCatalog(): Array<Record<string, unknown>> {
  try {
    const raw = fs.readFileSync(path.join(config.pluginDir, 'catalog.json'), 'utf8');
    const parsed = JSON.parse(raw) as { items?: Array<Record<string, unknown>> };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function normalizeCookie(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (/^cookie\s*:/i.test(value)) value = value.replace(/^cookie\s*:/i, '').trim();
  if (!value || value.length < 10 || value.length > 8000) return null;
  if (/[\r\n]/.test(value)) return null;
  if (!value.includes('=')) return null;
  return value;
}

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function addDaysToKey(days: number): string {
  return localDate(getSchedule().timezone, new Date(Date.now() - days * 86_400_000));
}

export async function createApp(deps: AppDeps) {
  ensureEnvPassword();

  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });

  app.addHook('preHandler', async (request, reply) => {
    const pathname = (request.raw.url ?? '').split('?')[0];
    if (!pathname.startsWith('/api')) return;
    if (pathname.startsWith('/api/health') || pathname.startsWith('/api/auth')) return;
    await requireAuth(request, reply);
    if (reply.sent) return;
    await requireCsrf(request, reply);
  });

  /* ---------- health ---------- */

  app.get('/api/health', async () => ({
    ok: true,
    version: config.version,
    uptime: Math.round(process.uptime()),
  }));

  app.get('/api/health/ready', async () => {
    db.prepare('SELECT 1 AS ok').get();
    return { ok: true, db: true, version: config.version };
  });

  /* ---------- auth ---------- */

  app.get('/api/auth/status', async (request, reply) => {
    const session = readSession(request);
    if (session) {
      if (!request.cookies.ca_csrf) {
        const csrf = crypto.randomBytes(32).toString('base64url');
        updateSessionCsrf(session.id, sha256(csrf));
        reply.setCookie('ca_csrf', csrf, {
          path: '/',
          httpOnly: false,
          sameSite: 'lax',
          secure: config.cookieSecure,
          expires: new Date(session.expires_at),
        });
      }
      return { setupRequired: false, authed: true, version: config.version };
    }
    return { setupRequired: setupRequired(), authed: false, version: config.version };
  });

  app.post(
    '/api/auth/setup',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      if (!setupRequired()) {
        return reply.code(409).send({ error: { code: 'ALREADY_SETUP', message: '控制台已经初始化' } });
      }
      const body = request.body as { password?: string };
      const password = typeof body?.password === 'string' ? body.password : '';
      if (password.length < 8) {
        return reply.code(400).send({ error: { code: 'WEAK_PASSWORD', message: '密码至少 8 位' } });
      }
      savePassword(password);
      startSession(request, reply);
      audit('admin', 'auth.setup', null);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const body = request.body as { password?: string };
      const password = typeof body?.password === 'string' ? body.password : '';
      const stored = setupRequired() ? null : getAuthSetting();
      if (!stored) {
        return reply.code(409).send({ error: { code: 'SETUP_REQUIRED', message: '请先初始化控制台' } });
      }
      if (!verifyPassword(password, stored)) {
        audit('admin', 'auth.login.failed', request.ip ?? null);
        return reply.code(401).send({ error: { code: 'INVALID_PASSWORD', message: '密码不正确' } });
      }
      startSession(request, reply);
      audit('admin', 'auth.login', request.ip ?? null);
      return reply.code(204).send();
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    endSession(request, reply);
    return reply.code(204).send();
  });

  app.post('/api/auth/password', { preHandler: [requireAuth, requireCsrf] }, async (request, reply) => {
    const body = request.body as { current?: string; next?: string };
    const stored = getAuthSetting();
    if (!stored || !verifyPassword(String(body?.current ?? ''), stored)) {
      return reply.code(401).send({ error: { code: 'INVALID_PASSWORD', message: '当前密码不正确' } });
    }
    if (String(body?.next ?? '').length < 8) {
      return reply.code(400).send({ error: { code: 'WEAK_PASSWORD', message: '新密码至少 8 位' } });
    }
    savePassword(String(body.next));
    audit('admin', 'auth.password', null);
    return reply.code(204).send();
  });

  /* ---------- providers ---------- */

  app.get('/api/providers', async () => {
    const accounts = listAccounts();
    const counts = new Map<string, number>();
    for (const account of accounts) counts.set(account.plugin_id, (counts.get(account.plugin_id) ?? 0) + 1);

    return {
      items: PROVIDERS.map((provider) => {
        const plugin = provider.adapterId ? getLoadedPlugin(provider.adapterId) : undefined;
        return {
          ...provider,
          adapterReady: Boolean(plugin),
          policy: getAutomationPolicy(provider.id),
          accountCount: counts.get(provider.id) ?? 0,
          accounts: accounts
            .filter((account) => account.plugin_id === provider.id)
            .map((account) => ({ id: account.id, label: account.label, status: account.status })),
        };
      }),
      custom: {
        id: CUSTOM_PROVIDER_ID,
        name: '自定义平台',
        description: '填写登录页地址，捕获任意平台的 Cookie',
        accountCount: counts.get(CUSTOM_PROVIDER_ID) ?? 0,
      },
    };
  });

  /* ---------- accounts ---------- */

  app.get('/api/accounts', async () => {
    const today = localDate(getSchedule().timezone);
    return { items: listAccounts().map((account) => sanitizeAccount(account, today)), today };
  });

  app.patch('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = getAccount(id);
    if (!account) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '账号不存在' } });
    const body = request.body as { label?: string; enabled?: boolean; scheduleTime?: string | null };

    if (body.scheduleTime !== undefined && body.scheduleTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.scheduleTime)) {
      return reply.code(400).send({ error: { code: 'INVALID_TIME', message: '时间格式应为 HH:MM' } });
    }

    setAccountConfig(id, {
      label: typeof body.label === 'string' ? body.label.trim().slice(0, 40) : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      scheduleTime: body.scheduleTime === null ? null : body.scheduleTime,
    });
    audit('admin', 'account.update', id);
    return sanitizeAccount(getAccount(id)!, localDate(getSchedule().timezone));
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = getAccount(id);
    if (!account) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '账号不存在' } });
    deleteAccount(id);
    audit('admin', 'account.delete', id, { pluginId: account.plugin_id, label: account.label });
    return reply.code(204).send();
  });

  app.post('/api/accounts/:id/verify', async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = getAccount(id);
    if (!account) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '账号不存在' } });
    const result = await verifyAccount(id, deps.appKey);
    audit('admin', 'account.verify', id, { ok: result.ok, code: result.code ?? null });
    return reply.send({ ...result, checkedAt: new Date().toISOString() });
  });

  app.post('/api/accounts/:id/cookie', async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = getAccount(id);
    if (!account) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '账号不存在' } });
    const plugin = getLoadedPlugin(account.plugin_id);
    const provider = getProvider(account.plugin_id);
    const primary = plugin?.manifest.auth.primaryCookie ?? provider?.primaryCookie ?? null;

    const cookieValue = normalizeCookie((request.body as { cookie?: string })?.cookie);
    if (!cookieValue) {
      return reply.code(400).send({
        error: { code: 'INVALID_COOKIE', message: '请粘贴完整的 Cookie 请求头（包含 name=value，不要换行）' },
      });
    }
    if (primary && !cookieFields(cookieValue).includes(primary)) {
      return reply.code(400).send({
        error: { code: 'COOKIE_MISSING_FIELD', message: `Cookie 里没有 ${primary}，请确认登录完成后再复制` },
      });
    }

    let verified = false;
    let warning: string | null = null;
    const fields = cookieFields(cookieValue);
    const sealed = seal(cookieValue, `account:${id}:v1`, deps.appKey);

    if (plugin) {
      const test = await requestWithRetry(plugin, 'summary', cookieValue, plugin.manifest.limits.timeoutMs);
      if (test.error) {
        const code = test.error.code as ErrorCode;
        if (code === 'AUTH_REQUIRED' || code === 'CHALLENGE_DETECTED') {
          return reply.code(400).send({
            error: { code: test.error.code, message: friendlyMessage(code, test.error.message) },
          });
        }
        warning = `已加密保存，但校验请求失败：${friendlyMessage(code, test.error.message)}`;
      } else if (test.result) {
        const extracted = extractFields(test.result.json, plugin.adapter.extract.summary);
        if (typeof extracted.claimedToday === 'boolean') {
          updateAccountSummary(id, {
            balance: typeof extracted.balance === 'number' ? extracted.balance : null,
            claimedToday: extracted.claimedToday,
            available: typeof extracted.available === 'boolean' ? extracted.available : null,
            amount: typeof extracted.amount === 'number' ? extracted.amount : null,
            resetAt: typeof extracted.resetAt === 'string' ? extracted.resetAt : null,
          });
          verified = true;
        } else {
          warning = '已保存，但 summary 缺少预期字段，未能完成校验';
        }
      }
    }

    updateAccountCookie(id, sealed, fingerprintCookie(cookieValue), cookieValue.length, fields, null, {
      expiresAt: null,
      verified,
      checkedAt: verified ? new Date().toISOString() : null,
      authSource: 'manual',
    });
    audit('admin', 'cookie.update', id, { fingerprint: fingerprintCookie(cookieValue), fields: fields.length });
    return reply.send({ account: sanitizeAccount(getAccount(id)!, localDate(getSchedule().timezone)), warning });
  });

  /* ---------- login sessions ---------- */

  app.post(
    '/api/login-sessions',
    { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const body = request.body as {
        providerId?: string;
        loginUrl?: string;
        label?: string;
        accountId?: string;
      };
      const providerId = String(body?.providerId ?? '');
      const def = getProvider(providerId);
      if (!isKnownProvider(providerId)) {
        return reply.code(404).send({ error: { code: 'PROVIDER_NOT_FOUND', message: '未知的平台' } });
      }

      let account: AccountRow | undefined;
      if (body?.accountId) {
        account = getAccount(String(body.accountId));
        if (!account) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '账号不存在' } });
        if (account.plugin_id !== providerId) {
          return reply.code(400).send({ error: { code: 'PROVIDER_MISMATCH', message: '账号与平台不匹配' } });
        }
      }

      const rawUrl = String(body?.loginUrl ?? '').trim() || def?.loginUrl || account?.login_url || '';
      if (!rawUrl) {
        return reply.code(400).send({ error: { code: 'LOGIN_URL_REQUIRED', message: '请填写这个平台的登录页地址' } });
      }
      const loginUrl = normalizeUrl(rawUrl);
      const label = (String(body?.label ?? '').trim() || account?.label || def?.name || '新账号').slice(0, 40);
      const created = account ? null : createAccount({ pluginId: providerId, label, loginUrl, authSource: 'browser' });
      const target = account ?? created!;

      try {
        const session = await deps.login.start({
          providerId,
          loginUrl,
          label,
          ownerSession: request.session!.id,
          accountId: target.id,
        });
        if (account) setAccountConfig(account.id, { label });
        audit('admin', 'login.start', session.id, { providerId, accountId: target.id });
        return reply.code(201).send({ session: loginSessionDto(session.id), accountId: target.id });
      } catch (error) {
        if (created && !created.cookie_sealed && countRunsForAccount(created.id) === 0) deleteAccount(created.id);
        const code = (error as { code?: string }).code ?? 'LOGIN_START_FAILED';
        const message = error instanceof Error ? error.message : '无法打开登录窗口';
        logger.warn({ providerId, code, message }, 'login session failed to start');
        return reply.code((error as { httpStatus?: number }).httpStatus ?? 500).send({ error: { code, message } });
      }
    },
  );

  app.get('/api/login-sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      deps.login.get(id, request.session!.id);
      return { session: loginSessionDto(id) };
    } catch (error) {
      return reply.code((error as { httpStatus?: number }).httpStatus ?? 404).send({
        error: { code: (error as { code?: string }).code ?? 'NOT_FOUND', message: (error as Error).message },
      });
    }
  });

  app.get('/api/login-sessions/:id/frame', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const frame = await deps.login.frame(id, request.session!.id);
      reply.header('cache-control', 'no-store, max-age=0').type('image/jpeg').send(frame);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'FRAME_FAILED';
      return reply.code((error as { httpStatus?: number }).httpStatus ?? 502).send({
        error: { code, message: error instanceof Error ? error.message : '无法获取画面' },
      });
    }
  });

  app.post('/api/login-sessions/:id/actions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const action = request.body as { type?: string } & Record<string, unknown>;
    try {
      await deps.login.act(id, request.session!.id, action as never);
      return { ok: true };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'ACTION_FAILED';
      return reply.code((error as { httpStatus?: number }).httpStatus ?? 502).send({
        error: { code, message: error instanceof Error ? error.message : '操作失败' },
      });
    }
  });

  app.post('/api/login-sessions/:id/capture', async (request, reply) => {
    const { id } = request.params as { id: string };
    const owner = request.session!.id;
    let session;
    try {
      session = deps.login.get(id, owner);
    } catch (error) {
      return reply.code((error as { httpStatus?: number }).httpStatus ?? 404).send({
        error: { code: (error as { code?: string }).code ?? 'NOT_FOUND', message: (error as Error).message },
      });
    }
    if (!session.account_id) {
      return reply.code(409).send({ error: { code: 'NO_ACCOUNT', message: '登录窗口还没有绑定账号' } });
    }
    const account = getAccount(session.account_id);
    if (!account) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '账号不存在' } });

    let captured: Awaited<ReturnType<LoginSessionManager['capture']>>;
    try {
      captured = await deps.login.capture(id, owner);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'COOKIE_EMPTY';
      updateLoginSession(id, { lastError: error instanceof Error ? error.message : '捕捉 Cookie 失败' });
      return reply.code((error as { httpStatus?: number }).httpStatus ?? 409).send({
        error: { code, message: error instanceof Error ? error.message : '还没有捕捉到 Cookie' },
      });
    }

    const plugin = getLoadedPlugin(account.plugin_id);
    let verified = false;
    let warning: string | null = null;

    if (plugin) {
      const test = await requestWithRetry(plugin, 'summary', captured.header, plugin.manifest.limits.timeoutMs);
      const code = test.error?.code as ErrorCode | undefined;
      if (test.error && (code === 'AUTH_REQUIRED' || code === 'CHALLENGE_DETECTED')) {
        updateLoginSession(id, { lastError: '登录态还不可用，请继续完成验证' });
        return reply.code(422).send({
          error: {
            code: test.error.code,
            message: `登录还没有完成或登录态不可用：${friendlyMessage(code, test.error.message)}`,
          },
        });
      }
      if (test.error) {
        warning = `Cookie 已保存，但校验请求失败：${friendlyMessage(code ?? 'INTERNAL', test.error.message)}`;
      } else if (test.result) {
        const extracted = extractFields(test.result.json, plugin.adapter.extract.summary);
        if (typeof extracted.claimedToday === 'boolean') {
          updateAccountSummary(account.id, {
            balance: typeof extracted.balance === 'number' ? extracted.balance : null,
            claimedToday: extracted.claimedToday,
            available: typeof extracted.available === 'boolean' ? extracted.available : null,
            amount: typeof extracted.amount === 'number' ? extracted.amount : null,
            resetAt: typeof extracted.resetAt === 'string' ? extracted.resetAt : null,
          });
          verified = true;
        } else {
          warning = 'Cookie 已保存，但 summary 缺少预期字段';
        }
      }
    }

    const sealed = seal(captured.header, `account:${account.id}:v1`, deps.appKey);
    updateAccountCookie(
      account.id,
      sealed,
      fingerprintCookie(captured.header),
      captured.header.length,
      captured.names,
      captured.expiresAt,
      {
        expiresAt: captured.expiresAt,
        verified,
        checkedAt: verified ? new Date().toISOString() : null,
        authSource: 'browser',
      },
    );
    await deps.login.markCaptured(id, owner, account.id);
    audit('admin', 'cookie.capture', account.id, { fingerprint: fingerprintCookie(captured.header), domains: captured.domains });
    logger.info({ accountId: account.id, providerId: account.plugin_id, fields: captured.names.length }, 'cookie captured');

    return reply.send({
      account: sanitizeAccount(getAccount(account.id)!, localDate(getSchedule().timezone)),
      warning,
      verified,
      expiresAt: captured.expiresAt,
    });
  });

  app.delete('/api/login-sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const owner = request.session!.id;
    const session = getLoginSession(id);
    if (!session) return reply.code(204).send();
    try {
      await deps.login.close(id, owner, 'closed');
    } catch (error) {
      return reply.code((error as { httpStatus?: number }).httpStatus ?? 400).send({
        error: { code: (error as { code?: string }).code ?? 'CLOSE_FAILED', message: (error as Error).message },
      });
    }
    if (session.account_id) {
      const account = getAccount(session.account_id);
      if (account && !account.cookie_sealed && countRunsForAccount(account.id) === 0) {
        deleteAccount(account.id);
      }
    }
    return reply.code(204).send();
  });

  app.post('/api/accounts/:id/relogin', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = getAccount(id);
    if (!account) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '账号不存在' } });
    const provider = getProvider(account.plugin_id);
    const loginUrl = account.login_url || provider?.loginUrl || '';
    if (!loginUrl) {
      return reply.code(400).send({ error: { code: 'LOGIN_URL_REQUIRED', message: '这个账号没有保存登录页地址' } });
    }
    try {
      const session = await deps.login.start({
        providerId: account.plugin_id,
        loginUrl,
        label: account.label,
        ownerSession: request.session!.id,
        accountId: account.id,
      });
      audit('admin', 'login.relogin', account.id, { sessionId: session.id });
      return reply.code(201).send({ session: loginSessionDto(session.id), accountId: account.id });
    } catch (error) {
      return reply.code((error as { httpStatus?: number }).httpStatus ?? 500).send({
        error: {
          code: (error as { code?: string }).code ?? 'LOGIN_START_FAILED',
          message: error instanceof Error ? error.message : '无法打开登录窗口',
        },
      });
    }
  });

  /* ---------- check-in center ---------- */

  app.get('/api/checkins/today', async () => {
    const schedule = getSchedule();
    const today = localDate(schedule.timezone);
    const accounts = listAccounts().map((account) => sanitizeAccount(account, today));
    const eligible = accounts.filter((account) => account.provider.checkIn && account.cookie.configured && account.enabled);
    const checked = eligible.filter((account) => account.today);
    const loggedIn = accounts.filter((account) => account.cookie.configured);
    const credits30 = claimDaysSince(addDaysToKey(29)).reduce((sum, row) => sum + row.credits, 0);

    return {
      today,
      timezone: schedule.timezone,
      accounts,
      stats: {
        progressDone: checked.length,
        progressTotal: eligible.length,
        scheduledEnabled: loggedIn.filter((account) => account.enabled).length,
        scheduledTotal: loggedIn.length,
        attention: accounts.filter(
          (account) => account.cookie.configured && (account.status === 'needs_reauth' || account.status === 'error'),
        ).length,
        records: countClaimDays(),
        credits30,
        accounts: accounts.length,
      },
      nextRun: nextRunLabel(schedule.timezone, schedule.time, schedule.jitterSeconds, 'global'),
    };
  });

  app.get('/api/checkins/records', async (request) => {
    const query = request.query as { days?: string };
    const days = Math.min(Math.max(Number(query.days ?? 30) || 30, 1), 90);
    const from = addDaysToKey(days - 1);
    const rows = listClaimDaysSince(from);

    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = grouped.get(row.local_date) ?? [];
      list.push(row);
      grouped.set(row.local_date, list);
    }

    return {
      days,
      summary: {
        records: rows.length,
        credits: rows.reduce((sum, row) => sum + (row.credits ?? 0), 0),
        verified: rows.filter((row) => row.verified).length,
      },
      groups: [...grouped.entries()].map(([date, items]) => ({
        date,
        credits: items.reduce((sum, item) => sum + (item.credits ?? 0), 0),
        items: items.map((item) => ({
          accountId: item.account_id,
          label: item.label ?? '已删除账号',
          provider: providerMeta(item.plugin_id ?? ''),
          status: item.status,
          credits: item.credits,
          verified: Boolean(item.verified),
          httpStatus: item.http_status,
          runId: item.run_id,
          at: item.created_at,
        })),
      })),
    };
  });

  app.post(
    '/api/checkins/:accountId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { accountId } = request.params as { accountId: string };
      const account = getAccount(accountId);
      if (!account) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '账号不存在' } });
      if (!account.cookie_sealed) {
        return reply.code(409).send({ error: { code: 'COOKIE_MISSING', message: '这个账号还没有登录，先添加账号' } });
      }
      if (!getLoadedPlugin(account.plugin_id)) {
        return reply.code(409).send({
          error: { code: 'CHECKIN_UNSUPPORTED', message: '这个平台只接入了登录，签到接口还没有适配' },
        });
      }
      const today = localDate(getSchedule().timezone);
      if (getClaimDay(account.id, today)) {
        return reply.code(409).send({ error: { code: 'ALREADY_CHECKED_IN', message: '今天已经签到过了，已阻止重复签到' } });
      }

      const result = await deps.runner.start({ accountId: account.id, trigger: 'manual' });
      if (result.error) {
        const conflict = [
          'ALREADY_CLAIMED',
          'LOCK_HELD',
          'CIRCUIT_OPEN',
          'CIRCUIT_BUSY',
          'AUTOMATION_PAUSED',
          'POLICY_BLOCKED',
        ].includes(result.error);
        return reply
          .code(conflict ? 409 : 500)
          .send({ error: { code: result.error, message: result.message ?? result.error }, runId: result.runId });
      }
      audit('admin', 'checkin.manual', account.id, { runId: result.runId });
      return reply.code(202).send({ runId: result.runId, accountId: account.id });
    },
  );

  app.post(
    '/api/checkins/bulk',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (isAutomationPaused()) {
        return reply.code(409).send({ error: { code: 'AUTOMATION_PAUSED', message: '自动化已暂停，请先在风险面板恢复' } });
      }
      const body = request.body as { accountIds?: string[] } | undefined;
      const requested = Array.isArray(body?.accountIds) ? new Set(body!.accountIds!.map(String)) : null;
      const today = localDate(getSchedule().timezone);
      const gates = new Map<string, ReturnType<typeof checkPlatform>>();
      const started: Array<{ accountId: string; runId?: string }> = [];
      const skipped: Array<{ accountId: string; label: string; reason: string }> = [];

      for (const account of listAccounts()) {
        if (requested && !requested.has(account.id)) continue;
        if (!account.enabled) {
          skipped.push({ accountId: account.id, label: account.label, reason: '账号已停用' });
          continue;
        }
        if (!account.cookie_sealed) {
          skipped.push({ accountId: account.id, label: account.label, reason: '未登录' });
          continue;
        }
        if (!getLoadedPlugin(account.plugin_id)) {
          skipped.push({ accountId: account.id, label: account.label, reason: '签到待适配' });
          continue;
        }
        if (getAutomationPolicy(account.plugin_id).automation === 'prohibited') {
          skipped.push({ accountId: account.id, label: account.label, reason: '平台策略禁止自动化' });
          continue;
        }
        if (!gates.has(account.plugin_id)) gates.set(account.plugin_id, checkPlatform(account.plugin_id));
        const gate = gates.get(account.plugin_id)!;
        if (gate.blocked) {
          skipped.push({ accountId: account.id, label: account.label, reason: '平台熔断中' });
          continue;
        }
        if (getClaimDay(account.id, today)) {
          skipped.push({ accountId: account.id, label: account.label, reason: '今天已签到' });
          continue;
        }
        if (account.status === 'needs_reauth' || isCookieExpired(account)) {
          skipped.push({ accountId: account.id, label: account.label, reason: '登录已失效' });
          continue;
        }

        const result = await deps.runner.start({ accountId: account.id, trigger: 'manual' });
        if (result.error) {
          skipped.push({ accountId: account.id, label: account.label, reason: result.message ?? result.error });
        } else {
          started.push({ accountId: account.id, runId: result.runId });
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      audit('admin', 'checkin.bulk', null, { started: started.length, skipped: skipped.length });
      return reply.code(started.length > 0 ? 202 : 200).send({ started, skipped });
    },
  );

  /* ---------- runs ---------- */

  app.get('/api/runs', async (request) => {
    const query = request.query as { limit?: string; status?: string };
    return { items: listRuns(Number(query.limit ?? 50), query.status).map(sanitizeRun) };
  });

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '运行记录不存在' } });
    return {
      run: sanitizeRun(run),
      events: getRunEvents(id).map((event) => ({
        seq: event.seq,
        at: event.at,
        type: event.type,
        detail: parseJson(event.detail),
      })),
    };
  });

  app.get('/api/stats', async (request) => {
    const query = request.query as { days?: string };
    const days = Math.min(Math.max(Number(query.days ?? 30) || 30, 1), 90);
    const from = addDaysToKey(days - 1);
    const rows = statsSince(from);
    const daily = dailyStatsSince(from);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const success = rows
      .filter((row) => row.status === 'succeeded' || row.status === 'already_claimed')
      .reduce((sum, row) => sum + row.count, 0);
    return {
      days,
      total,
      success,
      credits: rows.reduce((sum, row) => sum + row.credits, 0),
      successRate: total > 0 ? Math.round((success / total) * 100) : 0,
      byStatus: rows,
      daily,
    };
  });

  /* ---------- plugins ---------- */

  app.get('/api/plugins', async () => {
    const loaded = listLoadedPlugins();
    const rows = listPluginRows();
    const installed = loaded.map(pluginDto);
    const installedIds = new Set(rows.map((row) => row.id));
    const discover = readCatalog().filter((item) => !installedIds.has(String(item.id)));
    return { builtin: installed, installed, discover };
  });

  app.post('/api/plugins/:id/enable', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: boolean };
    if (!getPluginRow(id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '插件不存在' } });
    setPluginEnabled(id, Boolean(body.enabled));
    audit('admin', 'plugin.enable', id, { enabled: Boolean(body.enabled) });
    return { ok: true };
  });

  app.post('/api/plugins/rescan', async () => {
    const plugins = loadBuiltinPlugins();
    for (const plugin of plugins) upsertPlugin(plugin);
    return { ok: true, count: plugins.length };
  });

  /* ---------- settings ---------- */

  app.get('/api/settings', async () => ({
    version: config.version,
    schedule: getSchedule(),
    keyFingerprint: deps.keyFingerprint,
    cookieSecure: config.cookieSecure,
    envPassword: Boolean(config.adminPassword),
    risk: {
      paused: isAutomationPaused(),
      strikeLimit: 3,
      challengeRate: 0.2,
      minSamples: 5,
      openHours: 6,
    },
    browser: {
      enabled: config.browserLogin,
      available: await deps.login.available(),
      allowPrivate: config.loginAllowPrivate,
      sessionMinutes: config.loginSessionMinutes,
      executable: config.chromiumPath || 'system chromium',
    },
  }));

  app.patch('/api/settings', async (request, reply) => {
    const body = request.body as { schedule?: Partial<ScheduleSettings> };
    const current = getSchedule();
    const next: ScheduleSettings = { ...current, ...(body.schedule ?? {}) };

    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.time) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.windowStart) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.windowEnd)
    ) {
      return reply.code(400).send({ error: { code: 'INVALID_TIME', message: '时间格式应为 HH:MM' } });
    }
    if (!Number.isInteger(next.jitterSeconds) || next.jitterSeconds < 0 || next.jitterSeconds > 3600) {
      return reply.code(400).send({ error: { code: 'INVALID_JITTER', message: '抖动需为 0–3600 秒' } });
    }
    if (!Number.isInteger(next.spreadSeconds) || next.spreadSeconds < 0 || next.spreadSeconds > 14_400) {
      return reply.code(400).send({ error: { code: 'INVALID_SPREAD', message: '随机窗口需为 0–14400 秒' } });
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: next.timezone }).format(new Date());
    } catch {
      return reply.code(400).send({ error: { code: 'INVALID_TIMEZONE', message: '时区无效' } });
    }

    setSchedule(next);
    audit('admin', 'settings.schedule', null, next);
    return next;
  });

  app.post('/api/admin/backup', async () => {
    const file = backupDatabase();
    audit('admin', 'db.backup', path.basename(file));
    return { ok: true, file: path.basename(file) };
  });

  app.get('/api/audit', async (request) => {
    const query = request.query as { limit?: string };
    return {
      items: listAudit(Number(query.limit ?? 30)).map((row) => ({
        id: row.id,
        at: row.at,
        action: row.action,
        target: row.target,
        meta: parseJson(row.meta),
      })),
    };
  });

  /* ---------- risk ---------- */

  app.get('/api/risk', async () => getRiskOverview());

  app.get('/api/risk/events', async (request) => {
    const query = request.query as { limit?: string };
    return {
      items: recentRiskEvents(Number(query.limit ?? 40)).map((event) => ({
        id: event.id,
        at: event.at,
        platformId: event.platform_id,
        platform: providerMeta(event.platform_id).name,
        accountId: event.account_id,
        kind: event.kind,
        detail: parseJson(event.detail),
      })),
    };
  });

  app.post('/api/risk/pause', async (request, reply) => {
    const body = request.body as { paused?: boolean };
    if (typeof body?.paused !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: '缺少 paused' } });
    }
    setAutomationPaused(body.paused);
    recordRiskEvent({
      platformId: 'system',
      kind: body.paused ? 'pause' : 'resume',
      detail: { at: new Date().toISOString() },
    });
    audit('admin', body.paused ? 'risk.pause' : 'risk.resume', null);
    return { paused: body.paused };
  });

  app.post('/api/risk/reset', async (request) => {
    const body = request.body as { platformId?: string } | undefined;
    if (body?.platformId) {
      resetBreaker(String(body.platformId), '控制台手动恢复');
      audit('admin', 'risk.reset', String(body.platformId));
    } else {
      resetAllBreakers();
      audit('admin', 'risk.reset', null);
    }
    return getRiskOverview();
  });

  /* ---------- static web ---------- */

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if ((request.raw.url ?? '').startsWith('/api')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      }
      return (reply as FastifyReply & { sendFile: (file: string) => unknown }).sendFile('index.html');
    });
  } else {
    app.get('/', async (_request, reply) => {
      reply.type('text/html; charset=utf-8').send(
        '<h1>checkin-agent</h1><p>Web 控制台尚未构建。运行 <code>npm run build:web</code> 后重启。</p>',
      );
    });
  }

  app.setErrorHandler((error, request, reply) => {
    logger.error({ error: errorMessage(error), url: request.url }, 'request failed');
    if (reply.sent) return;
    reply.code(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  return app;
}

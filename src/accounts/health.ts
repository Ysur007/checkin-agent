import {
  countAccountRiskEventsSince,
  getAccount,
  listAccounts,
  setAccountStatus,
  updateAccountSummary,
} from '../db/repo.js';
import { getLoadedPlugin } from '../plugins/loader.js';
import { requestWithRetry } from '../runner/http.js';
import { extractFields } from '../plugins/jsonpath.js';
import { open } from '../crypto/seal.js';
import { friendlyMessage, type ErrorCode } from '../runner/errors.js';
import { errorMessage } from '../crypto/redact.js';
import { logger } from '../logger.js';
import type { AccountRow } from '../types.js';
import { markCookieChecked } from '../db/repo.js';
import { scoreAccountHealth, type HealthScore } from './healthScore.js';

export interface HealthResult {
  ok: boolean;
  code?: string;
  message?: string;
  httpStatus?: number;
  latencyMs?: number;
  unverified?: boolean;
  balance?: number | null;
  claimedToday?: boolean | null;
  available?: boolean | null;
  amount?: number | null;
  resetAt?: string | null;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** 账号健康分：本地状态 + 近 24 小时挑战次数，用于调度降速与界面展示。 */
export function accountHealth(account: AccountRow, now = Date.now()): HealthScore {
  const challenges = countAccountRiskEventsSince(account.id, new Date(now - DAY).toISOString(), [
    'challenge',
    'rate_limited',
  ]);
  return scoreAccountHealth({
    hasCookie: Boolean(account.cookie_sealed),
    expired: isCookieExpired(account, now),
    status: account.status,
    verifiable: Boolean(getLoadedPlugin(account.plugin_id)),
    verified: account.cookie_verified === 1,
    checkedAt: account.cookie_checked_at,
    failStreak: account.fail_streak,
    lastOkAt: account.last_ok_at,
    challenges24h: challenges,
    now,
  });
}

/** 本地就能判断的过期检查（不消耗平台请求）。 */
export function isCookieExpired(account: AccountRow, now = Date.now()): boolean {
  if (!account.cookie_expires_at) return false;
  const at = Date.parse(account.cookie_expires_at);
  return Number.isFinite(at) && at <= now;
}

/**
 * 校验账号的登录态：
 * 1. 有明确过期时间且已过期 → 直接 needs_reauth；
 * 2. 有适配器 → 调用 summary 预检，401/403/挑战 → needs_reauth；
 * 3. 只有登录、没有适配器 → 只做本地过期检查，返回 unverified。
 */
export async function verifyAccount(
  accountId: string,
  key: Buffer,
  options: { probe?: boolean } = {},
): Promise<HealthResult> {
  const account = getAccount(accountId);
  if (!account) return { ok: false, code: 'ACCOUNT_NOT_FOUND', message: '账号不存在' };
  if (!account.cookie_sealed) return { ok: false, code: 'COOKIE_MISSING', message: '还没有保存 Cookie' };

  if (isCookieExpired(account)) {
    setAccountStatus(account.id, 'needs_reauth', 'COOKIE_EXPIRED');
    return { ok: false, code: 'COOKIE_EXPIRED', message: '登录态已过期，请重新登录' };
  }

  const plugin = getLoadedPlugin(account.plugin_id);
  if (!plugin) {
    markCookieChecked(account.id, false);
    return { ok: true, unverified: true, message: '已保存登录态；该平台没有签到适配器，无法向平台校验' };
  }

  let cookie: string;
  try {
    cookie = open(account.cookie_sealed, `account:${account.id}:v1`, key);
  } catch {
    setAccountStatus(account.id, 'error', 'DECRYPT_FAILED');
    return { ok: false, code: 'DECRYPT_FAILED', message: 'Cookie 解密失败，请重新登录' };
  }

  if (options.probe === false) {
    return { ok: true, unverified: true, message: '只做了本地检查' };
  }

  const test = await requestWithRetry(plugin, 'summary', cookie, plugin.manifest.limits.timeoutMs);
  const code = test.error?.code as ErrorCode | undefined;

  if (test.error) {
    if (code === 'AUTH_REQUIRED' || code === 'CHALLENGE_DETECTED') {
      setAccountStatus(account.id, 'needs_reauth', test.error.code);
      markCookieChecked(account.id, false);
    }
    return {
      ok: false,
      code: test.error.code,
      message: friendlyMessage(code ?? 'INTERNAL', test.error.message),
      httpStatus: test.error.httpStatus,
    };
  }
  if (!test.result) {
    return { ok: false, code: 'EMPTY_RESPONSE', message: '平台没有返回内容' };
  }

  const extracted = extractFields(test.result.json, plugin.adapter.extract.summary);
  updateAccountSummary(account.id, {
    balance: typeof extracted.balance === 'number' ? extracted.balance : null,
    claimedToday: typeof extracted.claimedToday === 'boolean' ? extracted.claimedToday : null,
    available: typeof extracted.available === 'boolean' ? extracted.available : null,
    amount: typeof extracted.amount === 'number' ? extracted.amount : null,
    resetAt: typeof extracted.resetAt === 'string' ? extracted.resetAt : null,
  });
  setAccountStatus(account.id, 'ok', null);
  markCookieChecked(account.id, true);

  return {
    ok: true,
    balance: typeof extracted.balance === 'number' ? extracted.balance : null,
    claimedToday: typeof extracted.claimedToday === 'boolean' ? extracted.claimedToday : null,
    available: typeof extracted.available === 'boolean' ? extracted.available : null,
    amount: typeof extracted.amount === 'number' ? extracted.amount : null,
    resetAt: typeof extracted.resetAt === 'string' ? extracted.resetAt : null,
    latencyMs: test.result.latencyMs,
  };
}

/**
 * 后台巡检：过期立即标记；有适配器的账号每 6 小时做一次真实 summary 预检。
 * 串行 + 间隔，避免对平台造成并发压力。
 */
export async function sweepAccountHealth(key: Buffer, now = Date.now()): Promise<{
  checked: number;
  expired: number;
  needsReauth: number;
}> {
  let checked = 0;
  let expired = 0;
  let needsReauth = 0;

  for (const account of listAccounts()) {
    if (!account.enabled || !account.cookie_sealed) continue;

    if (isCookieExpired(account, now)) {
      if (account.status !== 'needs_reauth') setAccountStatus(account.id, 'needs_reauth', 'COOKIE_EXPIRED');
      expired += 1;
      continue;
    }

    const lastChecked = account.cookie_checked_at ? Date.parse(account.cookie_checked_at) : 0;
    if (Number.isFinite(lastChecked) && lastChecked && now - lastChecked < SIX_HOURS) continue;
    if (!getLoadedPlugin(account.plugin_id)) continue;

    checked += 1;
    try {
      const result = await verifyAccount(account.id, key);
      if (!result.ok && (result.code === 'AUTH_REQUIRED' || result.code === 'CHALLENGE_DETECTED')) needsReauth += 1;
    } catch (error) {
      logger.warn({ accountId: account.id, error: errorMessage(error) }, 'cookie health check failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return { checked, expired, needsReauth };
}

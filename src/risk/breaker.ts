import {
  countAllRiskEventsSince,
  countPlatformRunsSince,
  countRiskEventsSince,
  getBreaker,
  getPolicyAck,
  isAutomationPaused,
  listAccounts,
  listBreakers,
  listRiskEvents,
  recordRiskEvent,
  saveBreaker,
} from '../db/repo.js';
import { getLoadedPlugin, listLoadedPlugins } from '../plugins/loader.js';
import { getProvider } from '../providers/catalog.js';
import { getAutomationPolicy } from '../providers/policy.js';
import { nowIso } from '../db/repo.js';
import type { CircuitBreakerRow, CircuitState, RunStatus } from '../types.js';

export const RISK_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BREAKER_OPEN_MS = 6 * 60 * 60 * 1000;
export const BREAKER_REOPEN_MS = 12 * 60 * 60 * 1000;
export const STRIKE_LIMIT = 3;
export const CHALLENGE_RATE = 0.2;
export const MIN_SAMPLES = 5;

const STRIKE_KINDS = ['challenge', 'rate_limited'];

export interface GateResult {
  blocked: boolean;
  state: CircuitState;
  reason?: string;
  openUntil?: string | null;
  halfOpen: boolean;
}

function defaultRow(platformId: string, now: number): CircuitBreakerRow {
  return {
    platform_id: platformId,
    state: 'closed',
    reason: null,
    opened_at: null,
    open_until: null,
    strikes: 0,
    window_start: new Date(now - RISK_WINDOW_MS).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
}

function openBreaker(platformId: string, row: CircuitBreakerRow, strikes: number, reason: string, now: number, ms: number): void {
  const until = new Date(now + ms).toISOString();
  saveBreaker({
    platformId,
    state: 'open',
    reason,
    openedAt: new Date(now).toISOString(),
    openUntil: until,
    strikes,
    windowStart: row.window_start,
  });
  recordRiskEvent({
    platformId,
    kind: 'circuit_open',
    detail: { reason, strikes, openUntil: until },
  });
}

/**
 * 调度与手动执行前统一调用。
 * open 且未到期 → 阻断；到期后自动进入 half_open，只允许一次真实执行。
 */
export function checkPlatform(platformId: string, now = Date.now()): GateResult {
  const row = getBreaker(platformId);
  if (!row || row.state === 'closed') return { blocked: false, state: 'closed', halfOpen: false };

  if (row.state === 'open') {
    const until = row.open_until ? Date.parse(row.open_until) : 0;
    if (Number.isFinite(until) && until > now) {
      return {
        blocked: true,
        state: 'open',
        reason: row.reason ?? '平台连续出现验证挑战，已暂停',
        openUntil: row.open_until,
        halfOpen: false,
      };
    }
    saveBreaker({
      platformId,
      state: 'half_open',
      reason: row.reason,
      openedAt: row.opened_at,
      openUntil: null,
      strikes: row.strikes,
      windowStart: row.window_start,
    });
    return { blocked: false, state: 'half_open', halfOpen: true, reason: row.reason ?? undefined };
  }

  return { blocked: false, state: 'half_open', halfOpen: true, reason: row.reason ?? undefined };
}

/**
 * 运行结束后回写风险事件。只有挑战/限流计入 strike；
 * 成功会关闭半开熔断，避免一次正常执行后仍被永久冻结。
 */
export function recordOutcome(input: {
  platformId: string;
  accountId: string;
  status: RunStatus;
  errorCode?: string | null;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const success = input.status === 'succeeded' || input.status === 'already_claimed';

  let kind: string | null = null;
  if (input.status === 'needs_reauth') {
    kind = input.errorCode === 'CHALLENGE_DETECTED' ? 'challenge' : 'auth_required';
  } else if (input.status === 'rate_limited') {
    kind = 'rate_limited';
  } else if (input.status === 'unverified') {
    kind = 'unverified';
  }

  if (kind) {
    recordRiskEvent({
      platformId: input.platformId,
      accountId: input.accountId,
      kind,
      detail: { status: input.status, errorCode: input.errorCode ?? null },
    });
  }

  const existing = getBreaker(input.platformId) ?? defaultRow(input.platformId, now);

  if (existing.state === 'open') return;

  if (existing.state === 'half_open') {
    if (success) {
      saveBreaker({
        platformId: input.platformId,
        state: 'closed',
        reason: null,
        openedAt: null,
        openUntil: null,
        strikes: 0,
        windowStart: nowIso(),
      });
      recordRiskEvent({ platformId: input.platformId, accountId: input.accountId, kind: 'circuit_close', detail: { reason: '半开验证成功' } });
      return;
    }
    if (kind === 'challenge' || kind === 'rate_limited') {
      openBreaker(
        input.platformId,
        existing,
        existing.strikes + 1,
        '半开验证仍然遇到验证挑战，重新熔断',
        now,
        BREAKER_REOPEN_MS,
      );
    }
    return;
  }

  if (kind !== 'challenge' && kind !== 'rate_limited') return;

  const strikes = countRiskEventsSince(input.platformId, existing.window_start, STRIKE_KINDS);
  const runs = countPlatformRunsSince(input.platformId, existing.window_start);
  const rate = runs > 0 ? strikes / runs : 0;

  if (strikes >= STRIKE_LIMIT || (runs >= MIN_SAMPLES && rate >= CHALLENGE_RATE)) {
    openBreaker(
      input.platformId,
      existing,
      strikes,
      `近 24 小时 ${strikes} 次挑战 / ${runs} 次运行（${Math.round(rate * 100)}%），暂停该平台`,
      now,
      BREAKER_OPEN_MS,
    );
  } else {
    saveBreaker({
      platformId: input.platformId,
      state: 'closed',
      reason: existing.reason,
      openedAt: existing.opened_at,
      openUntil: null,
      strikes,
      windowStart: existing.window_start,
    });
  }
}

export function resetBreaker(platformId: string, note = '手动恢复'): void {
  saveBreaker({
    platformId,
    state: 'closed',
    reason: null,
    openedAt: null,
    openUntil: null,
    strikes: 0,
    windowStart: nowIso(),
  });
  recordRiskEvent({ platformId, kind: 'circuit_close', detail: { note } });
}

export function resetAllBreakers(): void {
  for (const row of listBreakers()) {
    if (row.state !== 'closed') resetBreaker(row.platform_id, '手动全部恢复');
  }
}

function platformName(platformId: string): string {
  return getProvider(platformId)?.name ?? getLoadedPlugin(platformId)?.name ?? platformId;
}

export interface RiskPlatformView {
  platformId: string;
  name: string;
  state: CircuitState;
  blocked: boolean;
  reason: string | null;
  openUntil: string | null;
  strikes: number;
  runs24h: number;
  challenges24h: number;
  challengeRate: number;
  accountCount: number;
  policy: ReturnType<typeof getAutomationPolicy>;
  policyAcknowledged: boolean;
}

export function getRiskOverview(now = Date.now()) {
  const since = new Date(now - RISK_WINDOW_MS).toISOString();
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const plugin of listLoadedPlugins()) ids.add(plugin.id);
  for (const account of listAccounts()) {
    ids.add(account.plugin_id);
    counts.set(account.plugin_id, (counts.get(account.plugin_id) ?? 0) + 1);
  }

  const platforms: RiskPlatformView[] = [];
  let totalRuns = 0;
  let totalChallenges = 0;

  for (const platformId of ids) {
    const row = getBreaker(platformId);
    const gate = checkPlatform(platformId, now);
    const runs = countPlatformRunsSince(platformId, since);
    const challenges = countRiskEventsSince(platformId, since, STRIKE_KINDS);

    totalRuns += runs;
    totalChallenges += challenges;
    platforms.push({
      platformId,
      name: platformName(platformId),
      state: gate.state,
      blocked: gate.blocked,
      reason: gate.reason ?? null,
      openUntil: gate.openUntil ?? null,
      strikes: row?.strikes ?? 0,
      runs24h: runs,
      challenges24h: challenges,
      challengeRate: runs > 0 ? Math.min(100, Math.round((challenges / runs) * 100)) : 0,
      accountCount: counts.get(platformId) ?? 0,
      policy: getAutomationPolicy(platformId),
      policyAcknowledged: Boolean(getPolicyAck(platformId)),
    });
  }

  platforms.sort((a, b) => Number(b.blocked) - Number(a.blocked) || b.challenges24h - a.challenges24h);

  return {
    paused: isAutomationPaused(),
    totals: {
      runs24h: totalRuns,
      challenges24h: totalChallenges,
      rate: totalRuns > 0 ? Math.min(100, Math.round((totalChallenges / totalRuns) * 100)) : 0,
      events24h: countAllRiskEventsSince(since),
    },
    platforms,
    generatedAt: new Date(now).toISOString(),
  };
}

export function recentRiskEvents(limit = 50) {
  return listRiskEvents(limit);
}

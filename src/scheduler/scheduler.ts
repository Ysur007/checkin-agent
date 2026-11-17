import {
  countActiveLocks,
  countRunsStartedSince,
  getClaimDay,
  getSchedule,
  hasScheduledRunOn,
  hasSuccessOn,
  isAutomationPaused,
  listAccounts,
  platformHasActiveLock,
} from '../db/repo.js';
import { isCookieExpired } from '../accounts/health.js';
import { getAutomationPolicy } from '../providers/policy.js';
import { checkPlatform } from '../risk/breaker.js';
import { hashJitter, localParts, minutesOfDay } from '../lib/time.js';
import { logger } from '../logger.js';
import type { ClaimRunner } from '../runner/claimRunner.js';

export async function tick(runner: ClaimRunner, now = new Date()): Promise<void> {
  if (isAutomationPaused()) return;

  // 全局串行：任一账号正在运行，就不启动下一个；手动任务也计入。
  if (countActiveLocks(now.getTime()) > 0) return;

  // 自动启动上限：即使账号很多，每小时最多 6 次，避免形成请求簇。
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (countRunsStartedSince(hourAgo) >= 6) return;

  const schedule = getSchedule();
  const parts = localParts(schedule.timezone, now);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const windowEnd = minutesOfDay(schedule.windowEnd);
  const spread = Math.max(schedule.spreadSeconds, 0);

  const candidates = listAccounts()
    .filter((account) => {
      if (!account.enabled || account.status === 'needs_reauth' || account.status === 'disabled') return false;
      if (!account.cookie_sealed) return false;
      if (hasSuccessOn(account.id, parts.date)) return false;
      if (getClaimDay(account.id, parts.date)) return false;
      if (hasScheduledRunOn(account.id, parts.date)) return false;
      if (isCookieExpired(account)) return false;
      if (getAutomationPolicy(account.plugin_id).automation === 'prohibited') return false;
      return true;
    })
    .map((account) => {
      const base = minutesOfDay(account.schedule_time ?? schedule.time);
      const offset = spread > 0 ? hashJitter(`${account.id}:${parts.date}`, spread) : 0;
      return { account, target: Math.min(base + Math.floor(offset / 60), windowEnd) };
    })
    .sort((a, b) => a.target - b.target);

  for (const { account, target } of candidates) {
    if (nowMinutes < target || nowMinutes > windowEnd) continue;

    const gate = checkPlatform(account.plugin_id, now.getTime());
    if (gate.blocked) continue;
    if (platformHasActiveLock(account.plugin_id, now.getTime())) continue;

    const trigger = nowMinutes - target > 10 ? 'backfill' : 'schedule';
    const result = await runner.start({ accountId: account.id, trigger });
    if (result.error) {
      if (result.error !== 'LOCK_HELD') {
        logger.warn({ accountId: account.id, error: result.error, message: result.message }, 'scheduled run did not start');
      }
      continue;
    }
    // 一次 tick 只启动一个，后续账号等下一个 60 秒窗口。
    return;
  }
}

export function startScheduler(runner: ClaimRunner): () => void {
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    void tick(runner)
      .catch((error) => logger.error({ error: error instanceof Error ? error.message : String(error) }, 'scheduler tick failed'))
      .finally(() => {
        busy = false;
      });
  };

  const timer = setInterval(run, 60_000);
  timer.unref();
  const boot = setTimeout(run, 2_000);
  boot.unref();

  return () => {
    clearInterval(timer);
    clearTimeout(boot);
  };
}

import { listAccounts, getClaimDay, getSchedule, hasScheduledRunOn, hasSuccessOn } from '../db/repo.js';
import { isCookieExpired } from '../accounts/health.js';
import { hashJitter, localParts, minutesOfDay } from '../lib/time.js';
import { logger } from '../logger.js';
import type { ClaimRunner } from '../runner/claimRunner.js';

export async function tick(runner: ClaimRunner, now = new Date()): Promise<void> {
  const schedule = getSchedule();
  const parts = localParts(schedule.timezone, now);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const windowEnd = minutesOfDay(schedule.windowEnd);

  for (const account of listAccounts()) {
    if (!account.enabled || account.status === 'needs_reauth' || account.status === 'disabled') continue;
    if (!account.cookie_sealed) continue;
    if (hasSuccessOn(account.id, parts.date)) continue;
    if (getClaimDay(account.id, parts.date)) continue;
    if (hasScheduledRunOn(account.id, parts.date)) continue;
    if (isCookieExpired(account)) continue;

    const base = minutesOfDay(account.schedule_time ?? schedule.time);
    const jitter = hashJitter(account.id, schedule.jitterSeconds);
    const target = base + Math.floor(jitter / 60);

    if (nowMinutes < target || nowMinutes > windowEnd) continue;

    const trigger = nowMinutes - target > 10 ? 'backfill' : 'schedule';
    const result = await runner.start({ accountId: account.id, trigger });
    if (result.error && result.error !== 'LOCK_HELD') {
      logger.warn({ accountId: account.id, error: result.error, message: result.message }, 'scheduled run did not start');
    }
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

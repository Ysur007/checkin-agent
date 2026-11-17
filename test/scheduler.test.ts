import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaimRunner } from '../src/runner/claimRunner.js';

let repo: typeof import('../src/db/repo.js');
let scheduler: typeof import('../src/scheduler/scheduler.js');
let loader: typeof import('../src/plugins/loader.js');
let db: typeof import('../src/db/index.js').db;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'checkin-scheduler-'));
  process.env.DATA_DIR = dir;
  const database = await import('../src/db/index.js');
  db = database.db;
  repo = await import('../src/db/repo.js');
  loader = await import('../src/plugins/loader.js');
  loader.loadBuiltinPlugins();
  scheduler = await import('../src/scheduler/scheduler.js');
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

function localClock(now: Date): { time: string; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    time: `${get('hour')}:${get('minute')}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

describe('risk-aware scheduler', () => {
  it('starts at most one account per tick and respects locks, pause and hourly cap', async () => {
    const now = new Date();
    const clock = localClock(now);
    repo.setSchedule({
      time: clock.time,
      timezone: 'Asia/Shanghai',
      jitterSeconds: 0,
      spreadSeconds: 0,
      windowStart: '00:00',
      windowEnd: '23:59',
    });

    repo.setPolicyAck('breezeblue');
    const account = repo.createAccount({ pluginId: 'breezeblue', label: 'sched', authSource: 'manual' });
    repo.updateAccountCookie(account.id, 'v1.test', 'fp', 10, ['breeze_blue_session'], null, {
      verified: true,
      checkedAt: new Date().toISOString(),
    });

    const starts: string[] = [];
    const runner = {
      start: async (input: { accountId: string }) => {
        starts.push(input.accountId);
        return { runId: 'run-stub' };
      },
    } as unknown as ClaimRunner;

    await scheduler.tick(runner, now);
    expect(starts).toEqual([account.id]);

    repo.acquireLock(account.id, 'lock-1', now.getTime() + 60_000);
    starts.length = 0;
    await scheduler.tick(runner, now);
    expect(starts).toEqual([]);
    repo.releaseLock(account.id, 'lock-1');

    repo.setAutomationPaused(true);
    starts.length = 0;
    await scheduler.tick(runner, now);
    expect(starts).toEqual([]);
    repo.setAutomationPaused(false);

    for (let index = 0; index < 6; index += 1) {
      repo.insertRun({
        id: `cap-${index}`,
        accountId: `other-${index}`,
        pluginId: 'breezeblue',
        pluginVersion: '1',
        trigger: 'schedule',
        localDate: clock.date,
        idemKey: `cap-${index}`,
        status: 'queued',
        attempt: 1,
      });
    }

    starts.length = 0;
    await scheduler.tick(runner, now);
    expect(starts).toEqual([]);
  });
});

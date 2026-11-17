import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let repo: typeof import('../src/db/repo.js');
let health: typeof import('../src/accounts/health.js');
let db: typeof import('../src/db/index.js').db;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'checkin-ledger-'));
  process.env.DATA_DIR = dir;
  const database = await import('../src/db/index.js');
  db = database.db;
  repo = await import('../src/db/repo.js');
  health = await import('../src/accounts/health.js');
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('claim ledger', () => {
  it('keeps exactly one row per account and day', () => {
    const account = repo.createAccount({ pluginId: 'breezeblue', label: '主账号', authSource: 'browser' });
    repo.recordClaimDay({
      accountId: account.id,
      date: '2026-11-17',
      runId: 'run-1',
      status: 'succeeded',
      credits: 400,
      httpStatus: 200,
      verified: true,
    });

    expect(repo.getClaimDay(account.id, '2026-11-17')?.credits).toBe(400);
    expect(repo.countClaimDays()).toBe(1);

    // 同一天再次写入会被主键吞掉，积分与 run 不会被覆盖。
    repo.recordClaimDay({
      accountId: account.id,
      date: '2026-11-17',
      runId: 'run-2',
      status: 'already_claimed',
      credits: 0,
      httpStatus: 200,
      verified: true,
    });

    const row = repo.getClaimDay(account.id, '2026-11-17');
    expect(row?.run_id).toBe('run-1');
    expect(row?.credits).toBe(400);
    expect(repo.countClaimDays()).toBe(1);
  });

  it('allows the next day and keeps an audit trail', () => {
    const account = repo.listAccounts()[0];
    repo.recordClaimDay({
      accountId: account.id,
      date: '2026-11-18',
      runId: 'run-3',
      status: 'succeeded',
      credits: 400,
      httpStatus: 200,
      verified: true,
    });
    expect(repo.countClaimDays()).toBe(2);
    expect(repo.claimDaysSince('2026-11-18')).toEqual([{ local_date: '2026-11-18', count: 1, credits: 400 }]);
  });

  it('deletes the ledger together with the account', () => {
    const account = repo.listAccounts()[0];
    repo.deleteAccount(account.id);
    expect(repo.getClaimDay(account.id, '2026-11-17')).toBeUndefined();
    expect(repo.countClaimDays()).toBe(0);
  });
});


describe('cookie expiry', () => {
  it('treats a past expiry as expired and a future one as usable', () => {
    const base = { cookie_expires_at: '2026-11-16T00:00:00.000Z' } as never;
    expect(health.isCookieExpired(base, Date.parse('2026-11-17T00:00:00.000Z'))).toBe(true);
    expect(health.isCookieExpired(base, Date.parse('2026-11-15T00:00:00.000Z'))).toBe(false);
    expect(health.isCookieExpired({ cookie_expires_at: null } as never)).toBe(false);
  });
});

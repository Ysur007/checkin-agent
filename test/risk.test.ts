import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let repo: typeof import('../src/db/repo.js');
let risk: typeof import('../src/risk/breaker.js');
let policy: typeof import('../src/providers/policy.js');
let db: typeof import('../src/db/index.js').db;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'checkin-risk-'));
  process.env.DATA_DIR = dir;
  const database = await import('../src/db/index.js');
  db = database.db;
  repo = await import('../src/db/repo.js');
  risk = await import('../src/risk/breaker.js');
  policy = await import('../src/providers/policy.js');
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('provider automation policy', () => {
  it('marks demo as allowed and unknown platforms as unknown', () => {
    expect(policy.getAutomationPolicy('demo').automation).toBe('allowed');
    expect(policy.getAutomationPolicy('breezeblue').automation).toBe('unknown');
    expect(policy.getAutomationPolicy('not-in-catalog').automation).toBe('unknown');
  });
});

describe('platform circuit breaker', () => {
  it('opens after three challenge outcomes and blocks execution', () => {
    for (let index = 0; index < 3; index += 1) {
      risk.recordOutcome({
        platformId: 'demo',
        accountId: 'acc-1',
        status: 'needs_reauth',
        errorCode: 'CHALLENGE_DETECTED',
      });
    }

    const gate = risk.checkPlatform('demo');
    expect(gate.blocked).toBe(true);
    expect(gate.state).toBe('open');
    expect(repo.getBreaker('demo')?.state).toBe('open');
    expect(repo.countRiskEventsSince('demo', new Date(Date.now() - 60_000).toISOString(), ['challenge'])).toBe(3);
  });

  it('closes after a manual reset', () => {
    risk.resetBreaker('demo', 'test reset');
    expect(risk.checkPlatform('demo').blocked).toBe(false);
    expect(repo.getBreaker('demo')?.state).toBe('closed');
  });

  it('moves an expired breaker to half-open and closes on success', () => {
    repo.saveBreaker({
      platformId: 'half',
      state: 'open',
      reason: 'test',
      openedAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
      openUntil: new Date(Date.now() - 1000).toISOString(),
      strikes: 3,
      windowStart: new Date(Date.now() - 24 * 3600_000).toISOString(),
    });

    const gate = risk.checkPlatform('half');
    expect(gate.blocked).toBe(false);
    expect(gate.halfOpen).toBe(true);
    expect(gate.state).toBe('half_open');

    risk.recordOutcome({ platformId: 'half', accountId: 'acc-2', status: 'succeeded' });
    expect(repo.getBreaker('half')?.state).toBe('closed');
  });

  it('does not count an ordinary 401 as a platform challenge', () => {
    risk.recordOutcome({ platformId: 'plain', accountId: 'acc-3', status: 'needs_reauth', errorCode: 'AUTH_REQUIRED' });
    risk.recordOutcome({ platformId: 'plain', accountId: 'acc-3', status: 'needs_reauth', errorCode: 'AUTH_REQUIRED' });
    risk.recordOutcome({ platformId: 'plain', accountId: 'acc-3', status: 'needs_reauth', errorCode: 'AUTH_REQUIRED' });
    expect(risk.checkPlatform('plain').blocked).toBe(false);
    expect(repo.getBreaker('plain')?.state ?? 'closed').toBe('closed');
  });

  it('respects the global pause switch', () => {
    repo.setAutomationPaused(true);
    expect(repo.isAutomationPaused()).toBe(true);
    repo.setAutomationPaused(false);
    expect(repo.isAutomationPaused()).toBe(false);
  });

  it('stores a one-time policy acknowledgement per platform', () => {
    expect(repo.getPolicyAck('breezeblue')).toBeNull();
    repo.setPolicyAck('breezeblue', 'test');
    expect(repo.getPolicyAck('breezeblue')).not.toBeNull();
  });
});

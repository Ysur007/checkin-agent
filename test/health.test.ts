import { describe, expect, it } from 'vitest';
import { scoreAccountHealth } from '../src/accounts/healthScore.js';

const base = {
  hasCookie: true,
  expired: false,
  status: 'ok',
  verifiable: true,
  verified: true,
  checkedAt: new Date().toISOString(),
  failStreak: 0,
  lastOkAt: new Date().toISOString(),
  challenges24h: 0,
  now: Date.now(),
};

describe('account health score', () => {
  it('is zero without a cookie or with an expired cookie', () => {
    expect(scoreAccountHealth({ ...base, hasCookie: false }).score).toBe(0);
    expect(scoreAccountHealth({ ...base, expired: true }).score).toBe(0);
    expect(scoreAccountHealth({ ...base, expired: true }).reasons[0]).toContain('过期');
  });

  it('is 100 for a recently verified, successful account', () => {
    const health = scoreAccountHealth(base);
    expect(health.score).toBe(100);
    expect(health.level).toBe('healthy');
  });

  it('drops for unverified cookies, stale checks and failures', () => {
    const health = scoreAccountHealth({
      ...base,
      verified: false,
      checkedAt: null,
      lastOkAt: null,
      failStreak: 2,
    });
    expect(health.score).toBe(40);
    expect(health.level).toBe('at_risk');
    expect(health.reasons.join('；')).toContain('连续 2 次失败');
  });

  it('penalises repeated challenges and reauth state', () => {
    const challenged = scoreAccountHealth({ ...base, challenges24h: 2 });
    expect(challenged.score).toBe(80);
    expect(challenged.reasons.join('；')).toContain('2 次挑战');

    const reauth = scoreAccountHealth({ ...base, status: 'needs_reauth' });
    expect(reauth.score).toBe(20);
    expect(reauth.level).toBe('invalid');
  });

  it('does not penalise login-only platforms for missing verification', () => {
    const health = scoreAccountHealth({ ...base, verifiable: false, verified: false, checkedAt: null, lastOkAt: null });
    expect(health.score).toBe(100);
    expect(health.label).toBe('正常');
  });
});

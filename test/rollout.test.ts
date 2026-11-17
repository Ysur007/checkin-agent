import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-rollout-'));
process.env.DATA_DIR = tmp;
process.env.TZ = 'Asia/Shanghai';
process.env.EGRESS_PROBE = '0';

let repo: typeof import('../src/db/repo.js');
let loader: typeof import('../src/plugins/loader.js');
let rollout: typeof import('../src/risk/rollout.js');
let environment: typeof import('../src/risk/environment.js');

function addAccount(label: string, pluginId = 'breezeblue') {
  const account = repo.createAccount({ pluginId, label, authSource: 'manual' });
  repo.updateAccountCookie(account.id, 'v1.sealed', `fp-${label}`, 32, ['breeze_blue_session'], null, {
    verified: true,
    checkedAt: new Date().toISOString(),
  });
  return account;
}

beforeAll(async () => {
  loader = await import('../src/plugins/loader.js');
  loader.loadBuiltinPlugins();
  repo = await import('../src/db/repo.js');
  rollout = await import('../src/risk/rollout.js');
  environment = await import('../src/risk/environment.js');
});

afterAll(() => {
  // Windows 上 SQLite 仍持有句柄，清理失败不影响测试结论。
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('canary rollout', () => {
  it('holds non-canary accounts and only releases after the required days', () => {
    repo.setPolicyAck('breezeblue');
    const first = addAccount('主账号');
    const second = addAccount('备用账号');

    const started = rollout.startCanary('breezeblue', 'test');
    expect(started?.stage).toBe('canary');
    expect(started?.requiredDays).toBe(rollout.CANARY_REQUIRED_DAYS);

    // 无论金丝雀选到哪个账号，另一个都应被拦下。
    const canaryId = started!.canaryAccountId!;
    const other = canaryId === first.id ? second : first;
    expect(rollout.canaryHold('breezeblue', canaryId, 'canary')).toBeNull();
    expect(rollout.canaryHold('breezeblue', other.id, other.label)).toContain('灰度观察');

    rollout.noteCanarySuccess('breezeblue', canaryId, '2026-11-17');
    expect(rollout.getRolloutView('breezeblue').stage).toBe('canary');
    expect(rollout.getRolloutView('breezeblue').successDays).toBe(1);

    // 同一天重复成功不重复计数
    rollout.noteCanarySuccess('breezeblue', canaryId, '2026-11-17');
    expect(rollout.getRolloutView('breezeblue').successDays).toBe(1);

    rollout.noteCanarySuccess('breezeblue', canaryId, '2026-11-18');
    const promoted = rollout.getRolloutView('breezeblue');
    expect(promoted.stage).toBe('open');
    expect(rollout.canaryHold('breezeblue', other.id, other.label)).toBeNull();
  });

  it('rotates the canary to another account after a failure', () => {
    repo.setPolicyAck('breezeblue');
    const started = rollout.startCanary('breezeblue', 'rotate test');
    const canaryId = started!.canaryAccountId!;
    rollout.noteCanarySuccess('breezeblue', canaryId, '2026-11-19');
    expect(rollout.getRolloutView('breezeblue').successDays).toBe(1);

    rollout.noteCanaryFailure('breezeblue', canaryId, 'CHALLENGE_DETECTED');
    const rotated = rollout.getRolloutView('breezeblue');
    expect(rotated.stage).toBe('canary');
    expect(rotated.successDays).toBe(0);
    expect(rotated.canaryAccountId).not.toBe(canaryId);
  });

  it('stops canary on demand', () => {
    rollout.stopCanary('breezeblue', 'manual');
    expect(rollout.getRolloutView('breezeblue').stage).toBe('open');
  });

  it('refuses to start without an eligible account', () => {
    expect(rollout.startCanary('does-not-exist')).toBeNull();
  });
});

describe('egress drift classification', () => {
  const base = {
    scope: 'global',
    ip: '203.0.113.10',
    country: 'CN',
    org: 'AS4134 Chinanet',
    checked_at: '2026-11-17T00:00:00.000Z',
    changed_at: null,
    drift: 'none' as const,
    drift_note: null,
    samples: 1,
  };

  it('treats the first observation as a baseline', () => {
    expect(environment.classifyDrift(undefined, { ip: '1.1.1.1', country: 'CN', org: null })).toBe('none');
  });

  it('ignores the same IP and same network', () => {
    expect(environment.classifyDrift(base, { ip: base.ip, country: 'CN', org: 'AS4134 Chinanet' })).toBe('none');
  });

  it('marks an IP change in the same network as minor', () => {
    expect(environment.classifyDrift(base, { ip: '203.0.113.99', country: 'CN', org: 'AS4134 Chinanet' })).toBe('minor');
  });

  it('marks country or operator changes as major', () => {
    expect(environment.classifyDrift(base, { ip: '198.51.100.7', country: 'US', org: 'AS4134 Chinanet' })).toBe('major');
    expect(environment.classifyDrift(base, { ip: '198.51.100.7', country: 'CN', org: 'AS4837 China Unicom' })).toBe('major');
  });

  it('skips probing when disabled', async () => {
    expect(await environment.probeEgress()).toBeNull();
    expect(environment.getEnvironmentView().blocked).toBe(false);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Adapter, Manifest, PluginRecord } from '../src/types';
import type { HttpOutcome, HttpResult, Operation } from '../src/runner/http';
import { checkInCore } from '../src/runner/core';
import { deriveLedger } from '../src/plugins/ledger';
import { localDate } from '../src/lib/time';

const root = process.cwd();
const today = localDate('Asia/Shanghai');

function plugin(): PluginRecord {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugins/modelscope/manifest.json'), 'utf8')) as Manifest;
  const adapter = JSON.parse(fs.readFileSync(path.join(root, 'plugins/modelscope/adapter.json'), 'utf8')) as Adapter;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    manifest,
    adapter,
    checksum: 'test',
    enabled: true,
    source: 'builtin',
  };
}

function result(json: unknown, status = 200): HttpResult {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    json,
    text: JSON.stringify(json),
    bytes: 0,
    latencyMs: 5,
    requestId: 'test-request',
    contentType: 'application/json',
  };
}

function caller(script: { summary?: HttpOutcome[]; claim?: HttpOutcome[]; verify?: HttpOutcome[] }) {
  const calls: Operation[] = [];
  const pending = {
    summary: [...(script.summary ?? [])],
    claim: [...(script.claim ?? [])],
    verify: [...(script.verify ?? [])],
  };
  const call = async (operation: Operation): Promise<HttpOutcome> => {
    calls.push(operation);
    const next = pending[operation].shift();
    if (!next) throw new Error(`no ${operation} response`);
    return next;
  };
  return { call, calls };
}

const noSleep = async () => undefined;

const ok = (json: unknown, status = 200): HttpOutcome => ({ result: result(json, status) });

const balance = (available: number): HttpOutcome =>
  ok({ success: true, data: { available_balance: available, total_balance: available, frozen_amount: 0 } });

const loginOk: HttpOutcome = ok({ Code: 200, Message: null, Success: true, Data: { NickName: 'tester' }, RequestId: 'r' });

const tx = (records: Array<Record<string, unknown>>): HttpOutcome => ok({ success: true, data: { records } });

const earn = (ruleKey: string, amount: number, day = today) => ({
  type: 'EARN',
  rule_key: ruleKey,
  total_amount: amount,
  gmt_created: `${day} 09:10:12`,
  title: ruleKey,
});

describe('modelscope ledger', () => {
  it('只统计当天、EARN、白名单规则键的记录', () => {
    const spec = plugin().adapter.ledger!;
    const derived = deriveLedger(
      spec,
      {
        data: {
          records: [
            earn('daily_active', 200),
            earn('aliyun_bindlogin', 50),
            earn('daily_active', 200, '2026-01-01'),
            { type: 'SPEND', rule_key: 'daily_active', total_amount: 999, gmt_created: `${today} 10:00:00` },
            { type: 'EARN', rule_key: 'invite', total_amount: 20, gmt_created: `${today} 10:00:00` },
          ],
        },
      },
      today,
    );
    expect(derived.claimedToday).toBe(true);
    expect(derived.credits).toBe(250);
    expect(derived.matched).toBe(2);
    expect(derived.scanned).toBe(5);
  });

  it('读不到 records 时抛错，而不是当成未领取', () => {
    const spec = plugin().adapter.ledger!;
    expect(() => deriveLedger(spec, { success: true, data: {} }, today)).toThrow(/records not found/);
  });

  it('兼容大写 Data 信封', () => {
    const spec = plugin().adapter.ledger!;
    const derived = deriveLedger(spec, { Success: true, Data: { records: [earn('daily_active', 200)] } }, today);
    expect(derived.credits).toBe(200);
  });
});

describe('modelscope check-in flow', () => {
  it('登录即到账：触发后按账单复核成功', async () => {
    const { call, calls } = caller({
      summary: [balance(1200)],
      claim: [loginOk],
      verify: [tx([]), tx([earn('daily_active', 200), earn('aliyun_bindlogin', 50)])],
    });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verified).toBe(true);
    expect(outcome.creditsIssued).toBe(250);
    expect(calls).toEqual(['summary', 'verify', 'claim', 'verify']);
  });

  it('今天已经到账时直接短路，不再触发登录接口', async () => {
    const { call, calls } = caller({
      summary: [balance(1500)],
      verify: [tx([earn('daily_active', 200)])],
    });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('already_claimed');
    expect(outcome.creditsIssued).toBe(200);
    expect(calls).toEqual(['summary', 'verify']);
  });

  it('账单延迟写入时会重读一次', async () => {
    const { call, calls } = caller({
      summary: [balance(1000)],
      claim: [loginOk],
      verify: [tx([]), tx([]), tx([earn('daily_active', 200)])],
    });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.creditsIssued).toBe(200);
    expect(calls.filter((item) => item === 'verify')).toHaveLength(3);
  });

  it('触发了但账单一直没有到账 → 未验证，不写成功', async () => {
    const { call } = caller({
      summary: [balance(1000)],
      claim: [loginOk],
      verify: [tx([]), tx([]), tx([])],
    });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('unverified');
    expect(outcome.verified).toBe(false);
  });

  it('摘要接口 401 → 登录失效', async () => {
    const { call } = caller({ summary: [{ error: { code: 'AUTH_REQUIRED', message: 'unauthorized', httpStatus: 401 } }] });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('needs_reauth');
    expect(outcome.verified).toBe(false);
  });

  it('账单接口挂了 → 无法确认，标记失败而不是假成功', async () => {
    const { call } = caller({ summary: [balance(1000)], verify: [ok({}, 500)] });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.verified).toBe(false);
    expect(['failed', 'unverified']).toContain(outcome.status);
  });
});

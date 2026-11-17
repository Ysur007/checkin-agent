import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Adapter, Manifest, PluginRecord } from '../src/types';
import type { HttpOutcome, Operation } from '../src/runner/http';
import type { HttpResult } from '../src/runner/http';
import { checkInCore } from '../src/runner/core';

const root = process.cwd();

function plugin(): PluginRecord {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugins/breezeblue/manifest.json'), 'utf8')) as Manifest;
  const adapter = JSON.parse(fs.readFileSync(path.join(root, 'plugins/breezeblue/adapter.json'), 'utf8')) as Adapter;
  return { id: manifest.id, name: manifest.name, version: manifest.version, manifest, adapter, checksum: 'test', enabled: true, source: 'builtin' };
}

function result(json: unknown, status = 200): HttpResult {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    json,
    text: JSON.stringify(json),
    bytes: 0,
    latencyMs: 10,
    requestId: 'test-request',
    contentType: 'application/json',
  };
}

function caller(script: { summary: HttpOutcome[]; claim?: HttpOutcome[]; verify?: HttpOutcome[] }) {
  const calls: Operation[] = [];
  const pending = {
    summary: [...script.summary],
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

const unclaimed = result({
  balance: 1000,
  daily_claim_claimed_today: false,
  daily_claim_available: true,
  daily_claim_amount: 400,
  daily_claim_next_reset_at: '2026-11-18T08:00:00+08:00',
});

const claimed = result({
  balance: 1400,
  daily_claim_claimed_today: true,
  daily_claim_available: false,
  daily_claim_amount: 400,
  daily_claim_next_reset_at: '2026-11-18T08:00:00+08:00',
});

const claimOk = result({ claimed: true, credits_issued: 400, balance: 1400, daily_claim_claimed_today: true });

describe('BreezeBlue core state machine', () => {
  it('preflight -> claim -> verify succeeds only with summary and balance confirmation', async () => {
    const { call, calls } = caller({ summary: [{ result: unclaimed }], claim: [{ result: claimOk }], verify: [{ result: claimed }] });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verified).toBe(true);
    expect(outcome.creditsIssued).toBe(400);
    expect(outcome.preBalance).toBe(1000);
    expect(outcome.postBalance).toBe(1400);
    expect(calls).toEqual(['summary', 'claim', 'verify']);
  });

  it('does not POST when summary already says claimed', async () => {
    const { call, calls } = caller({ summary: [{ result: claimed }] });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('already_claimed');
    expect(outcome.verified).toBe(true);
    expect(calls).toEqual(['summary']);
  });

  it('marks AUTH_REQUIRED as needs_reauth and never claims', async () => {
    const { call, calls } = caller({
      summary: [{ result: result({ ok: false, code: 'AUTH_REQUIRED' }, 401), error: { code: 'AUTH_REQUIRED', message: '401', httpStatus: 401 } }],
    });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('needs_reauth');
    expect(outcome.verified).toBe(false);
    expect(outcome.httpStatus).toBe(401);
    expect(outcome.events.some((event) => event.type === 'response')).toBe(true);
    expect(calls).toEqual(['summary']);
  });

  it('marks a claim that cannot be re-confirmed as unverified', async () => {
    const notConfirmed = result({
      balance: 1400,
      daily_claim_claimed_today: false,
      daily_claim_available: true,
      daily_claim_amount: 400,
    });
    const { call } = caller({ summary: [{ result: unclaimed }], claim: [{ result: claimOk }], verify: [{ result: notConfirmed }] });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('unverified');
    expect(outcome.verified).toBe(false);
  });

  it('marks a balance delta that does not match as unverified', async () => {
    const tinyDelta = result({
      balance: 1050,
      daily_claim_claimed_today: true,
      daily_claim_available: false,
      daily_claim_amount: 400,
    });
    const { call } = caller({ summary: [{ result: unclaimed }], claim: [{ result: claimOk }], verify: [{ result: tinyDelta }] });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('unverified');
    expect(outcome.errorCode).toBe('VERIFY_MISMATCH');
  });

  it('handles claim=false plus already-claimed summary as a race, not a failure', async () => {
    const rejected = result({ claimed: false, credits_issued: 0, balance: 1400, daily_claim_claimed_today: true });
    const run = caller({ summary: [{ result: unclaimed }, { result: claimed }], claim: [{ result: rejected }] });
    const outcome = await checkInCore(plugin(), run.call, noSleep);
    expect(outcome.status).toBe('already_claimed');
    expect(run.calls).toEqual(['summary', 'claim', 'summary']);
  });

  it('marks unavailable preflight as skipped', async () => {
    const unavailable = result({
      balance: 1000,
      daily_claim_claimed_today: false,
      daily_claim_available: false,
      daily_claim_amount: 400,
    });
    const { call } = caller({ summary: [{ result: unavailable }] });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('skipped');
    expect(outcome.errorCode).toBe('NOT_AVAILABLE');
  });

  it('rejects a missing schema without claiming', async () => {
    const { call, calls } = caller({ summary: [{ result: result({ balance: 1000 }) }] });
    const outcome = await checkInCore(plugin(), call, noSleep);
    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('SCHEMA_MISMATCH');
    expect(calls).toEqual(['summary']);
  });
});

import type { PluginRecord, RunStatus } from '../types.js';
import { extractFields } from '../plugins/jsonpath.js';
import { evaluateRules } from '../plugins/rules.js';
import type { HttpOutcome, Operation } from './http.js';
import { ERROR_STATUS, friendlyMessage, type ErrorCode, type RunnerError } from './errors.js';

export interface CoreEvent {
  type: 'state' | 'response' | 'error';
  detail: Record<string, unknown>;
}

export interface CoreOutcome {
  status: RunStatus;
  errorCode?: string;
  message?: string;
  httpStatus?: number;
  preBalance?: number;
  postBalance?: number;
  creditsIssued?: number;
  claimed?: boolean;
  verified: boolean;
  events: CoreEvent[];
  summary?: {
    balance?: number;
    claimedToday?: boolean;
    available?: boolean;
    amount?: number;
    resetAt?: string;
  };
  latencyMs: number;
}

export type Caller = (operation: Operation) => Promise<HttpOutcome>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function errorOutcome(error: RunnerError, events: CoreEvent[], started: number): CoreOutcome {
  const code = error.code as ErrorCode;
  return {
    status: ERROR_STATUS[code] ?? 'failed',
    errorCode: error.code,
    message: friendlyMessage(code, error.message),
    httpStatus: error.httpStatus,
    verified: false,
    events,
    latencyMs: Date.now() - started,
  };
}

export async function checkInCore(
  plugin: PluginRecord,
  call: Caller,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<CoreOutcome> {
  const started = Date.now();
  const events: CoreEvent[] = [];
  const state = (status: string) => events.push({ type: 'state', detail: { status } });

  try {
    state('preflight');
    const pre = await call('summary');
    if (pre.error) {
      if (pre.result) {
        events.push({
          type: 'response',
          detail: {
            operation: 'summary',
            status: pre.result.status,
            bytes: pre.result.bytes,
            latencyMs: pre.result.latencyMs,
            requestId: pre.result.requestId,
          },
        });
      }
      events.push({ type: 'error', detail: { phase: 'preflight', code: pre.error.code } });
      return errorOutcome(pre.error, events, started);
    }
    if (!pre.result) throw new Error('missing summary response');

    const summaryExtract = extractFields(pre.result.json, plugin.adapter.extract.summary);
    events.push({
      type: 'response',
      detail: {
        operation: 'summary',
        status: pre.result.status,
        bytes: pre.result.bytes,
        latencyMs: pre.result.latencyMs,
        requestId: pre.result.requestId,
        extracted: summaryExtract,
      },
    });

    if (pre.result.status < 200 || pre.result.status >= 300) {
      events.push({ type: 'error', detail: { phase: 'preflight', code: 'HTTP_ERROR', status: pre.result.status } });
      return errorOutcome(
        { code: 'HTTP_ERROR', message: `HTTP ${pre.result.status}`, httpStatus: pre.result.status },
        events,
        started,
      );
    }

    const balance = numberOrUndefined(summaryExtract.balance);
    const claimedToday = boolOrUndefined(summaryExtract.claimedToday);
    const available = boolOrUndefined(summaryExtract.available);
    const amount = numberOrUndefined(summaryExtract.amount);
    const resetAt = typeof summaryExtract.resetAt === 'string' ? summaryExtract.resetAt : undefined;

    if (claimedToday === undefined) {
      events.push({ type: 'error', detail: { phase: 'preflight', code: 'SCHEMA_MISMATCH' } });
      return {
        status: 'failed',
        errorCode: 'SCHEMA_MISMATCH',
        message: friendlyMessage('SCHEMA_MISMATCH', 'summary missing daily_claim_claimed_today'),
        httpStatus: pre.result.status,
        events,
        verified: false,
        latencyMs: Date.now() - started,
      };
    }

    const preflight = evaluateRules(plugin.adapter.rules.preflight, { summary: summaryExtract });
    if (preflight === 'ALREADY_CLAIMED') {
      return {
        status: 'already_claimed',
        message: '今天已经领过了（summary 已确认）。',
        httpStatus: pre.result.status,
        preBalance: balance,
        postBalance: balance,
        creditsIssued: 0,
        claimed: true,
        verified: true,
        events,
        summary: { balance, claimedToday, available, amount, resetAt },
        latencyMs: Date.now() - started,
      };
    }
    if (preflight === 'NOT_AVAILABLE') {
      return {
        status: 'skipped',
        errorCode: 'NOT_AVAILABLE',
        message: friendlyMessage('NOT_AVAILABLE', 'not available'),
        httpStatus: pre.result.status,
        preBalance: balance,
        claimed: false,
        verified: true,
        events,
        summary: { balance, claimedToday, available, amount, resetAt },
        latencyMs: Date.now() - started,
      };
    }

    state('claiming');
    const claim = await call('claim');
    if (claim.error) {
      if (claim.result) {
        events.push({
          type: 'response',
          detail: {
            operation: 'claim',
            status: claim.result.status,
            bytes: claim.result.bytes,
            latencyMs: claim.result.latencyMs,
            requestId: claim.result.requestId,
          },
        });
      }
      events.push({ type: 'error', detail: { phase: 'claim', code: claim.error.code } });
      return errorOutcome(claim.error, events, started);
    }
    if (!claim.result) throw new Error('missing claim response');

    const claimExtract = extractFields(claim.result.json, plugin.adapter.extract.claim);
    events.push({
      type: 'response',
      detail: {
        operation: 'claim',
        status: claim.result.status,
        bytes: claim.result.bytes,
        latencyMs: claim.result.latencyMs,
        requestId: claim.result.requestId,
        extracted: claimExtract,
      },
    });

    if (claim.result.status < 200 || claim.result.status >= 300) {
      events.push({ type: 'error', detail: { phase: 'claim', code: 'HTTP_ERROR', status: claim.result.status } });
      return errorOutcome(
        { code: 'HTTP_ERROR', message: `HTTP ${claim.result.status}`, httpStatus: claim.result.status },
        events,
        started,
      );
    }

    const claimed = boolOrUndefined(claimExtract.claimed);
    const creditsIssued = numberOrUndefined(claimExtract.creditsIssued) ?? amount;
    const claimBalance = numberOrUndefined(claimExtract.balance);

    if (claimed !== true) {
      const race = await call('summary');
      const raceExtract = race.result ? extractFields(race.result.json, plugin.adapter.extract.summary) : {};
      if (boolOrUndefined(raceExtract.claimedToday) === true) {
        return {
          status: 'already_claimed',
          message: '领取返回未领取，但 summary 显示今天已领（并发竞态）。',
          httpStatus: claim.result.status,
          preBalance: balance,
          postBalance: numberOrUndefined(raceExtract.balance) ?? claimBalance,
          creditsIssued: 0,
          claimed: true,
          verified: true,
          events,
          summary: {
            balance: numberOrUndefined(raceExtract.balance) ?? balance,
            claimedToday: true,
            available: boolOrUndefined(raceExtract.available) ?? available,
            amount,
            resetAt: typeof raceExtract.resetAt === 'string' ? raceExtract.resetAt : resetAt,
          },
          latencyMs: Date.now() - started,
        };
      }
      return {
        status: 'failed',
        errorCode: 'CLAIM_REJECTED',
        message: friendlyMessage('CLAIM_REJECTED', 'claim returned claimed=false'),
        httpStatus: claim.result.status,
        preBalance: balance,
        postBalance: claimBalance,
        creditsIssued: 0,
        claimed: false,
        verified: false,
        events,
        summary: { balance: claimBalance ?? balance, claimedToday, available, amount, resetAt },
        latencyMs: Date.now() - started,
      };
    }

    state('verifying');
    await sleep(1500);
    const verify = await call('verify');
    if (verify.error) {
      if (verify.result) {
        events.push({
          type: 'response',
          detail: {
            operation: 'verify',
            status: verify.result.status,
            bytes: verify.result.bytes,
            latencyMs: verify.result.latencyMs,
            requestId: verify.result.requestId,
          },
        });
      }
      events.push({ type: 'error', detail: { phase: 'verify', code: verify.error.code } });
      return {
        status: 'unverified',
        errorCode: 'VERIFY_MISMATCH',
        message: friendlyMessage('VERIFY_MISMATCH', verify.error.message),
        httpStatus: verify.error.httpStatus ?? claim.result.status,
        preBalance: balance,
        postBalance: claimBalance,
        creditsIssued,
        claimed: true,
        verified: false,
        events,
        summary: { balance: claimBalance ?? balance, claimedToday: true, available, amount, resetAt },
        latencyMs: Date.now() - started,
      };
    }
    if (!verify.result) throw new Error('missing verify response');

    const verifyExtract = extractFields(verify.result.json, plugin.adapter.extract.summary);
    events.push({
      type: 'response',
      detail: {
        operation: 'verify',
        status: verify.result.status,
        bytes: verify.result.bytes,
        latencyMs: verify.result.latencyMs,
        requestId: verify.result.requestId,
        extracted: verifyExtract,
      },
    });

    if (verify.result.status < 200 || verify.result.status >= 300) {
      events.push({ type: 'error', detail: { phase: 'verify', code: 'HTTP_ERROR', status: verify.result.status } });
      return {
        status: 'unverified',
        errorCode: 'VERIFY_MISMATCH',
        message: `领取后复核返回 HTTP ${verify.result.status}，本次标记为未验证。`,
        httpStatus: verify.result.status,
        preBalance: balance,
        postBalance: claimBalance,
        creditsIssued,
        claimed: true,
        verified: false,
        events,
        summary: { balance: claimBalance ?? balance, claimedToday: true, available, amount, resetAt },
        latencyMs: Date.now() - started,
      };
    }

    const postBalance = numberOrUndefined(verifyExtract.balance);
    const postClaimed = boolOrUndefined(verifyExtract.claimedToday);
    const verifyRule = evaluateRules(plugin.adapter.rules.verify, { verify: verifyExtract });
    const deltaOk =
      typeof balance === 'number' &&
      typeof postBalance === 'number' &&
      typeof creditsIssued === 'number' &&
      creditsIssued > 0 &&
      postBalance - balance >= creditsIssued - 0.5;

    const verified = verifyRule === 'VERIFIED' && postClaimed === true && deltaOk;
    const summary = {
      balance: postBalance ?? claimBalance ?? balance,
      claimedToday: postClaimed ?? true,
      available: boolOrUndefined(verifyExtract.available) ?? available,
      amount,
      resetAt: typeof verifyExtract.resetAt === 'string' ? verifyExtract.resetAt : resetAt,
    };

    if (!verified) {
      events.push({ type: 'error', detail: { phase: 'verify', code: 'VERIFY_MISMATCH' } });
      return {
        status: 'unverified',
        errorCode: 'VERIFY_MISMATCH',
        message: deltaOk
          ? '领取接口声称成功，但今日状态未复核通过，本次标记为未验证。'
          : '领取接口声称成功，但余额没有按预期增加，本次标记为未验证。',
        httpStatus: verify.result.status,
        preBalance: balance,
        postBalance,
        creditsIssued,
        claimed: true,
        verified: false,
        events,
        summary,
        latencyMs: Date.now() - started,
      };
    }

    return {
      status: 'succeeded',
      message: `已领取 +${creditsIssued}，summary 与余额均已复核。`,
      httpStatus: verify.result.status,
      preBalance: balance,
      postBalance,
      creditsIssued,
      claimed: true,
      verified: true,
      events,
      summary,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    events.push({ type: 'error', detail: { phase: 'internal', code: 'INTERNAL' } });
    return {
      status: 'failed',
      errorCode: 'INTERNAL',
      message: friendlyMessage('INTERNAL', message),
      verified: false,
      events,
      latencyMs: Date.now() - started,
    };
  }
}

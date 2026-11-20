import type { PluginRecord, RunStatus } from '../types.js';
import { extractFields } from '../plugins/jsonpath.js';
import { deriveLedger, type LedgerDerived } from '../plugins/ledger.js';
import { evaluateRules } from '../plugins/rules.js';
import { localDate } from '../lib/time.js';
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

  const ledgerSpec = plugin.adapter.ledger;
  const today = localDate(ledgerSpec?.timezone ?? plugin.manifest.schedule.timezone);
  const verifyMapping = plugin.adapter.extract.verify ?? plugin.adapter.extract.summary;
  const verifyRules = plugin.adapter.rules.verify ?? [];
  const claimRules = plugin.adapter.rules.claim ?? [];

  /** 账单模式：读一次流水，判断今天有没有到账、到账多少。 */
  const readLedger = async (phase: 'preflight' | 'verify'): Promise<LedgerDerived | undefined> => {
    if (!ledgerSpec) return undefined;
    const outcome = await call('verify');
    if (outcome.error || !outcome.result) {
      events.push({ type: 'error', detail: { phase, code: outcome.error?.code ?? 'LEDGER_UNAVAILABLE' } });
      return undefined;
    }
    events.push({
      type: 'response',
      detail: {
        operation: 'verify',
        status: outcome.result.status,
        bytes: outcome.result.bytes,
        latencyMs: outcome.result.latencyMs,
        requestId: outcome.result.requestId,
      },
    });
    if (outcome.result.status < 200 || outcome.result.status >= 300) return undefined;
    try {
      return deriveLedger(ledgerSpec, outcome.result.json, today);
    } catch {
      events.push({ type: 'error', detail: { phase, code: 'LEDGER_UNREADABLE' } });
      return undefined;
    }
  };

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
    // 账单模式：summary 里没有「今天领没领」，先读流水补上这个判断。
    const ledgerBefore = boolOrUndefined(summaryExtract.claimedToday) === undefined ? await readLedger('preflight') : undefined;
    const claimedToday = boolOrUndefined(summaryExtract.claimedToday) ?? ledgerBefore?.claimedToday;
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
    if (preflight === 'ALREADY_CLAIMED' || claimedToday === true) {
      const alreadyCredits = ledgerBefore?.credits ?? 0;
      return {
        status: 'already_claimed',
        message:
          alreadyCredits > 0
            ? `今天已经领过了，账本里今天到账 +${alreadyCredits}。`
            : '今天已经领过了（summary 已确认）。',
        httpStatus: pre.result.status,
        preBalance: balance,
        postBalance: balance,
        creditsIssued: alreadyCredits,
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

    const claimVerdict = claimRules.length > 0 ? evaluateRules(claimRules, { claim: claimExtract }) : null;
    const claimed =
      boolOrUndefined(claimExtract.claimed) ??
      (claimVerdict === 'CLAIMED' ? true : claimVerdict === null ? undefined : false);
    const creditsIssued = numberOrUndefined(claimExtract.creditsIssued) ?? amount;
    const claimBalance = numberOrUndefined(claimExtract.balance);

    if (claimed !== true) {
      const race = await call('summary');
      const raceExtract = race.result ? extractFields(race.result.json, plugin.adapter.extract.summary) : {};
      const raceLedger =
        ledgerSpec && boolOrUndefined(raceExtract.claimedToday) === undefined ? await readLedger('preflight') : undefined;
      const raceClaimed = boolOrUndefined(raceExtract.claimedToday) ?? raceLedger?.claimedToday;
      if (raceClaimed === true) {
        return {
          status: 'already_claimed',
          message: '领取返回未领取，但账本显示今天已到账（并发竞态）。',
          httpStatus: claim.result.status,
          preBalance: balance,
          postBalance: numberOrUndefined(raceExtract.balance) ?? claimBalance,
          creditsIssued: raceLedger?.credits ?? 0,
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

    let ledgerAfter: LedgerDerived | undefined;
    if (ledgerSpec) {
      try {
        ledgerAfter = deriveLedger(ledgerSpec, verify.result.json, today);
      } catch {
        ledgerAfter = undefined;
      }
      // 平台账单有入账延迟：第一次没查到就等一会儿再读一次，仍没有才算未验证。
      if (ledgerAfter && !ledgerAfter.claimedToday) {
        await sleep(2500);
        const retry = await call('verify');
        if (!retry.error && retry.result && retry.result.status >= 200 && retry.result.status < 300) {
          events.push({
            type: 'response',
            detail: {
              operation: 'verify',
              status: retry.result.status,
              latencyMs: retry.result.latencyMs,
              requestId: retry.result.requestId,
            },
          });
          try {
            const again = deriveLedger(ledgerSpec, retry.result.json, today);
            if (again.claimedToday) ledgerAfter = again;
          } catch {
            /* 第二次读不到账单就沿用第一次的结论 */
          }
        }
      }
    }
    const verifyExtract = extractFields(verify.result.json, verifyMapping);
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
    const postClaimed = ledgerAfter ? ledgerAfter.claimedToday : boolOrUndefined(verifyExtract.claimedToday);
    const issued = ledgerAfter ? ledgerAfter.credits : creditsIssued;
    const verifyRule = verifyRules.length > 0 ? evaluateRules(verifyRules, { verify: verifyExtract }) : null;
    const ruleOk = verifyRules.length === 0 || verifyRule === 'VERIFIED';
    const deltaOk =
      typeof balance === 'number' &&
      typeof postBalance === 'number' &&
      typeof issued === 'number' &&
      issued > 0 &&
      postBalance - balance >= issued - 0.5;

    // 账单模式：以流水为准，余额可能延迟入账，只作参考不再作为否决条件。
    const verified = ledgerAfter
      ? ruleOk && postClaimed === true && ledgerAfter.credits > 0
      : ruleOk && postClaimed === true && deltaOk;
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
        message: ledgerAfter
          ? '触发成功，但账单里没有查到今天的到账记录，本次标记为未验证。'
          : deltaOk
            ? '领取接口声称成功，但今日状态未复核通过，本次标记为未验证。'
            : '领取接口声称成功，但余额没有按预期增加，本次标记为未验证。',
        httpStatus: verify.result.status,
        preBalance: balance,
        postBalance,
        creditsIssued: issued,
        claimed: true,
        verified: false,
        events,
        summary,
        latencyMs: Date.now() - started,
      };
    }

    return {
      status: 'succeeded',
      message: ledgerAfter
        ? `已领取 +${ledgerAfter.credits}，账单今天到账 ${ledgerAfter.matched} 笔，已复核。`
        : `已领取 +${creditsIssued}，summary 与余额均已复核。`,
      httpStatus: verify.result.status,
      preBalance: balance,
      postBalance,
      creditsIssued: issued,
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

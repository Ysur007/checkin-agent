import type { AccountRow, PluginRecord, RunStatus } from '../types.js';
import {
  acquireLock,
  addEvent,
  countRunsOn,
  getAccount,
  getClaimDay,
  getPolicyAck,
  getRunByIdem,
  isAutomationPaused,
  platformHasActiveLock,
  getSchedule,
  insertRun,
  newId,
  nowIso,
  recordClaimDay,
  releaseLock,
  runForDate,
  updateAccountAfterRun,
  updateAccountSummary,
  updateRun,
} from '../db/repo.js';
import { getLoadedPlugin } from '../plugins/loader.js';
import { getProvider } from '../providers/catalog.js';
import { getAutomationPolicy } from '../providers/policy.js';
import { checkPlatform, recordOutcome } from '../risk/breaker.js';
import { canaryHold, noteCanaryFailure, noteCanarySuccess } from '../risk/rollout.js';
import { isEnvironmentBlocked } from '../risk/environment.js';
import { accountHealth } from '../accounts/health.js';
import { open } from '../crypto/seal.js';
import { errorMessage, redactDetail } from '../crypto/redact.js';
import { localDate } from '../lib/time.js';
import { logger } from '../logger.js';
import { checkInCore, type CoreOutcome } from './core.js';
import { requestWithRetry } from './http.js';

export type Trigger = 'schedule' | 'manual' | 'backfill';

export interface StartResult {
  runId?: string;
  error?: string;
  message?: string;
  existing?: boolean;
}

export class ClaimRunner {
  /** 全局串行队列：手动、批量、定时共用，避免同平台并发。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly key: Buffer) {}

  async start(input: { accountId: string; trigger: Trigger }): Promise<StartResult> {
    const account = getAccount(input.accountId);
    if (!account) return { error: 'ACCOUNT_NOT_FOUND', message: '账号不存在' };
    if (!account.enabled) return { error: 'ACCOUNT_DISABLED', message: '账号已停用' };
    if (!account.cookie_sealed) return { error: 'COOKIE_MISSING', message: '还没有保存 Cookie' };

    const plugin = getLoadedPlugin(account.plugin_id);
    if (!plugin) {
      const provider = getProvider(account.plugin_id);
      return {
        error: provider ? 'CHECKIN_UNSUPPORTED' : 'PLUGIN_INVALID',
        message: provider ? '这个平台目前只接入登录与 Cookie 采集，签到接口还没有适配' : '插件未加载',
      };
    }

    if (isAutomationPaused()) {
      return { error: 'AUTOMATION_PAUSED', message: '自动化已暂停，请在风险面板恢复后再执行' };
    }

    if (input.trigger !== 'manual' && isEnvironmentBlocked()) {
      return {
        error: 'ENVIRONMENT_DRIFT',
        message: '网络出口地区或运营商已变化，自动任务已暂停；请在风险面板确认环境后再执行',
      };
    }

    const policy = getAutomationPolicy(account.plugin_id);
    if (policy.automation === 'prohibited') {
      return { error: 'POLICY_BLOCKED', message: '该平台的自动化策略标记为禁止，已阻止签到' };
    }
    if (policy.automation === 'unknown' && !getPolicyAck(plugin.id)) {
      return { error: 'POLICY_UNACKNOWLEDGED', message: '请先在风险面板核对并确认该平台的自动化条款' };
    }

    const health = accountHealth(account);
    if (health.score < 40) {
      return {
        error: 'SESSION_UNHEALTHY',
        message: `会话健康分 ${health.score}（${health.label}）：${health.reasons[0] ?? '请先重新登录或检测登录态'}`,
      };
    }

    const gate = checkPlatform(plugin.id);
    if (gate.blocked) {
      return {
        error: 'CIRCUIT_OPEN',
        message: `平台因连续验证挑战已暂停${gate.openUntil ? `（至 ${gate.openUntil.slice(0, 16).replace('T', ' ')} UTC）` : ''}`,
      };
    }
    if (gate.halfOpen && platformHasActiveLock(plugin.id)) {
      return { error: 'CIRCUIT_BUSY', message: '平台处于半开验证，已有账号在运行，稍后再试' };
    }

    const hold = canaryHold(plugin.id, account.id, account.label);
    if (hold) return { error: 'CANARY_HOLD', message: hold };

    const token = newId();
    if (!acquireLock(account.id, token, Date.now() + 15 * 60_000)) {
      return { error: 'LOCK_HELD', message: '已有任务在运行' };
    }

    try {
      const schedule = getSchedule();
      const date = localDate(schedule.timezone);
      const idemKey =
        input.trigger === 'schedule' || input.trigger === 'backfill'
          ? `${account.id}:${date}`
          : `${account.id}:${date}:${input.trigger}:${Date.now()}`;

      const existing = getRunByIdem(idemKey);
      if (existing) {
        releaseLock(account.id, token);
        return { runId: existing.id, existing: true };
      }

      const ledger = getClaimDay(account.id, date);
      if (ledger) {
        releaseLock(account.id, token);
        return {
          runId: ledger.run_id ?? undefined,
          existing: true,
          error: 'ALREADY_CLAIMED',
          message: `今天已经签到过（${ledger.status}），已阻止重复请求`,
        };
      }

      const attempt = countRunsOn(account.id, date) + 1;
      const runId = newId();
      const inserted = insertRun({
        id: runId,
        accountId: account.id,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        trigger: input.trigger,
        localDate: date,
        idemKey,
        status: 'queued',
        attempt,
      });

      if (!inserted) {
        releaseLock(account.id, token);
        const raced = getRunByIdem(idemKey);
        return { runId: raced?.id, existing: true };
      }

      addEvent(runId, 'state', { status: 'queued', trigger: input.trigger, attempt });
      this.queue = this.queue
        .then(() => this.execute({ runId, account, plugin, trigger: input.trigger, lockToken: token, date }))
        .catch((error) => {
          logger.error({ runId, error: errorMessage(error) }, 'queued run failed');
        });
      return { runId };
    } catch (error) {
      releaseLock(account.id, token);
      logger.error({ accountId: account.id, error: errorMessage(error) }, 'failed to start run');
      return { error: 'INTERNAL', message: errorMessage(error) };
    }
  }

  private async execute(input: {
    runId: string;
    account: AccountRow;
    plugin: PluginRecord;
    trigger: Trigger;
    lockToken: string;
    date: string;
  }): Promise<void> {
    const { runId, account, plugin, trigger, lockToken, date } = input;
    let finished = false;

    const finish = (outcome: CoreOutcome) => {
      if (finished) return;
      finished = true;
      try {
        for (const event of outcome.events) {
          addEvent(runId, event.type, redactDetail(event.detail));
        }
        updateRun(runId, {
          status: outcome.status,
          error_code: outcome.errorCode ?? null,
          error_message: outcome.message ?? null,
          http_status: outcome.httpStatus ?? null,
          pre_balance: outcome.preBalance ?? null,
          post_balance: outcome.postBalance ?? null,
          credits_issued: outcome.creditsIssued ?? 0,
          claimed_flag: outcome.claimed === undefined ? null : outcome.claimed ? 1 : 0,
          latency_ms: outcome.latencyMs,
          finished_at: nowIso(),
          evidence: JSON.stringify({
            verified: outcome.verified,
            status: outcome.status,
            responses: outcome.events.filter((event) => event.type === 'response').map((event) => event.detail),
          }),
        });
        if (outcome.status === 'succeeded' || outcome.status === 'already_claimed') {
          recordClaimDay({
            accountId: account.id,
            date,
            runId,
            status: outcome.status,
            credits: outcome.creditsIssued ?? null,
            httpStatus: outcome.httpStatus ?? null,
            verified: outcome.verified || outcome.status === 'already_claimed',
          });
        }
        try {
          recordOutcome({
            platformId: plugin.id,
            accountId: account.id,
            status: outcome.status,
            errorCode: outcome.errorCode ?? null,
          });
        } catch (error) {
          logger.warn({ runId, accountId: account.id, error: errorMessage(error) }, 'failed to record risk outcome');
        }
        try {
          if (outcome.status === 'succeeded' || outcome.status === 'already_claimed') {
            noteCanarySuccess(plugin.id, account.id, date);
          } else if (
            outcome.status === 'needs_reauth' ||
            outcome.status === 'rate_limited' ||
            outcome.errorCode === 'CHALLENGE_DETECTED'
          ) {
            noteCanaryFailure(plugin.id, account.id, outcome.errorCode ?? outcome.status);
          }
        } catch (error) {
          logger.warn({ runId, accountId: account.id, error: errorMessage(error) }, 'failed to update canary rollout');
        }
        updateAccountAfterRun(account.id, outcome.status, outcome.errorCode ?? null);
        if (outcome.summary) {
          updateAccountSummary(account.id, {
            balance: outcome.summary.balance ?? null,
            claimedToday: outcome.summary.claimedToday ?? null,
            available: outcome.summary.available ?? null,
            amount: outcome.summary.amount ?? null,
            resetAt: outcome.summary.resetAt ?? null,
          });
        }
        logger.info(
          {
            runId,
            accountId: account.id,
            plugin: plugin.id,
            trigger,
            status: outcome.status,
            credits: outcome.creditsIssued ?? 0,
            verified: outcome.verified,
          },
          'check-in run finished',
        );
      } catch (error) {
        logger.error({ runId, error: errorMessage(error) }, 'failed to persist run');
        updateRun(runId, {
          status: 'failed',
          error_code: 'INTERNAL',
          error_message: errorMessage(error),
          finished_at: nowIso(),
        });
      } finally {
        releaseLock(account.id, lockToken);
      }
    };

    try {
      updateRun(runId, { status: 'preflight' });

      let cookie: string;
      try {
        cookie = open(account.cookie_sealed!, `account:${account.id}:v1`, this.key);
      } catch (error) {
        finish({
          status: 'failed' as RunStatus,
          errorCode: 'INTERNAL',
          message: `Cookie 解密失败：${errorMessage(error)}`,
          verified: false,
          events: [{ type: 'error', detail: { phase: 'decrypt', code: 'INTERNAL' } }],
          latencyMs: 0,
        });
        return;
      }

      const outcome = await checkInCore(plugin, (operation) =>
        requestWithRetry(plugin, operation, cookie, plugin.manifest.limits.timeoutMs),
      );
      finish(outcome);
    } catch (error) {
      finish({
        status: 'failed',
        errorCode: 'INTERNAL',
        message: errorMessage(error),
        verified: false,
        events: [{ type: 'error', detail: { phase: 'execute', code: 'INTERNAL' } }],
        latencyMs: 0,
      });
    }
  }
}

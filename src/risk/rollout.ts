import { accountHealth } from '../accounts/health.js';
import { getRollout, listAccounts, recordRiskEvent, saveRollout } from '../db/repo.js';
import { getLoadedPlugin } from '../plugins/loader.js';
import type { AccountRow, RolloutRow, RolloutStage } from '../types.js';

/** 金丝雀需要连续多少个不同日期成功，才放开同平台其它账号。 */
export const CANARY_REQUIRED_DAYS = 2;

export interface RolloutView {
  platformId: string;
  stage: RolloutStage;
  canaryAccountId: string | null;
  canaryLabel: string | null;
  successDays: number;
  requiredDays: number;
  startedAt: string | null;
  note: string | null;
}

function eligibleAccounts(platformId: string): AccountRow[] {
  return listAccounts().filter(
    (account) =>
      account.plugin_id === platformId &&
      account.enabled &&
      Boolean(account.cookie_sealed) &&
      account.status !== 'needs_reauth' &&
      account.status !== 'disabled' &&
      Boolean(getLoadedPlugin(platformId)),
  );
}

/** 选金丝雀：健康分最高、最近成功最新的账号；excludeId 用于失败后换人。 */
export function pickCanary(platformId: string, excludeId?: string | null): AccountRow | null {
  const candidates = eligibleAccounts(platformId).filter((account) => account.id !== excludeId);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => {
    const diff = accountHealth(b).score - accountHealth(a).score;
    if (diff !== 0) return diff;
    return (b.last_ok_at ?? '').localeCompare(a.last_ok_at ?? '');
  })[0];
}

export function startCanary(platformId: string, reason = '手动开始灰度'): RolloutView | null {
  const plugin = getLoadedPlugin(platformId);
  if (!plugin) return null;
  const canary = pickCanary(platformId);
  if (!canary) return null;
  saveRollout({
    platformId,
    stage: 'canary',
    canaryAccountId: canary.id,
    startedAt: new Date().toISOString(),
    successDays: 0,
    lastSuccessDate: null,
    pluginVersion: plugin.manifest.version,
    note: reason,
  });
  recordRiskEvent({
    platformId,
    accountId: canary.id,
    kind: 'canary_start',
    detail: { accountId: canary.id, label: canary.label, note: reason },
  });
  return getRolloutView(platformId);
}

export function stopCanary(platformId: string, note = '手动结束灰度'): RolloutView | null {
  const row = getRollout(platformId);
  if (!row) return null;
  saveRollout({
    platformId,
    stage: 'open',
    canaryAccountId: null,
    startedAt: null,
    successDays: 0,
    lastSuccessDate: null,
    pluginVersion: getLoadedPlugin(platformId)?.manifest.version ?? row.plugin_version,
    note,
  });
  recordRiskEvent({ platformId, kind: 'canary_end', detail: { note } });
  return getRolloutView(platformId);
}

/** 金丝雀账号成功一次：按日期去重累计，达到要求后自动放开。 */
export function noteCanarySuccess(platformId: string, accountId: string, date: string): void {
  const row = getRollout(platformId);
  if (!row || row.stage !== 'canary') return;
  if (row.canary_account_id !== accountId) return;
  if (row.last_success_date === date) return;

  const successDays = row.success_days + 1;
  const plugin = getLoadedPlugin(platformId);
  if (successDays >= CANARY_REQUIRED_DAYS) {
    saveRollout({
      platformId,
      stage: 'open',
      canaryAccountId: null,
      startedAt: null,
      successDays: 0,
      lastSuccessDate: date,
      pluginVersion: plugin?.manifest.version ?? row.plugin_version,
      note: `金丝雀连续 ${successDays} 天成功，已放开该平台`,
    });
    recordRiskEvent({
      platformId,
      accountId,
      kind: 'canary_promote',
      detail: { days: successDays, note: '灰度通过，已放开同平台其它账号' },
    });
    return;
  }

  saveRollout({
    platformId,
    stage: 'canary',
    canaryAccountId: accountId,
    startedAt: row.started_at,
    successDays,
    lastSuccessDate: date,
    pluginVersion: row.plugin_version,
    note: row.note,
  });
  recordRiskEvent({
    platformId,
    accountId,
    kind: 'canary_pass',
    detail: { days: successDays, required: CANARY_REQUIRED_DAYS },
  });
}

/** 金丝雀账号失败：换一个账号继续观察，避免单个账号拖住整个平台。 */
export function noteCanaryFailure(platformId: string, accountId: string, reason: string): void {
  const row = getRollout(platformId);
  if (!row || row.stage !== 'canary') return;
  if (row.canary_account_id !== accountId) return;

  const next = pickCanary(platformId, accountId);
  saveRollout({
    platformId,
    stage: 'canary',
    canaryAccountId: next?.id ?? accountId,
    startedAt: row.started_at,
    successDays: 0,
    lastSuccessDate: null,
    pluginVersion: row.plugin_version,
    note: next ? `金丝雀失败（${reason}），已切换到 ${next.label}` : `金丝雀失败（${reason}），暂无其它可用账号`,
  });
  recordRiskEvent({
    platformId,
    accountId,
    kind: 'canary_rotate',
    detail: { reason, nextAccountId: next?.id ?? null, nextLabel: next?.label ?? null },
  });
}

export function getRolloutView(platformId: string): RolloutView {
  const row = getRollout(platformId);
  const label = row?.canary_account_id
    ? (listAccounts().find((account) => account.id === row.canary_account_id)?.label ?? null)
    : null;
  return {
    platformId,
    stage: row?.stage ?? 'open',
    canaryAccountId: row?.canary_account_id ?? null,
    canaryLabel: label,
    successDays: row?.success_days ?? 0,
    requiredDays: CANARY_REQUIRED_DAYS,
    startedAt: row?.started_at ?? null,
    note: row?.note ?? null,
  };
}

/** 执行器用：灰度期间只允许金丝雀账号运行。返回占位文本或 null。 */
export function canaryHold(platformId: string, accountId: string, accountLabel: string): string | null {
  const row: RolloutRow | undefined = getRollout(platformId);
  if (!row || row.stage !== 'canary') return null;
  if (row.canary_account_id === accountId) return null;

  const canary = row.canary_account_id
    ? (listAccounts().find((account) => account.id === row.canary_account_id)?.label ?? '金丝雀账号')
    : '金丝雀账号';
  return `该平台处于灰度观察，当前只允许「${canary}」先执行；${accountLabel} 稍后自动放开`;
}

/** 调度器用：灰度期间只有金丝雀账号参与自动执行。 */
export function canaryFilter(platformId: string, accountId: string): boolean {
  const row = getRollout(platformId);
  if (!row || row.stage !== 'canary') return true;
  return row.canary_account_id === accountId;
}

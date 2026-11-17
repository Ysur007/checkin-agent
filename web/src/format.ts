export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN');
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return '从未';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    ok: '正常',
    unconfigured: '未配置 Cookie',
    error: '异常',
    needs_reauth: '需要重新登录',
    rate_limited: '平台限流',
    succeeded: '已领取',
    already_claimed: '今日已领',
    unverified: '未验证',
    failed: '失败',
    skipped: '已跳过',
    queued: '排队中',
    preflight: '读取状态',
    claiming: '领取中',
    verifying: '复核中',
  };
  return map[status] ?? status;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'run';

export function statusTone(status: string): Tone {
  if (status === 'succeeded' || status === 'already_claimed' || status === 'ok') return 'ok';
  if (status === 'unverified' || status === 'skipped' || status === 'rate_limited') return 'warn';
  if (status === 'needs_reauth' || status === 'failed' || status === 'error') return 'bad';
  if (status === 'queued' || status === 'preflight' || status === 'claiming' || status === 'verifying') return 'run';
  return 'muted';
}

export function triggerLabel(trigger: string): string {
  const map: Record<string, string> = {
    manual: '手动',
    schedule: '定时',
    backfill: '补偿',
    retry: '重试',
  };
  return map[trigger] ?? trigger;
}

export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function isTerminal(status: string): boolean {
  return ['succeeded', 'already_claimed', 'unverified', 'needs_reauth', 'rate_limited', 'skipped', 'failed'].includes(
    status,
  );
}

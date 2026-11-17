export type HealthLevel = 'healthy' | 'watch' | 'at_risk' | 'invalid';

export interface HealthScore {
  score: number;
  level: HealthLevel;
  label: string;
  reasons: string[];
}

export interface HealthInput {
  hasCookie: boolean;
  expired: boolean;
  status: string;
  /** 有签到适配器时为 true；只做登录采集的账号不按校验/运行记录扣分。 */
  verifiable: boolean;
  verified: boolean;
  checkedAt: string | null;
  failStreak: number;
  lastOkAt: string | null;
  challenges24h: number;
  now?: number;
}

const DAY = 86_400_000;

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor((now - value) / DAY));
}

function levelOf(score: number): { level: HealthLevel; label: string } {
  if (score >= 80) return { level: 'healthy', label: '正常' };
  if (score >= 60) return { level: 'watch', label: '观察' };
  if (score >= 40) return { level: 'at_risk', label: '风险' };
  return { level: 'invalid', label: '需重登' };
}

/**
 * 纯函数健康分：只使用账号自身状态 + 近 24 小时挑战次数，便于测试与解释。
 * 分数不是平台真实风控结果，只是本地保守估计。
 */
export function scoreAccountHealth(input: HealthInput): HealthScore {
  if (!input.hasCookie) {
    return { score: 0, level: 'invalid', label: '需重登', reasons: ['还没有保存登录态'] };
  }
  if (input.expired) {
    return { score: 0, level: 'invalid', label: '需重登', reasons: ['Cookie 已过期'] };
  }
  if (!input.verifiable) {
    if (input.status === 'needs_reauth') {
      return { score: 20, level: 'invalid', label: '需重登', reasons: ['平台要求重新登录'] };
    }
    return { score: 100, level: 'healthy', label: '正常', reasons: [] };
  }

  const now = input.now ?? Date.now();
  let score = 100;
  const reasons: string[] = [];

  if (input.status === 'needs_reauth') {
    score -= 80;
    reasons.push('平台要求重新登录');
  } else if (input.status === 'error') {
    score -= 15;
    reasons.push('最近运行异常');
  } else if (input.status === 'rate_limited') {
    score -= 20;
    reasons.push('平台限流');
  }

  if (!input.verified) {
    score -= 20;
    reasons.push('Cookie 尚未通过平台校验');
  }

  const checkedDays = daysSince(input.checkedAt, now);
  if (checkedDays === null) {
    score -= 10;
    reasons.push('还没有校验记录');
  } else if (checkedDays > 7) {
    score -= 10;
    reasons.push('超过 7 天未校验');
  } else if (checkedDays > 3) {
    score -= 5;
    reasons.push('超过 3 天未校验');
  }

  if (input.failStreak > 0) {
    score -= Math.min(30, input.failStreak * 10);
    reasons.push(`连续 ${input.failStreak} 次失败`);
  }

  const okDays = daysSince(input.lastOkAt, now);
  if (okDays === null) {
    score -= 10;
    reasons.push('还没有成功记录');
  } else if (okDays > 7) {
    score -= 15;
    reasons.push('超过 7 天没有成功');
  } else if (okDays > 3) {
    score -= 8;
    reasons.push('超过 3 天没有成功');
  }

  if (input.challenges24h > 0) {
    score -= Math.min(30, input.challenges24h * 10);
    reasons.push(`近 24 小时 ${input.challenges24h} 次挑战`);
  }

  const clamped = Math.max(0, Math.min(100, score));
  const { level, label } = levelOf(clamped);
  return { score: clamped, level, label, reasons };
}

export function healthTone(score: number): 'ok' | 'warn' | 'bad' {
  if (score >= 80) return 'ok';
  if (score >= 40) return 'warn';
  return 'bad';
}

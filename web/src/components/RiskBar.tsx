import type { RiskOverview } from '../types';
import { IconAlert, IconCheck, IconExternal, IconRefresh, IconShield } from './icons';

interface Props {
  risk: RiskOverview;
  busy: boolean;
  onPause: (paused: boolean) => void;
  onReset: (platformId?: string) => void;
  onAck: (platformId: string) => void;
  onCanary: (platformId: string, stage: 'canary' | 'open') => void;
  onEnvAck: () => void;
  onEvents: () => void;
}

export function RiskBar({ risk, busy, onPause, onReset, onAck, onCanary, onEnvAck, onEvents }: Props) {
  const blocked = risk.platforms.filter((platform) => platform.blocked);
  const halfOpen = risk.platforms.filter((platform) => platform.state === 'half_open');
  const canary = risk.platforms.filter((platform) => platform.rollout.stage === 'canary');
  const policyPending = risk.platforms.find(
    (platform) =>
      platform.policy.automation === 'unknown' &&
      platform.checkIn &&
      !platform.policyAcknowledged &&
      (platform.accountCount > 0 || platform.runs24h > 0),
  );
  const env = risk.environment;
  const envBlocked = env.blocked;

  const historical =
    !risk.paused && !envBlocked && blocked.length === 0 && halfOpen.length === 0 && risk.totals.challenges24h > 0;
  const tone =
    risk.paused || envBlocked || blocked.length > 0
      ? 'bad'
      : halfOpen.length > 0 || risk.totals.challenges24h > 0 || policyPending
        ? 'warn'
        : 'ok';

  const title = risk.paused
    ? '自动化已暂停'
    : envBlocked
      ? '网络出口已变化'
      : blocked.length > 0
        ? `${blocked.map((platform) => platform.name).join('、')} 已熔断`
        : halfOpen.length > 0
          ? `${halfOpen.map((platform) => platform.name).join('、')} 处于半开验证`
          : policyPending
            ? '需要确认平台条款'
            : canary.length > 0
              ? `${canary.map((platform) => platform.name).join('、')} 灰度观察中`
              : historical
                ? '近期有挑战记录'
                : '风险控制正常';

  const description = risk.paused
    ? '定时与手动签到都会被拦截；登录、Cookie 更新和记录查看不受影响。'
    : envBlocked
      ? `${env.note ?? '出口地区或运营商发生变化'}。自动任务已暂停，确认环境后恢复。`
      : blocked.length > 0
        ? `${blocked[0].reason ?? '连续出现验证挑战'}。到期后自动进入半开验证，只允许一次执行。`
        : halfOpen.length > 0
          ? '只允许一次真实执行；成功会自动恢复，再次遇到挑战会重新熔断。'
          : policyPending
            ? `${policyPending.name} 的自动化条款尚未确认；确认后才会执行签到。`
            : canary.length > 0
              ? `${canary[0].rollout.canaryLabel ?? '金丝雀账号'} 先行执行，连续 ${canary[0].rollout.requiredDays} 天成功后才会放开同平台其它账号。`
              : historical
                ? `近 24 小时有 ${risk.totals.challenges24h} 次挑战记录；当前按正常频率执行，再次触发会重新熔断。`
                : risk.totals.runs24h === 0
                  ? '还没有自动执行记录；挑战、限流和熔断会记录在这里。'
                  : '挑战率低于阈值；执行保持串行、随机窗口，并受每小时启动上限约束。';

  return (
    <section className={`risk-bar is-${tone}`} aria-label="风险控制状态">
      <div className="risk-main">
        <span className="risk-icon" aria-hidden="true">
          {tone === 'ok' ? <IconCheck size={14} /> : tone === 'warn' ? <IconShield size={14} /> : <IconAlert size={14} />}
        </span>
        <div>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
      </div>

      <div className="risk-metrics">
        <span>
          <b>{risk.totals.runs24h}</b> 运行 / 24h
        </span>
        <span>
          <b>{risk.totals.challenges24h}</b> 挑战
        </span>
        <span>
          <b>{risk.totals.rate}%</b> 挑战率
        </span>
      </div>

      <div className="risk-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEvents}>
          事件
        </button>
        {(envBlocked || blocked.length > 0) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => (envBlocked ? onEnvAck() : onReset(blocked[0].platformId))}
            disabled={busy}
          >
            <IconRefresh size={12} /> {envBlocked ? '确认环境' : '恢复平台'}
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm ${risk.paused ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onPause(!risk.paused)}
          disabled={busy}
        >
          {risk.paused ? '恢复自动化' : '暂停全部'}
        </button>
      </div>

      {policyPending && (
        <p className="risk-policy">
          {policyPending.name}：自动化条款待确认，确认前不会执行签到。
          {policyPending.policy.termsUrl && (
            <a href={policyPending.policy.termsUrl} target="_blank" rel="noreferrer">
              查看条款 <IconExternal size={10} />
            </a>
          )}
          <button type="button" className="link-btn" onClick={() => onAck(policyPending.platformId)} disabled={busy}>
            我已核对条款
          </button>
        </p>
      )}

      {canary.length > 0 && (
        <p className="risk-policy">
          {canary.map((platform) => (
            <span key={platform.platformId} className="risk-canary">
              {platform.name}：金丝雀「{platform.rollout.canaryLabel ?? '未指定'}」 ·{' '}
              {platform.rollout.successDays}/{platform.rollout.requiredDays} 天
              <button
                type="button"
                className="link-btn"
                onClick={() => onCanary(platform.platformId, 'open')}
                disabled={busy}
              >
                结束灰度
              </button>
            </span>
          ))}
        </p>
      )}

      {env.ip && (env.drift !== 'none' || env.lastError) && (
        <p className="risk-policy">
          基线出口 <code>{env.ip}</code>
          {env.country ? ` · ${env.country}` : ''}
          {env.org ? ` · ${env.org}` : ''}
          {env.drift === 'minor' ? ' · 同地区 IP 变动，已自动沿用新出口' : ''}
          {envBlocked ? ' · 待你确认后恢复自动任务' : ''}
          {env.lastError ? ` · 最近探测失败：${env.lastError}` : ''}
        </p>
      )}
    </section>
  );
}

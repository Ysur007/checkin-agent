import type { RiskOverview } from '../types';
import { IconAlert, IconCheck, IconExternal, IconRefresh, IconShield } from './icons';

interface Props {
  risk: RiskOverview;
  busy: boolean;
  onPause: (paused: boolean) => void;
  onReset: (platformId?: string) => void;
  onEvents: () => void;
}

export function RiskBar({ risk, busy, onPause, onReset, onEvents }: Props) {
  const blocked = risk.platforms.filter((platform) => platform.blocked);
  const halfOpen = risk.platforms.filter((platform) => platform.state === 'half_open');
  const policyNote = risk.platforms.find(
    (platform) => platform.policy.automation === 'unknown' && platform.policy.note && platform.runs24h > 0,
  );

  const tone = risk.paused || blocked.length > 0 ? 'bad' : halfOpen.length > 0 || risk.totals.challenges24h > 0 ? 'warn' : 'ok';

  const title = risk.paused
    ? '自动化已暂停'
    : blocked.length > 0
      ? `${blocked.map((platform) => platform.name).join('、')} 已熔断`
      : halfOpen.length > 0
        ? `${halfOpen.map((platform) => platform.name).join('、')} 处于半开验证`
        : '风险控制正常';

  const description = risk.paused
    ? '定时与手动签到都会被拦截；登录、Cookie 更新和记录查看不受影响。'
    : blocked.length > 0
      ? `${blocked[0].reason ?? '连续出现验证挑战'}。到期后自动进入半开验证，只允许一次执行。`
      : halfOpen.length > 0
        ? '只允许一次真实执行；成功会自动恢复，再次遇到挑战会重新熔断。'
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
        {blocked.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReset(blocked[0].platformId)} disabled={busy}>
            <IconRefresh size={12} /> 恢复平台
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

      {policyNote && (
        <p className="risk-policy">
          {policyNote.name}：{policyNote.policy.automation === 'unknown' ? '自动化条款待确认' : policyNote.policy.note}
          {policyNote.policy.termsUrl && (
            <a href={policyNote.policy.termsUrl} target="_blank" rel="noreferrer">
              查看条款 <IconExternal size={10} />
            </a>
          )}
        </p>
      )}
    </section>
  );
}

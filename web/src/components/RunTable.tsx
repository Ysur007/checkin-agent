import type { RunDto } from '../types';
import { formatDuration, formatNumber, formatTime, triggerLabel } from '../format';
import { StatusPill } from './StatusPill';

interface Props {
  runs: RunDto[];
  onOpen: (runId: string) => void;
  compact?: boolean;
}

export function RunTable({ runs, onOpen, compact = false }: Props) {
  if (runs.length === 0) {
    return <div className="table-empty">还没有运行记录。点「立即领取」或等待定时任务。</div>;
  }

  return (
    <div className={`table-wrap ${compact ? 'table-compact' : ''}`}>
      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>状态</th>
            {!compact && <th>触发</th>}
            <th className="ta-r">积分</th>
            {!compact && <th className="ta-r">耗时</th>}
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} onClick={() => onOpen(run.id)} tabIndex={0} onKeyDown={(event) => {
              if (event.key === 'Enter') onOpen(run.id);
            }}>
              <td className="mono">{formatTime(run.startedAt)}</td>
              <td>
                <StatusPill status={run.status} />
              </td>
              {!compact && <td>{triggerLabel(run.trigger)}</td>}
              <td className={`ta-r ${run.creditsIssued ? 'strong' : 'muted'}`}>
                {run.creditsIssued ? `+${formatNumber(run.creditsIssued)}` : '—'}
              </td>
              {!compact && <td className="ta-r muted">{formatDuration(run.latencyMs)}</td>}
              <td className="cell-note">
                {run.errorMessage ?? (run.verified ? 'HTTP 与 summary 均已复核' : '—')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-hint">点任意一行查看请求时间线、HTTP 状态与余额复核证据。</p>
    </div>
  );
}

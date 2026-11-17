import { useEffect, useState } from 'react';
import type { RunDetail } from '../types';
import { get } from '../api';
import { Modal } from './Modal';
import { StatusPill } from './StatusPill';
import { formatDuration, formatNumber, formatTime, triggerLabel } from '../format';

interface Props {
  runId: string;
  onClose: () => void;
}

export function RunDetailModal({ runId, onClose }: Props) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    get<RunDetail>(`/api/runs/${runId}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return (
    <Modal title="运行详情" subtitle={runId.slice(0, 8)} onClose={onClose} width={720}>
      {error && <p className="form-error">{error}</p>}
      {!detail && !error && <p className="muted">加载中…</p>}
      {detail && (
        <div className="run-detail">
          <div className="run-summary">
            <StatusPill status={detail.run.status} />
            <span className="muted">{triggerLabel(detail.run.trigger)}</span>
            <span className="muted">{formatTime(detail.run.startedAt)}</span>
            {detail.run.verified && <span className="verified-mark">已验证</span>}
          </div>

          {detail.run.errorMessage && <p className="run-error">{detail.run.errorMessage}</p>}

          <div className="run-metrics">
            <div>
              <span>积分</span>
              <strong>{detail.run.creditsIssued ? `+${formatNumber(detail.run.creditsIssued)}` : '—'}</strong>
            </div>
            <div>
              <span>余额</span>
              <strong className="text">
                {formatNumber(detail.run.preBalance)} → {formatNumber(detail.run.postBalance)}
              </strong>
            </div>
            <div>
              <span>HTTP</span>
              <strong className="text">{detail.run.httpStatus ?? '—'}</strong>
            </div>
            <div>
              <span>耗时</span>
              <strong className="text">{formatDuration(detail.run.latencyMs)}</strong>
            </div>
          </div>

          <h3 className="detail-heading">时间线</h3>
          <ol className="timeline">
            {detail.events.map((event) => (
              <li key={event.seq}>
                <span className="timeline-time mono">{formatTime(event.at)}</span>
                <div className="timeline-body">
                  <div className="timeline-type">
                    {event.type === 'state' && '状态'}
                    {event.type === 'response' && 'HTTP 响应'}
                    {event.type === 'error' && '错误'}
                    {event.type !== 'state' && event.type !== 'response' && event.type !== 'error' && event.type}
                  </div>
                  {event.type === 'state' && (
                    <p className="timeline-text">进入 {String(event.detail.status ?? '')}</p>
                  )}
                  {event.type === 'response' && (
                    <div className="timeline-response">
                      <p className="timeline-text">
                        {String(event.detail.operation ?? '')} · HTTP {String(event.detail.status ?? '')} ·{' '}
                        {formatNumber(Number(event.detail.bytes ?? 0))} bytes ·{' '}
                        {formatDuration(Number(event.detail.latencyMs ?? 0))}
                      </p>
                      {event.detail.requestId ? (
                        <p className="timeline-meta mono">requestId {String(event.detail.requestId)}</p>
                      ) : null}
                      <pre className="code-block">{JSON.stringify(event.detail.extracted ?? {}, null, 2)}</pre>
                    </div>
                  )}
                  {event.type === 'error' && (
                    <p className="timeline-text">{String(event.detail.code ?? '')}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <h3 className="detail-heading">证据</h3>
          <pre className="code-block">{JSON.stringify(detail.run.evidence, null, 2)}</pre>
        </div>
      )}
    </Modal>
  );
}

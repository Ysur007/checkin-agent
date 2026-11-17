import { useEffect, useState } from 'react';
import type { RiskEventItem } from '../types';
import { get } from '../api';
import { formatDateTime } from '../format';
import { Modal } from './Modal';
import { IconAlert } from './icons';

const KIND_LABEL: Record<string, string> = {
  challenge: '验证挑战',
  rate_limited: '平台限流',
  auth_required: '登录失效',
  unverified: '复核未通过',
  circuit_open: '熔断开启',
  circuit_close: '熔断恢复',
  pause: '暂停自动化',
  resume: '恢复自动化',
};

interface Props {
  onClose: () => void;
}

function detailText(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.status === 'string') parts.push(detail.status);
  if (typeof detail.errorCode === 'string' && detail.errorCode) parts.push(detail.errorCode);
  if (typeof detail.reason === 'string') parts.push(detail.reason);
  if (typeof detail.openUntil === 'string') parts.push(`至 ${formatDateTime(detail.openUntil)}`);
  if (typeof detail.note === 'string') parts.push(detail.note);
  return parts.join(' · ') || '—';
}

export function RiskEventsModal({ onClose }: Props) {
  const [items, setItems] = useState<RiskEventItem[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    get<{ items: RiskEventItem[] }>('/api/risk/events?limit=60')
      .then((result) => {
        if (alive) setItems(result.items);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : '加载风险事件失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Modal
      title="风险事件"
      subtitle="只记录行为层信号：验证挑战、限流、熔断与暂停。不包含 Cookie、响应正文或账号密码。"
      onClose={onClose}
      width={680}
    >
      {error && <p className="form-error">{error}</p>}
      {!items && !error && <p className="muted small">正在加载…</p>}
      {items && items.length === 0 && (
        <div className="empty-card">
          <IconAlert size={18} />
          <p>还没有风险事件。出现验证码、限流或登录失效后会记录在这里。</p>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="risk-event-list">
          {items.map((item) => (
            <div className="risk-event-row" key={item.id}>
              <span className={`risk-event-kind kind-${item.kind}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>
              <span className="risk-event-platform">{item.platform}</span>
              <span className="muted small">{formatDateTime(item.at)}</span>
              <span className="risk-event-detail">{detailText(item.detail)}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

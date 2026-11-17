import { useEffect, useMemo, useState } from 'react';
import type { ProviderCatalogItem, ProvidersData } from '../types';
import { get } from '../api';
import { Modal } from './Modal';
import { ProviderIcon } from './ProviderIcon';
import { IconExternal, IconSearch, IconShield } from './icons';

interface Props {
  onClose: () => void;
  onStart: (input: { providerId: string; loginUrl?: string; label: string }) => Promise<void>;
}

type Step = { kind: 'pick' } | { kind: 'prepare'; provider: ProviderCatalogItem };

export function AddAccountDialog({ onClose, onStart }: Props) {
  const [data, setData] = useState<ProvidersData | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    get<ProvidersData>('/api/providers')
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : '加载平台列表失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  const items = useMemo(() => {
    const list = data?.items ?? [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter(
      (item) =>
        item.name.toLowerCase().includes(keyword) ||
        item.id.includes(keyword) ||
        item.description.toLowerCase().includes(keyword),
    );
  }, [data, query]);

  const pick = (provider: ProviderCatalogItem) => {
    setStep({ kind: 'prepare', provider });
    setLabel(provider.name);
    setUrl(provider.loginUrl ?? '');
    setError('');
  };

  const start = async () => {
    if (step.kind !== 'prepare') return;
    if (!url.trim()) {
      setError('请填写登录页地址');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onStart({ providerId: step.provider.id, loginUrl: url.trim(), label: label.trim() || '新账号' });
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建账号失败');
      setBusy(false);
    }
  };

  const title = step.kind === 'pick' ? '添加账号' : step.provider.name;
  const subtitle =
    step.kind === 'pick'
      ? '列出的平台都已经接入签到接口：添加账号后登录一次，就能自动执行每日签到。'
      : '确认登录页地址后继续；地址栏可以改成该平台实际的登录页。';

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose} width={step.kind === 'pick' ? 880 : 560}>
      {step.kind === 'pick' ? (
        <>
          <div className="picker-top">
            <label className="picker-search">
              <IconSearch size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索平台…"
                aria-label="搜索平台"
              />
            </label>
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="provider-grid">
            {!data && !error && <p className="muted small">正在加载平台…</p>}
            {items.map((provider) => (
              <button key={provider.id} type="button" className="provider-tile" onClick={() => pick(provider)}>
                <ProviderIcon provider={provider} size={32} />
                <span className="provider-tile-text">
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.accountCount > 0 ? `${provider.accountCount} 个账号` : provider.description}
                  </small>
                </span>
                <span className={`provider-flag ${provider.adapterReady ? 'is-ready' : ''}`}>
                  {provider.adapterReady ? '可签到' : '缺少适配器'}
                </span>
              </button>
            ))}
            {data && items.length === 0 && <p className="muted small">没有匹配的平台。</p>}
          </div>
        </>
      ) : (
        <div className="prepare">
          <div className="prepare-head">
            <ProviderIcon provider={step.provider} size={36} />
            <div>
              <strong>{step.provider.name}</strong>
              <p>{step.provider.description}</p>
            </div>
          </div>

          <label className="field">
            <span className="field-label">账号备注</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={40}
              placeholder="例如：主账号"
            />
          </label>

          <label className="field">
            <span className="field-label">登录页地址</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/login"
              spellCheck={false}
              autoCapitalize="off"
            />
            <span className="field-hint">
              在这个地址打开登录页；只采集该域及其子域的 Cookie。
              {step.provider.homepage && (
                <a className="inline-link" href={step.provider.homepage} target="_blank" rel="noreferrer">
                  打开官网 <IconExternal size={11} />
                </a>
              )}
            </span>
          </label>

          <div className="picker-note">
            <IconShield size={15} />
            <p>
              不要在对话或工单里粘贴 Cookie。登录态可以用浏览器扩展一键回传，或从开发者工具复制 Cookie 头粘贴进来；
              保存时使用 AES-256-GCM 加密，接口只返回指纹和字段名。
            </p>
          </div>

          {error && <p className="form-error">{error}</p>}
        </div>
      )}

      {step.kind === 'prepare' && (
        <div className="prepare-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'pick' })} disabled={busy}>
            返回
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={busy}>
            {busy ? '正在创建…' : '创建并登录'}
          </button>
        </div>
      )}
    </Modal>
  );
}

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

type Step = { kind: 'pick' } | { kind: 'prepare'; provider: ProviderCatalogItem | null; custom: boolean };

const CUSTOM_TILE: ProviderCatalogItem = {
  id: 'custom',
  name: '自定义平台',
  short: '自',
  tint: '#3f3f46',
  description: '填写登录页地址，捕获任意平台的 Cookie',
  loginUrl: null,
  primaryCookie: null,
  checkIn: 'none',
  category: 'custom',
  adapterReady: false,
  accountCount: 0,
  accounts: [],
};

export function AddAccountDialog({ onClose, onStart }: Props) {
  const [data, setData] = useState<ProvidersData | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'agent' | 'custom'>('agent');
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

  const pick = (provider: ProviderCatalogItem, custom = false) => {
    setStep({ kind: 'prepare', provider, custom });
    setLabel(custom ? '自定义账号' : provider.name);
    setUrl(provider.loginUrl ?? '');
    setError('');
  };

  const start = async () => {
    if (step.kind !== 'prepare') return;
    const providerId = step.custom ? 'custom' : step.provider!.id;
    if (!url.trim()) {
      setError('请填写登录页地址');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onStart({ providerId, loginUrl: url.trim(), label: label.trim() || '新账号' });
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建账号失败');
      setBusy(false);
    }
  };

  const title = step.kind === 'pick' ? '添加账号' : step.custom ? '自定义平台' : step.provider?.name ?? '添加账号';
  const subtitle =
    step.kind === 'pick'
      ? '在服务端的浏览器里完成登录，登录成功后自动提取并加密保存 Cookie。'
      : '确认登录页地址后打开窗口；地址栏可以改成该平台实际的登录页。';

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose} width={step.kind === 'pick' ? 880 : 560}>
      {step.kind === 'pick' ? (
        <>
          <div className="picker-top">
            <div className="seg-tabs" role="tablist" aria-label="平台类型">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'agent'}
                className={`seg-tab ${tab === 'agent' ? 'is-active' : ''}`}
                onClick={() => setTab('agent')}
              >
                Agent 平台
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'custom'}
                className={`seg-tab ${tab === 'custom' ? 'is-active' : ''}`}
                onClick={() => setTab('custom')}
              >
                自定义
              </button>
            </div>

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

          {tab === 'agent' ? (
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
                    {provider.adapterReady ? '可签到' : provider.checkIn === 'adapter' ? '待加载' : '仅登录'}
                  </span>
                </button>
              ))}
              {data && items.length === 0 && <p className="muted small">没有匹配的平台，试试「自定义」。</p>}
            </div>
          ) : (
            <div className="custom-panel">
              <button type="button" className="provider-tile is-wide" onClick={() => pick(CUSTOM_TILE, true)}>
                <ProviderIcon provider={CUSTOM_TILE} size={32} />
                <span className="provider-tile-text">
                  <strong>自定义平台</strong>
                  <small>任何有网页登录入口的平台；只要填写登录页地址就能采集 Cookie</small>
                </span>
                <span className="provider-flag">仅登录</span>
              </button>
              <div className="picker-note">
                <IconShield size={15} />
                <p>
                  浏览器只会把登录页所在域及其子域的 Cookie 带回来，不会读取浏览器里其它站点的登录态。签到接口尚未适配的平台，
                  可以在 <code>plugins/</code> 目录里补一个 adapter。
                </p>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="prepare">
          <div className="prepare-head">
            <ProviderIcon provider={step.custom ? CUSTOM_TILE : step.provider!} size={36} />
            <div>
              <strong>{step.custom ? '自定义平台' : step.provider!.name}</strong>
              <p>{step.custom ? '填写你的平台登录页' : step.provider!.description}</p>
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
              会在这个地址打开服务端浏览器；只采集该域及其子域的 Cookie。
              {(step.custom ? false : step.provider?.homepage) && (
                <a
                  className="inline-link"
                  href={(step.custom ? '' : step.provider?.homepage) || '#'}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开官网 <IconExternal size={11} />
                </a>
              )}
            </span>
          </label>

          <div className="picker-note">
            <IconShield size={15} />
            <p>
              不要在对话或工单里粘贴 Cookie。登录在服务端浏览器里完成，捕获后使用 AES-256-GCM 加密保存，接口只返回指纹和字段名。
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

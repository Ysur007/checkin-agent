import { useCallback, useEffect, useState } from 'react';
import type { DiscoverPlugin, PluginDto, PluginsData } from '../types';
import { get, post } from '../api';
import type { ToastTone } from '../components/Toast';
import { StatusPill } from '../components/StatusPill';
import { IconExternal, IconPuzzle, IconRefresh, IconShield } from '../components/icons';

type Tab = 'builtin' | 'installed' | 'discover';

interface Props {
  notify: (message: string, tone?: ToastTone) => void;
}

function PluginCard({
  plugin,
  onToggle,
  busy,
}: {
  plugin: PluginDto;
  onToggle: () => void;
  busy: boolean;
}) {
  return (
    <article className="plugin-card">
      <div className="card-head">
        <div className="platform-id">
          <span className="platform-icon" aria-hidden="true">B</span>
          <div>
            <h3>{plugin.name}</h3>
            <p>
              内置插件 v{plugin.version} · {plugin.baseUrl}
            </p>
          </div>
        </div>
        <div className="plugin-head-right">
          <StatusPill status={plugin.enabled ? 'ok' : 'skipped'} label={plugin.enabled ? '已启用' : '已停用'} />
          <button
            type="button"
            className={`toggle ${plugin.enabled ? 'is-on' : ''}`}
            onClick={onToggle}
            disabled={busy}
            aria-pressed={plugin.enabled}
            aria-label={plugin.enabled ? '停用插件' : '启用插件'}
          >
            <span />
          </button>
        </div>
      </div>

      <p className="plugin-desc">{plugin.description}</p>

      <div className="plugin-grid">
        <div>
          <span>登录 Cookie</span>
          <strong className="mono">{plugin.auth.primaryCookie}</strong>
        </div>
        <div>
          <span>域名权限</span>
          <strong className="mono">{plugin.permissions.network.join(', ')}</strong>
        </div>
        <div>
          <span>读状态</span>
          <strong className="mono">
            {plugin.requests.summary.method} {plugin.requests.summary.path}
          </strong>
        </div>
        <div>
          <span>领取</span>
          <strong className="mono">
            {plugin.requests.claim.method} {plugin.requests.claim.path}
          </strong>
        </div>
      </div>

      <div className="plugin-foot">
        <span className="mono">checksum {plugin.checksum}</span>
        <span>首版只执行内置插件；不加载远程代码。</span>
        {plugin.homepage && (
          <a href={plugin.homepage} target="_blank" rel="noopener noreferrer">
            官网 <IconExternal size={12} />
          </a>
        )}
      </div>
    </article>
  );
}

function DiscoverCard({ item }: { item: DiscoverPlugin }) {
  return (
    <article className="plugin-card plugin-card-discover">
      <div className="card-head">
        <div className="platform-id">
          <span className="platform-icon platform-icon-muted" aria-hidden="true">
            <IconPuzzle size={16} />
          </span>
          <div>
            <h3>{item.name}</h3>
            <p>{item.description}</p>
          </div>
        </div>
        <StatusPill status="skipped" label="待适配" />
      </div>
      <div className="plugin-grid">
        <div>
          <span>扩展方式</span>
          <strong>manifest.json + adapter.json</strong>
        </div>
        <div>
          <span>安全边界</span>
          <strong>首版不执行第三方代码</strong>
        </div>
      </div>
      <p className="plugin-foot">把平台目录放进 /data/plugins 后可被扫描；启用前需要人工审查权限与请求地址。</p>
    </article>
  );
}

export function Plugins({ notify }: Props) {
  const [data, setData] = useState<PluginsData | null>(null);
  const [tab, setTab] = useState<Tab>('builtin');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await get<PluginsData>('/api/plugins'));
    } catch (error) {
      notify(error instanceof Error ? error.message : '加载插件失败', 'error');
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (plugin: PluginDto) => {
    setBusy(true);
    try {
      await post(`/api/plugins/${plugin.id}/enable`, { enabled: !plugin.enabled });
      notify(plugin.enabled ? `已停用 ${plugin.name}` : `已启用 ${plugin.name}`, 'success');
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : '操作失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rescan = async () => {
    setBusy(true);
    try {
      const result = await post<{ count: number }>('/api/plugins/rescan');
      notify(`重新扫描完成：${result.count} 个内置插件`, 'success');
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : '扫描失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const list =
    tab === 'discover' ? (data?.discover ?? []) : tab === 'installed' ? (data?.installed ?? []) : (data?.builtin ?? []);

  return (
    <div className="page">
      <div className="list-head">
        <div className="chips" role="tablist" aria-label="插件分类">
          {(
            [
              ['builtin', '内置'],
              ['installed', '已安装'],
              ['discover', '发现'],
            ] as Array<[Tab, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={`chip ${tab === value ? 'is-active' : ''}`}
              onClick={() => setTab(value)}
            >
              {label}
              <span>{value === 'discover' ? data?.discover.length ?? 0 : data?.installed.length ?? 0}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost" onClick={rescan} disabled={busy}>
          <IconRefresh size={14} />
          重新扫描
        </button>
      </div>

      <div className="plugins-grid">
        {tab === 'discover'
          ? list.map((item) => <DiscoverCard key={(item as DiscoverPlugin).id} item={item as DiscoverPlugin} />)
          : (list as PluginDto[]).map((plugin) => (
              <PluginCard key={plugin.id} plugin={plugin} onToggle={() => void toggle(plugin)} busy={busy} />
            ))}
      </div>

      <div className="notice notice-neutral">
        <IconShield size={16} />
        <div>
          <strong>插件安全边界</strong>
          <p>
            首版只执行随镜像打包的内置插件。第三方目录可以被扫描和展示，但不会执行 TS/JS 钩子，也不提供 zip
            上传或远程市场；复杂平台需要单独做沙箱与权限审计。
          </p>
        </div>
      </div>
    </div>
  );
}

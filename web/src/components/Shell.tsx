import type { ReactNode } from 'react';
import { IconGrid, IconKey, IconList, IconLogout, IconPuzzle, IconSettings, IconCheck } from './icons';

export type View = 'checkin' | 'accounts' | 'runs' | 'plugins' | 'settings';

const NAV_GROUPS: Array<{ label: string; items: Array<{ id: View; label: string; icon: (props: { size?: number }) => ReactNode }> }> = [
  {
    label: '签到',
    items: [
      { id: 'checkin', label: '签到中心', icon: IconGrid },
      { id: 'accounts', label: '账号', icon: IconKey },
    ],
  },
  {
    label: '运行',
    items: [{ id: 'runs', label: '运行记录', icon: IconList }],
  },
  {
    label: '平台',
    items: [{ id: 'plugins', label: '插件与适配', icon: IconPuzzle }],
  },
  {
    label: '系统',
    items: [{ id: 'settings', label: '设置', icon: IconSettings }],
  },
];

const TITLES: Record<View, { title: string; sub: string }> = {
  checkin: { title: '签到中心', sub: '登录、Cookie 维护与每日签到，都在这里。' },
  accounts: { title: '账号', sub: '登录态、加密 Cookie 与失效重登。' },
  runs: { title: '运行记录', sub: '每次请求的 HTTP 证据、时间线与复核结果。' },
  plugins: { title: '插件与适配', sub: '每个平台独立封装；没有适配器的平台只做登录采集。' },
  settings: { title: '设置', sub: '调度、密钥、备份与管理员密码。' },
};

interface Props {
  view: View;
  onView: (view: View) => void;
  version: string;
  todayLabel: string;
  todayTone: 'ok' | 'warn' | 'muted';
  onLogout: () => void;
  children: ReactNode;
}

export function Shell({ view, onView, version, todayLabel, todayTone, onLogout, children }: Props) {
  const meta = TITLES[view];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <IconCheck size={15} strokeWidth={2.4} />
          </span>
          <div className="brand-text">
            <strong>签到执行台</strong>
            <span>CHECK-IN AGENT</span>
          </div>
        </div>

        <nav className="nav" aria-label="主导航">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`nav-item ${view === item.id ? 'is-active' : ''}`}
                    onClick={() => onView(item.id)}
                    aria-current={view === item.id ? 'page' : undefined}
                  >
                    <Icon size={16} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <span className="mono">v{version}</span>
          <span>LOCAL</span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{meta.title}</h1>
            <p>{meta.sub}</p>
          </div>
          <div className="topbar-actions">
            <span className={`pill pill-${todayTone}`}>
              <i />
              {todayLabel}
            </span>
            <button type="button" className="icon-btn" onClick={onLogout} aria-label="退出登录" title="退出登录">
              <IconLogout size={16} />
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

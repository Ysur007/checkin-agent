import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountDto, AuthStatus, CheckinTodayData } from './types';
import { ApiError, get, post } from './api';
import { Shell, type View } from './components/Shell';
import { Toast, type ToastState, type ToastTone } from './components/Toast';
import { AddAccountDialog } from './components/AddAccountDialog';
import { LoginSessionDialog } from './components/LoginSessionDialog';
import { CookieDialog } from './components/CookieDialog';
import { RunDetailModal } from './components/RunDetailModal';
import { Login } from './pages/Login';
import { CheckinCenter } from './pages/CheckinCenter';
import { Accounts } from './pages/Accounts';
import { Runs } from './pages/Runs';
import { Plugins } from './pages/Plugins';
import { Settings } from './pages/Settings';
import { IconCheck } from './components/icons';

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [today, setToday] = useState<CheckinTodayData | null>(null);
  const [view, setView] = useState<View>('checkin');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const [cookieAccount, setCookieAccount] = useState<AccountDto | null>(null);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message, tone });
    toastTimer.current = window.setTimeout(() => setToast(null), 5200);
  }, []);

  const loadToday = useCallback(async () => {
    try {
      const data = await get<CheckinTodayData>('/api/checkins/today');
      setToday(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuth((current) => ({ setupRequired: false, authed: false, version: current?.version ?? '' }));
        setToday(null);
        return;
      }
      notify(error instanceof Error ? error.message : '加载签到状态失败', 'error');
    }
  }, [notify]);

  const loadAuth = useCallback(async () => {
    try {
      const status = await get<AuthStatus>('/api/auth/status');
      setAuth(status);
      if (status.authed) await loadToday();
    } catch (error) {
      notify(error instanceof Error ? error.message : '加载登录状态失败', 'error');
    }
  }, [loadToday, notify]);

  useEffect(() => {
    void loadAuth();
  }, [loadAuth]);

  useEffect(() => {
    if (!auth?.authed) return;
    const timer = window.setInterval(() => {
      void loadToday();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [auth?.authed, loadToday]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const logout = async () => {
    try {
      await post('/api/auth/logout');
    } catch {
      /* ignore */
    }
    setAuth({ setupRequired: false, authed: false, version: auth?.version ?? '' });
    setToday(null);
  };

  const startLogin = async (input: { providerId: string; loginUrl?: string; label: string }) => {
    const result = await post<{ session: { id: string } }>('/api/login-sessions', input);
    setAddOpen(false);
    setLoginSessionId(result.session.id);
  };

  const relogin = async (account: AccountDto) => {
    try {
      const result = await post<{ session: { id: string } }>(`/api/accounts/${account.id}/relogin`, {});
      setLoginSessionId(result.session.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法打开登录窗口', 'error');
    }
  };

  if (!auth) {
    return (
      <div className="boot-screen">
        <span className="brand-mark">
          <IconCheck size={15} strokeWidth={2.4} />
        </span>
        <span>正在加载执行台…</span>
      </div>
    );
  }

  if (!auth.authed) {
    return (
      <>
        <Login
          setupRequired={auth.setupRequired}
          version={auth.version}
          onDone={() => {
            void loadAuth();
          }}
        />
        <Toast toast={toast} />
      </>
    );
  }

  const done = today?.stats.progressDone ?? 0;
  const total = today?.stats.progressTotal ?? 0;
  const accountCount = today?.stats.accounts ?? 0;
  const todayLabel =
    total === 0
      ? accountCount === 0
        ? '未添加账号'
        : '无适配账号'
      : done >= total
        ? `已签 ${done}/${total}`
        : `待签 ${total - done}`;
  const todayTone: 'ok' | 'warn' | 'muted' = total === 0 ? 'muted' : done >= total ? 'ok' : 'warn';

  return (
    <>
      <Shell
        view={view}
        onView={setView}
        version={auth.version}
        todayLabel={todayLabel}
        todayTone={todayTone}
        onLogout={() => void logout()}
      >
        {view === 'checkin' && (
          <CheckinCenter
            data={today}
            onRefresh={loadToday}
            onAdd={() => setAddOpen(true)}
            onRelogin={(account) => void relogin(account)}
            onCookie={setCookieAccount}
            onRun={setRunId}
            notify={notify}
          />
        )}
        {view === 'accounts' && (
          <Accounts
            accounts={today?.accounts ?? []}
            onAdd={() => setAddOpen(true)}
            onRelogin={(account) => void relogin(account)}
            onCookie={setCookieAccount}
            notify={notify}
            onRefresh={loadToday}
          />
        )}
        {view === 'runs' && <Runs notify={notify} onRun={setRunId} />}
        {view === 'plugins' && <Plugins notify={notify} />}
        {view === 'settings' && <Settings notify={notify} />}
      </Shell>

      {addOpen && <AddAccountDialog onClose={() => setAddOpen(false)} onStart={startLogin} />}

      {loginSessionId && (
        <LoginSessionDialog
          sessionId={loginSessionId}
          onClose={() => setLoginSessionId(null)}
          onCaptured={(account, warning) => {
            setLoginSessionId(null);
            notify(
              warning ? `${account.label} 已保存，${warning}` : `${account.label} 登录成功，Cookie 已加密保存`,
              warning ? 'info' : 'success',
            );
            void loadToday();
          }}
        />
      )}

      {cookieAccount && (
        <CookieDialog
          account={cookieAccount}
          onClose={() => setCookieAccount(null)}
          onSaved={() => {
            setCookieAccount(null);
            notify('Cookie 已加密保存', 'success');
            void loadToday();
          }}
          onWarning={(message) => notify(message, 'info')}
        />
      )}

      {runId && <RunDetailModal runId={runId} onClose={() => setRunId(null)} />}

      <Toast toast={toast} />
    </>
  );
}

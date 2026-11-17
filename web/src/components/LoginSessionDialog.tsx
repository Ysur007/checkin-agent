import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountDto, LoginSessionDto } from '../types';
import { ApiError, del, get, post } from '../api';
import { Modal } from './Modal';
import { ProviderIcon } from './ProviderIcon';
import { IconAlert, IconCheck, IconRefresh, IconShield } from './icons';

interface Props {
  sessionId: string;
  onClose: () => void;
  onCaptured: (account: AccountDto, warning: string | null) => void;
}

const VIEW_W = 1200;
const VIEW_H = 760;

const STATUS_TEXT: Record<LoginSessionDto['status'], string> = {
  starting: '正在启动浏览器',
  waiting: '等待登录',
  ready: '已检测到登录',
  captured: '已保存',
  expired: '已超时',
  failed: '打开失败',
  closed: '已关闭',
};

export function LoginSessionDialog({ sessionId, onClose, onCaptured }: Props) {
  const [session, setSession] = useState<LoginSessionDto | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [frameError, setFrameError] = useState('');
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const captured = useRef(false);
  const closed = useRef(false);
  const autoTried = useRef(false);
  const capturingRef = useRef(false);
  const captureRef = useRef<() => Promise<void>>(async () => undefined);

  const loadSession = useCallback(async () => {
    try {
      const result = await get<{ session: LoginSessionDto }>(`/api/login-sessions/${sessionId}`);
      setSession(result.session);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        setError(err.message);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSession();
    const timer = window.setInterval(() => void loadSession(), 2500);
    return () => window.clearInterval(timer);
  }, [loadSession]);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    let timer = 0;

    const tick = async () => {
      try {
        const response = await fetch(`/api/login-sessions/${sessionId}/frame?t=${Date.now()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(payload?.error?.message ?? `画面获取失败（HTTP ${response.status}）`);
        }
        const blob = await response.blob();
        if (!alive) return;
        const next = URL.createObjectURL(blob);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = next;
        setFrame(next);
        setFrameError('');
      } catch (err) {
        if (alive) setFrameError(err instanceof Error ? err.message : '无法获取页面画面');
      } finally {
        if (alive) timer = window.setTimeout(tick, 1300);
      }
    };

    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (!captured.current && !closed.current) {
        void del(`/api/login-sessions/${sessionId}`).catch(() => undefined);
      }
    };
  }, [sessionId]);

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await post(`/api/login-sessions/${sessionId}/actions`, payload);
      window.setTimeout(() => void loadSession(), 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const clickFrame = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (busy || capturing) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * VIEW_W);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * VIEW_H);
    await act({ type: 'click', x, y });
  };

  const sendText = async () => {
    if (!text.trim()) return;
    await act({ type: 'type', text });
    setText('');
  };

  const capture = useCallback(async () => {
    if (capturingRef.current || captured.current) return;
    capturingRef.current = true;
    setCapturing(true);
    setError('');
    try {
      const result = await post<{ account: AccountDto; warning: string | null; verified: boolean }>(
        `/api/login-sessions/${sessionId}/capture`,
      );
      captured.current = true;
      onCaptured(result.account, result.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提取 Cookie 失败');
      void loadSession();
    } finally {
      capturingRef.current = false;
      setCapturing(false);
    }
  }, [loadSession, onCaptured, sessionId]);

  captureRef.current = capture;

  useEffect(() => {
    if (session?.status !== 'ready' || captured.current || autoTried.current) return;
    autoTried.current = true;
    const timer = window.setTimeout(() => void captureRef.current(), 1200);
    return () => window.clearTimeout(timer);
  }, [session?.status]);

  const close = async () => {
    closed.current = true;
    await del(`/api/login-sessions/${sessionId}`).catch(() => undefined);
    onClose();
  };

  const status = session?.status ?? 'starting';
  const terminal = status === 'failed' || status === 'expired' || status === 'closed';
  const ready = status === 'ready';
  const provider = session?.provider;

  return (
    <Modal
      title={provider ? `登录 ${provider.name}` : '登录窗口'}
      subtitle="在下面的浏览器里完成登录（可以点击、输入、滚动）。检测到登录态后会自动尝试保存；失败时窗口会保留，可以手动点「提取 Cookie」。"
      onClose={() => void close()}
      width={1080}
      footer={
        <>
          <span className="login-status">
            <span className={`pill ${ready ? 'pill-ok' : terminal ? 'pill-bad' : 'pill-warn'}`}>
              <i />
              {STATUS_TEXT[status]}
            </span>
            {session && (
              <span className="muted small">
                {Math.max(0, Math.round((Date.parse(session.expiresAt) - Date.now()) / 60000))} 分钟后关闭
              </span>
            )}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => void close()}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void capture()}
            disabled={capturing || terminal}
          >
            {capturing ? '正在校验并保存…' : '我已登录，提取 Cookie'}
          </button>
        </>
      }
    >
      <div className="login-layout">
        <div className="browser">
          <div className="browser-bar">
            <span className="browser-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="browser-url" title={session?.currentUrl ?? ''}>
              {session?.currentUrl ?? '正在打开…'}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void act({ type: 'reload' })}
              disabled={busy || terminal}
              aria-label="刷新页面"
              title="刷新页面"
            >
              <IconRefresh size={14} />
            </button>
          </div>
          <div className="browser-view">
            {frame ? (
              <img
                src={frame}
                alt="登录页面实时画面"
                onClick={(event) => void clickFrame(event)}
                draggable={false}
              />
            ) : (
              <div className="browser-placeholder">
                {frameError ? (
                  <>
                    <IconAlert size={18} />
                    <span>{frameError}</span>
                  </>
                ) : (
                  <span>正在获取页面画面…</span>
                )}
              </div>
            )}
          </div>
        </div>

        <aside className="login-side">
          <div className="side-block">
            <h4>登录状态</h4>
            <div className="login-detected">
              <span className={`dot ${ready ? 'is-ok' : ''}`} />
              <strong>{ready ? '已捕获到登录 Cookie' : '还没有检测到登录'}</strong>
            </div>
            <p className="muted small">
              {session?.pageTitle || '页面标题会显示在这里'}
            </p>
            <div className="cookie-name-list">
              {session?.cookieNames.length ? (
                session.cookieNames.map((name) => (
                  <code key={name}>{name}</code>
                ))
              ) : (
                <span className="muted small">尚未捕获任何 Cookie 字段</span>
              )}
            </div>
          </div>

          <div className="side-block">
            <h4>输入到页面</h4>
            <div className="send-row">
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void sendText();
                  }
                }}
                placeholder="账号 / 验证码…"
                disabled={busy || terminal}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void sendText()} disabled={busy || terminal}>
                发送
              </button>
            </div>
            <div className="key-row">
              <button type="button" className="key" onClick={() => void act({ type: 'press', key: 'Enter' })} disabled={busy || terminal}>
                Enter
              </button>
              <button type="button" className="key" onClick={() => void act({ type: 'press', key: 'Tab' })} disabled={busy || terminal}>
                Tab
              </button>
              <button type="button" className="key" onClick={() => void act({ type: 'press', key: 'Backspace' })} disabled={busy || terminal}>
                退格
              </button>
              <button type="button" className="key" onClick={() => void act({ type: 'scroll', dy: 420 })} disabled={busy || terminal}>
                向下滚
              </button>
            </div>
            <p className="muted small">先在页面里点中输入框，再发送文字。验证码请自己在窗口里输入。</p>
          </div>

          <div className="side-block side-security">
            <IconShield size={15} />
            <p>
              登录窗口只允许当前管理员会话操作；Cookie 加密后写库，接口与日志只保留字段名与指纹。遇到验证码或二次验证时在窗口里自行完成，
              服务不会绕过。
            </p>
          </div>

          {error && <p className="form-error">{error}</p>}
          {ready && (
            <p className="side-ready">
              <IconCheck size={14} /> 登录完成，可以提取了
            </p>
          )}
        </aside>
      </div>
    </Modal>
  );
}

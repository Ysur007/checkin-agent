import { useState, type FormEvent } from 'react';
import { post } from '../api';
import { IconCheck, IconShield } from '../components/icons';

interface Props {
  setupRequired: boolean;
  version: string;
  onDone: () => void;
}

export function Login({ setupRequired, version, onDone }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (setupRequired && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      await post(setupRequired ? '/api/auth/setup' : '/api/auth/login', { password });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <IconCheck size={16} strokeWidth={2.4} />
          </span>
          <span>签到执行台</span>
        </div>

        <h1>{setupRequired ? '设置管理密码' : '登录控制台'}</h1>
        <p className="login-sub">
          {setupRequired
            ? '首次使用，先设置一个管理密码。之后所有 Cookie 和运行记录都只保存在这台机器上。'
            : '输入管理密码，查看今日领取状态与运行记录。'}
        </p>

        <form onSubmit={submit} className="login-form">
          <label className="field">
            <span className="field-label">管理密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 8 位"
              autoFocus
              autoComplete="current-password"
            />
          </label>

          {setupRequired && (
            <label className="field">
              <span className="field-label">确认密码</span>
              <input
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder="再输入一次"
                autoComplete="new-password"
              />
            </label>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? '处理中…' : setupRequired ? '设置并进入' : '登录'}
          </button>
        </form>

        <div className="login-note">
          <IconShield size={14} />
          <span>只用于你本人有权操作的账号；Cookie 加密保存，日志脱敏，不提供绕过验证码的能力。</span>
        </div>
        <div className="login-foot mono">v{version} · LOCAL</div>
      </div>
    </div>
  );
}

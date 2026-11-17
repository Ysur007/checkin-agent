import { useState } from 'react';
import type { AccountDto } from '../types';
import { post } from '../api';
import { Modal } from './Modal';
import { IconExternal, IconKey } from './icons';

interface Props {
  account: AccountDto;
  onClose: () => void;
  onSaved: () => void;
  onWarning?: (message: string) => void;
}

export function CookieDialog({ account, onClose, onSaved, onWarning }: Props) {
  const [cookie, setCookie] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const primary = account.provider.primaryCookie;

  const save = async () => {
    setError('');
    if (!cookie.trim()) {
      setError('请粘贴完整的 Cookie 请求头');
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ warning: string | null }>(`/api/accounts/${account.id}/cookie`, { cookie });
      if (result.warning) onWarning?.(result.warning);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`手动更新 ${account.provider.name} Cookie`}
      subtitle={account.provider.checkIn ? '服务会先做一次只读校验；通过后才加密保存。' : '该平台没有签到适配器，只做格式检查后加密保存。'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? '正在验证…' : '加密保存'}
          </button>
        </>
      }
    >
      <div className="cookie-hint">
        <IconKey size={16} />
        <div>
          <strong>只接受完整 Cookie 请求头</strong>
          <p>
            在浏览器登录后打开 DevTools → Network，复制任意请求的 <code>Cookie</code> 值。
            {primary ? (
              <>
                {' '}必须包含 <code>{primary}</code>。
              </>
            ) : (
              ' 该平台没有已知的主 Cookie，保存后请在账号页点「检测登录态」确认。'
            )}
          </p>
          {account.loginUrl && (
            <a href={account.loginUrl} target="_blank" rel="noopener noreferrer">
              打开 {account.provider.name} <IconExternal size={12} />
            </a>
          )}
        </div>
      </div>

      <label className="field">
        <span className="field-label">Cookie</span>
        <textarea
          className="cookie-textarea"
          value={cookie}
          onChange={(event) => setCookie(event.target.value)}
          placeholder={primary ? `${primary}=...; 其他 cookie=...` : 'name=value; other=value'}
          rows={5}
          spellCheck={false}
          autoFocus
        />
      </label>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <p className="security-note">
        Cookie 会使用 AES-256-GCM 加密后写入本机 SQLite；日志只保留字段名与指纹。请不要把 Cookie 发到聊天、截图或 Issue 里。
      </p>

      {account.cookie.configured && (
        <div className="cookie-current">
          <span>当前 Cookie</span>
          <span className="mono">
            {account.cookie.fingerprint} · {account.cookie.length} bytes · {account.cookie.fields.join(', ')}
          </span>
        </div>
      )}
    </Modal>
  );
}

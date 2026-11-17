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
  const loginUrl = account.loginUrl ?? '';

  const openLogin = () => {
    if (!loginUrl) {
      setError('这个平台还没有登录页地址，请先在账号设置里补充');
      return;
    }
    window.open(loginUrl, '_blank', 'noopener,noreferrer');
  };

  const save = async () => {
    setError('');
    if (!cookie.trim()) {
      setError('请先粘贴 Cookie 请求头或整段 cURL');
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
      title={`登录 ${account.provider.name}`}
      subtitle="在你自己的浏览器里登录，然后把 Cookie 粘贴回来。服务端不运行浏览器，也不保存明文到日志。"
      onClose={onClose}
      width={600}
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
      <button type="button" className="login-cta" onClick={openLogin} disabled={!loginUrl}>
        <span>
          打开 {account.provider.name} 登录页
          <small>{loginUrl || '未配置登录页地址'}</small>
        </span>
        <IconExternal size={15} />
      </button>

      <ol className="login-steps">
        <li>在新标签里登录 {account.provider.name}，登录成功后先别关那个标签。</li>
        <li>
          按 <kbd>F12</kbd> 打开开发者工具 → <b>Network</b> → 刷新页面 → 点任意一个请求。
        </li>
        <li>
          在 <b>Request Headers</b> 里找到 <code>cookie</code> 复制它的值；或者右键该请求 →{' '}
          <b>Copy → Copy as cURL</b>，整段粘进来也行。
        </li>
      </ol>

      <label className="field">
        <span className="field-label">Cookie 或 cURL</span>
        <textarea
          className="cookie-textarea"
          value={cookie}
          onChange={(event) => setCookie(event.target.value)}
          placeholder={
            primary
              ? `Cookie: ${primary}=...; 其他字段=...\n或整段 curl 'https://...' -H 'cookie: ...'`
              : '粘贴 Cookie 请求头，或整段 Copy as cURL 的内容'
          }
          rows={6}
          spellCheck={false}
          autoFocus
        />
        <span className="field-hint">
          两种格式都能识别：服务端会自己挑出 cookie 那一行，再按平台要求校验字段。
        </span>
      </label>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <p className="security-note">
        保存前会先用这份 Cookie 调一次平台只读接口；通过才标记「已验证」，失败会告诉你具体原因。
        Cookie 用 AES-256-GCM 加密写入本机 SQLite，日志只留字段名与指纹。
      </p>

      {account.cookie.configured && (
        <div className="cookie-current">
          <span>当前</span>
          <span className="mono">
            {account.cookie.fingerprint} · {account.cookie.length} bytes · {account.cookie.fields.join(', ')}
            {account.cookie.verified ? ' · 已验证' : ' · 未验证'}
          </span>
        </div>
      )}

      <p className="cookie-hint-foot">
        <IconKey size={13} />
        想要完全自动也行：加一个浏览器扩展替你读 Cookie，但那要装东西，默认不折腾。
      </p>
    </Modal>
  );
}

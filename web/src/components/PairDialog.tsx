import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountDto } from '../types';
import { get, post } from '../api';
import { Modal } from './Modal';
import { IconCheck, IconCopy, IconTerminal } from './icons';

interface Props {
  account: AccountDto;
  onClose: () => void;
  onDone: () => void;
}

interface PairInfo {
  code: string;
  expiresAt: string;
  accountLabel: string;
}

function secondsLeft(iso: string): number {
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
}

export function PairDialog({ account, onClose, onDone }: Props) {
  const [info, setInfo] = useState<PairInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(0);
  const baseline = useRef(account.cookie.updatedAt ?? '');
  const done = useRef(false);

  const create = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await post<PairInfo>(`/api/accounts/${account.id}/pair`, {});
      setInfo(result);
      setLeft(secondsLeft(result.expiresAt));
      baseline.current = account.cookie.updatedAt ?? '';
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成配对码失败');
    } finally {
      setBusy(false);
    }
  }, [account.id, account.cookie.updatedAt]);

  useEffect(() => {
    void create();
  }, [create]);

  // 倒计时
  useEffect(() => {
    if (!info) return;
    const timer = window.setInterval(() => setLeft(secondsLeft(info.expiresAt)), 1000);
    return () => window.clearInterval(timer);
  }, [info]);

  // 等本机助手回传：检测到 cookie.updatedAt 变化就收工
  useEffect(() => {
    if (!info) return;
    const timer = window.setInterval(() => {
      void get<{ accounts: AccountDto[] }>('/api/accounts')
        .then((result) => {
          const fresh = result.accounts.find((item) => item.id === account.id);
          if (!fresh || done.current) return;
          if ((fresh.cookie.updatedAt ?? '') !== baseline.current) {
            done.current = true;
            onDone();
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [account.id, info, onDone]);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const command = info ? `npm run login:local -- --host ${origin} --code ${info.code}` : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('复制失败，请手动选中命令复制');
    }
  };

  return (
    <Modal
      title="本机浏览器登录"
      subtitle="用你自己电脑上的浏览器登录，登录助手把 Cookie 加密回传。服务端不运行浏览器，也不保存明文。"
      onClose={onClose}
      width={600}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy}>
            {busy ? '生成中…' : info ? '换一个配对码' : '生成配对码'}
          </button>
        </>
      }
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {info && (
        <div className="pair-body">
          <div className="pair-code-row">
            <span className="pair-code">{info.code}</span>
            <span className={`pair-ttl${left <= 60 ? ' is-low' : ''}`}>
              {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后失效` : '已失效'}
            </span>
          </div>

          <div className="pair-steps">
            <p>
              <b>1</b> 在项目目录打开终端，粘贴这条命令：
            </p>
            <div className="pair-command">
              <code>{command || '—'}</code>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <p>
              <b>2</b> 助手会打开你电脑上的 Edge / Chrome，你自己完成登录（验证码、二次验证都在本机）。
            </p>
            <p>
              <b>3</b> 检测到 <code>{account.provider.primaryCookie ?? '登录 Cookie'}</code>{' '}
              后自动回传，这几行提示会消失。
            </p>
          </div>

          <p className="pair-note">
            <IconTerminal size={14} />
            配对码只能用一次、{Math.round((Date.parse(info.expiresAt) - Date.now()) / 60000)} 分钟内有效；
            本机首次使用需要在该目录执行一次 <code>npm install</code>。
          </p>
        </div>
      )}
    </Modal>
  );
}

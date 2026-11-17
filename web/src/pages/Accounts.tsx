import { useState } from 'react';
import type { AccountDto } from '../types';
import { del, patch, post } from '../api';
import { formatDateTime, timeAgo } from '../format';
import { ProviderIcon } from '../components/ProviderIcon';
import { IconAlert, IconCheck, IconRefresh, IconTrash } from '../components/icons';
import type { ToastTone } from '../components/Toast';

interface Props {
  accounts: AccountDto[];
  onAdd: () => void;
  onRelogin: (account: AccountDto) => void;
  onCookie: (account: AccountDto) => void;
  notify: (message: string, tone?: ToastTone) => void;
  onRefresh: () => Promise<void>;
}

export function Accounts({ accounts, onAdd, onRelogin, onCookie, notify, onRefresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  const verify = async (account: AccountDto) => {
    setBusy(account.id);
    try {
      const result = await post<{ ok: boolean; message?: string; code?: string; balance?: number | null; claimedToday?: boolean | null }>(
        `/api/accounts/${account.id}/verify`,
      );
      notify(result.ok ? result.message ?? '登录态有效' : result.message ?? '登录态不可用', result.ok ? 'success' : 'error');
      await onRefresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '检测失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (account: AccountDto) => {
    setBusy(account.id);
    try {
      await patch(`/api/accounts/${account.id}`, { enabled: !account.enabled });
      await onRefresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '操作失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (account: AccountDto) => {
    if (!window.confirm(`删除账号「${account.label}」？Cookie、签到记录和运行记录会一起删除。`)) return;
    setBusy(account.id);
    try {
      await del(`/api/accounts/${account.id}`);
      notify('账号已删除', 'success');
      await onRefresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '删除失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>账号与登录态</h2>
          <p>每个账号的 Cookie 都单独加密保存；失效后复用浏览器配置重新登录，通常不需要再输密码。</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onAdd}>
          添加账号
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="card empty-card">
          <h2>还没有账号</h2>
          <p>从平台列表里选一个，或填写任意平台的登录页地址。</p>
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            添加账号
          </button>
        </div>
      ) : (
        <div className="account-grid">
          {accounts.map((account) => {
            const broken = account.cookie.expired || account.status === 'needs_reauth';
            const working = busy === account.id;
            const healthTone =
              account.health.score >= 80 ? 'ok' : account.health.score >= 40 ? 'warn' : 'bad';
            return (
              <article className={`account-card ${account.enabled ? '' : 'is-off'}`} key={account.id}>
                <header className="account-card-head">
                  <ProviderIcon provider={account.provider} size={34} />
                  <div className="account-card-title">
                    <strong>{account.label}</strong>
                    <span className="muted small">{account.provider.name}</span>
                  </div>
                  <span className={`pill pill-${broken ? 'bad' : account.cookie.configured ? 'ok' : 'muted'}`}>
                    <i />
                    {broken ? '登录失效' : account.cookie.configured ? '已登录' : '未登录'}
                  </span>
                </header>

                <dl className="account-facts">
                  <div>
                    <dt>Cookie</dt>
                    <dd>
                      {account.cookie.configured
                        ? `${account.cookie.fields.length} 个字段 · ${account.cookie.verified ? '平台校验通过' : '未校验'}`
                        : '尚未捕获'}
                    </dd>
                  </div>
                  <div>
                    <dt>健康度</dt>
                    <dd className={`health-${healthTone}`} title={account.health.reasons.join('；') || '状态正常'}>
                      {account.health.score} · {account.health.label}
                    </dd>
                  </div>
                  <div>
                    <dt>会话有效期</dt>
                    <dd>
                      {account.cookie.expiresAt ? formatDateTime(account.cookie.expiresAt) : '会话级'}
                      <span className="muted"> · {timeAgo(account.cookie.updatedAt)}更新</span>
                    </dd>
                  </div>
                  <div>
                    <dt>签到</dt>
                    <dd>
                      {account.provider.checkIn
                        ? account.today
                          ? `今日已签${account.today.credits ? ` +${account.today.credits}` : ''}`
                          : account.cookie.configured
                            ? '等待执行'
                            : '待登录'
                        : '该平台待适配'}
                    </dd>
                  </div>
                </dl>

                {account.cookie.configured && account.cookie.fields.length > 0 && (
                  <div className="cookie-tags">
                    {account.cookie.fields.slice(0, 6).map((field) => (
                      <code key={field}>{field}</code>
                    ))}
                    {account.cookie.fields.length > 6 && <span className="muted small">+{account.cookie.fields.length - 6}</span>}
                  </div>
                )}

                {broken && (
                  <p className="account-warning">
                    <IconAlert size={13} /> 登录态已失效，定时任务会跳过这个账号，直到重新登录。
                  </p>
                )}

                <footer className="account-actions">
                  {broken || !account.cookie.configured ? (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => onRelogin(account)}>
                      重新登录
                    </button>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void verify(account)} disabled={working}>
                      <IconRefresh size={12} /> {working ? '检测中…' : '检测登录态'}
                    </button>
                  )}
                  {!broken && account.cookie.configured && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRelogin(account)}>
                      重新登录
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCookie(account)}>
                    手动 Cookie
                  </button>
                  <button type="button" className={`toggle ${account.enabled ? 'is-on' : ''}`} onClick={() => void toggle(account)} disabled={working} aria-pressed={account.enabled} aria-label={account.enabled ? '暂停账号' : '启用账号'}>
                    <span />
                  </button>
                  <button type="button" className="icon-btn danger-icon" onClick={() => void remove(account)} disabled={working} aria-label="删除账号" title="删除账号">
                    <IconTrash size={14} />
                  </button>
                </footer>

                {account.today && (
                  <span className="account-today">
                    <IconCheck size={12} /> 今天 {timeAgo(account.today.at)}签过
                  </span>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

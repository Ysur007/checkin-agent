import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountDto, CheckinRecordsData, CheckinTodayData } from '../types';
import { get, patch, post, waitForRun } from '../api';
import { formatNumber, timeAgo } from '../format';
import { ProviderIcon } from '../components/ProviderIcon';
import { IconAlert, IconCheck, IconClock, IconPlay, IconRefresh } from '../components/icons';
import type { ToastTone } from '../components/Toast';

interface Props {
  data: CheckinTodayData | null;
  onRefresh: () => Promise<void>;
  onAdd: () => void;
  onRelogin: (account: AccountDto) => void;
  onCookie: (account: AccountDto) => void;
  onRun: (runId: string) => void;
  notify: (message: string, tone?: ToastTone) => void;
}

type Tab = 'daily' | 'scheduled' | 'records';

interface Group {
  provider: AccountDto['provider'];
  accounts: AccountDto[];
}

function accountState(account: AccountDto): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (account.cookie.expired || account.status === 'needs_reauth') return { label: '登录失效', tone: 'bad' };
  if (!account.cookie.configured) return { label: '未登录', tone: 'muted' };
  if (account.today) return { label: '已签到', tone: 'ok' };
  if (!account.provider.checkIn) return { label: '待适配', tone: 'muted' };
  if (!account.enabled) return { label: '已停用', tone: 'muted' };
  return { label: '可签到', tone: 'warn' };
}

function groupState(accounts: AccountDto[]): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  const withCookie = accounts.filter((account) => account.cookie.configured);
  const checked = withCookie.filter((account) => account.today);
  const broken = withCookie.filter((account) => account.cookie.expired || account.status === 'needs_reauth');
  const adapted = withCookie.filter((account) => account.provider.checkIn);

  if (withCookie.length === 0) return { label: '未登录', tone: 'muted' };
  if (broken.length === withCookie.length) return { label: '登录失效', tone: 'bad' };
  if (adapted.length === 0) return { label: '待适配', tone: 'muted' };
  if (checked.length === adapted.length && adapted.length > 0) return { label: '已签', tone: 'ok' };
  if (checked.length > 0) return { label: '部分', tone: 'warn' };
  return { label: '可签到', tone: 'warn' };
}

export function CheckinCenter({ data, onRefresh, onAdd, onRelogin, onCookie, onRun, notify }: Props) {
  const [tab, setTab] = useState<Tab>('daily');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [records, setRecords] = useState<CheckinRecordsData | null>(null);
  const [recordsError, setRecordsError] = useState('');

  const loadRecords = useCallback(async () => {
    try {
      setRecords(await get<CheckinRecordsData>('/api/checkins/records?days=30'));
      setRecordsError('');
    } catch (error) {
      setRecordsError(error instanceof Error ? error.message : '加载签到记录失败');
    }
  }, []);

  useEffect(() => {
    if (tab === 'records') void loadRecords();
  }, [tab, loadRecords]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const account of data?.accounts ?? []) {
      const existing = map.get(account.provider.id);
      if (existing) existing.accounts.push(account);
      else map.set(account.provider.id, { provider: account.provider, accounts: [account] });
    }
    return [...map.values()].sort(
      (a, b) =>
        Number(b.provider.checkIn) - Number(a.provider.checkIn) ||
        b.accounts.length - a.accounts.length ||
        a.provider.name.localeCompare(b.provider.name),
    );
  }, [data]);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const checkOne = async (account: AccountDto) => {
    setWorking(account.id);
    try {
      const result = await post<{ runId: string }>(`/api/checkins/${account.id}`);
      notify('已发起签到，正在等待平台结果…', 'info');
      const detail = await waitForRun(result.runId, 120_000);
      const run = detail.run;
      const ok = run.status === 'succeeded' || run.status === 'already_claimed';
      notify(
        ok
          ? `${account.label}：${run.status === 'already_claimed' ? '今天已经签过' : `签到成功${run.creditsIssued ? ` +${formatNumber(run.creditsIssued)}` : ''}`}`
          : `${account.label}：${run.errorMessage ?? run.status}`,
        ok ? 'success' : 'error',
      );
      await onRefresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '签到失败', 'error');
    } finally {
      setWorking(null);
    }
  };

  const checkAll = async () => {
    setBulk(true);
    try {
      const result = await post<{ started: Array<{ accountId: string; runId?: string }>; skipped: Array<{ reason: string }> }>(
        '/api/checkins/bulk',
        {},
      );
      if (result.started.length === 0) {
        notify(result.skipped[0]?.reason ?? '没有可签到的账号', 'info');
      } else {
        notify(`已开始 ${result.started.length} 个账号的签到，结果会自动刷新`, 'success');
      }
      await onRefresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '批量签到失败', 'error');
    } finally {
      setBulk(false);
    }
  };

  if (!data) {
    return <div className="card empty-card">正在加载签到状态…</div>;
  }

  const { stats } = data;
  const percent = stats.progressTotal > 0 ? Math.round((stats.progressDone / stats.progressTotal) * 100) : 0;

  return (
    <div className="page">
      <div className="center-head">
        <div className="seg-tabs" role="tablist" aria-label="签到视图">
          <button type="button" role="tab" aria-selected={tab === 'daily'} className={`seg-tab ${tab === 'daily' ? 'is-active' : ''}`} onClick={() => setTab('daily')}>
            签到中心
          </button>
          <button type="button" role="tab" aria-selected={tab === 'scheduled'} className={`seg-tab ${tab === 'scheduled' ? 'is-active' : ''}`} onClick={() => setTab('scheduled')}>
            定时签到
          </button>
          <button type="button" role="tab" aria-selected={tab === 'records'} className={`seg-tab ${tab === 'records' ? 'is-active' : ''}`} onClick={() => setTab('records')}>
            签到记录
          </button>
        </div>
        <div className="center-head-actions">
          <span className="muted small">{data.today} · {data.timezone}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onRefresh()}>
            <IconRefresh size={13} /> 刷新
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span>今日签到进度</span>
          <strong>
            {stats.progressDone} <em className="stat-den">/ {stats.progressTotal}</em>
          </strong>
          <div className="stat-bar" aria-hidden="true">
            <i style={{ width: `${percent}%` }} />
          </div>
          <p>
            {stats.progressTotal === 0
              ? stats.accounts === 0
                ? '还没有可签到的账号'
                : `${stats.accounts} 个账号仅登录，签到待适配`
              : percent >= 100
                ? '可签到账号均已签到'
                : `还有 ${stats.progressTotal - stats.progressDone} 个可签账号待签到`}
          </p>
        </div>
        <div className="stat-card">
          <span>定时签到</span>
          <strong>
            {stats.scheduledEnabled} <em className="stat-den">/ {stats.scheduledTotal} 启用</em>
          </strong>
          <p>下次 {data.nextRun ? `${data.nextRun.date} ${data.nextRun.time}` : '—'}；按账号时区串行执行</p>
        </div>
        <div className="stat-card">
          <span>待处理</span>
          <strong className={stats.attention === 0 ? 'text-lg' : ''}>{stats.attention === 0 ? '无' : stats.attention}</strong>
          <p>{stats.attention === 0 ? '没有登录失效的账号' : '个账号登录失效，需要重新登录'}</p>
        </div>
        <div className="stat-card">
          <span>累计签到记录</span>
          <strong>{formatNumber(stats.records)}</strong>
          <p>每账号每天一条；近 30 天 +{formatNumber(stats.credits30)} 积分</p>
        </div>
      </div>

      {tab === 'daily' && (
        <section className="card roster">
          <div className="roster-head">
            <div>
              <h3>每日签到</h3>
              <p>按平台分组；展开可以单独签到、重新登录或查看账号状态。</p>
            </div>
            <div className="roster-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onAdd}>
                添加账号
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void checkAll()} disabled={bulk || stats.progressDone >= stats.progressTotal}>
                <IconPlay size={12} /> {bulk ? '正在发起…' : '立即全部签到'}
              </button>
            </div>
          </div>

          {groups.length === 0 ? (
            <div className="empty-card">
              <h2>还没有添加账号</h2>
              <p>添加账号后会在服务端浏览器里完成登录，自动捕获 Cookie，再按平台执行签到。</p>
              <button type="button" className="btn btn-primary" onClick={onAdd}>
                添加第一个账号
              </button>
            </div>
          ) : (
            <div className="roster-list">
              {groups.map((group) => {
                const state = groupState(group.accounts);
                const open = expanded.has(group.provider.id);
                const count = group.accounts.length;
                const adapted = group.accounts.filter((account) => account.provider.checkIn && account.cookie.configured);
                const done = adapted.filter((account) => account.today).length;
                return (
                  <div className={`roster-group ${open ? 'is-open' : ''}`} key={group.provider.id}>
                    <button type="button" className="roster-row" onClick={() => toggle(group.provider.id)} aria-expanded={open}>
                      <ProviderIcon provider={group.provider} size={32} />
                      <span className="roster-name">
                        <strong>{group.provider.name}</strong>
                        <small>{group.provider.description}</small>
                      </span>
                      <span className="roster-meta">
                        <span className="muted small">{count} 个账号{done > 0 ? ` · ${done} 已签` : ''}</span>
                        <span className={`pill pill-${state.tone}`}>
                          <i />
                          {state.label}
                        </span>
                        <span className={`roster-chevron ${open ? 'is-open' : ''}`} aria-hidden="true">
                          ›
                        </span>
                      </span>
                    </button>

                    {open && (
                      <div className="roster-body">
                        {group.accounts.map((account) => {
                          const accountInfo = accountState(account);
                          const isWorking = working === account.id;
                          return (
                            <div className="account-line" key={account.id}>
                              <span className="account-line-main">
                                <strong>{account.label}</strong>
                                <span className="muted small">
                                  {account.authSource === 'browser' ? '浏览器登录' : '手动 Cookie'}
                                  {account.cookie.updatedAt ? ` · ${timeAgo(account.cookie.updatedAt)}更新` : ''}
                                  {account.balance !== null ? ` · 余额 ${formatNumber(account.balance)}` : ''}
                                </span>
                              </span>
                              <span className={`pill pill-${accountInfo.tone}`}>
                                <i />
                                {accountInfo.label}
                              </span>
                              <span className="account-line-actions">
                                {account.today?.runId && (
                                  <button type="button" className="link-btn" onClick={() => onRun(account.today!.runId!)}>
                                    查看记录
                                  </button>
                                )}
                                {account.cookie.configured && (account.cookie.expired || account.status === 'needs_reauth') && (
                                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRelogin(account)}>
                                    重新登录
                                  </button>
                                )}
                                {!account.cookie.configured && (
                                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRelogin(account)}>
                                    去登录
                                  </button>
                                )}
                                {account.provider.checkIn && account.cookie.configured && !account.cookie.expired && (
                                  <button
                                    type="button"
                                    className={`btn btn-sm ${account.today ? 'btn-ghost' : 'btn-primary'}`}
                                    disabled={isWorking || Boolean(account.today)}
                                    onClick={() => void checkOne(account)}
                                  >
                                    {isWorking ? '签到中…' : account.today ? '今日已签' : '签到'}
                                  </button>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              <button type="button" className="roster-add" onClick={onAdd}>
                <span className="roster-add-icon">+</span>
                添加账号 / 平台
              </button>
            </div>
          )}
        </section>
      )}

      {tab === 'scheduled' && (
        <section className="card roster">
          <div className="roster-head">
            <div>
              <h3>定时签到</h3>
              <p>每个账号可以单独设置时间；默认跟随全局调度，失败或登录失效时不会重复请求。</p>
            </div>
          </div>
          <div className="schedule-list">
            {data.accounts.length === 0 && <div className="empty-card"><p>还没有账号。</p></div>}
            {data.accounts.map((account) => (
              <ScheduleRow key={account.id} account={account} notify={notify} onRefresh={onRefresh} onRelogin={onRelogin} />
            ))}
          </div>
        </section>
      )}

      {tab === 'records' && (
        <section className="card roster">
          <div className="roster-head">
            <div>
              <h3>签到记录</h3>
              <p>
                近 30 天共 {records?.summary.records ?? 0} 条，累计 {formatNumber(records?.summary.credits ?? 0)} 积分；
                只有平台确认或复核通过才会写入这里。
              </p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadRecords()}>
              <IconRefresh size={13} /> 刷新
            </button>
          </div>

          {recordsError && <p className="form-error">{recordsError}</p>}
          {records && records.groups.length === 0 && (
            <div className="empty-card">
              <p>还没有签到记录。完成一次真实签到后，这里会出现当天明细。</p>
            </div>
          )}
          {records?.groups.map((group) => (
            <div className="record-day" key={group.date}>
              <div className="record-day-head">
                <strong>{group.date}</strong>
                <span className="muted small">{group.items.length} 条 · +{formatNumber(group.credits)}</span>
              </div>
              {group.items.map((item) => (
                <div className="record-line" key={`${item.accountId}-${item.runId ?? item.at}`}>
                  <ProviderIcon provider={item.provider} size={22} />
                  <span className="record-name">{item.label}</span>
                  {item.provider.name !== item.label && <span className="muted small">{item.provider.name}</span>}
                  <span className={`pill pill-${item.verified ? 'ok' : 'warn'}`}>
                    <i />
                    {item.verified ? '已复核' : '未复核'}
                  </span>
                  <span className="record-credits">{item.credits ? `+${formatNumber(item.credits)}` : '—'}</span>
                  {item.runId && (
                    <button type="button" className="link-btn" onClick={() => onRun(item.runId!)}>
                      详情
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

      {stats.attention > 0 && tab === 'daily' && (
        <p className="attention-note">
          <IconAlert size={14} /> 有 {stats.attention} 个账号登录失效。展开对应平台，点「重新登录」会复用之前的浏览器配置，多数平台可以免密恢复。
        </p>
      )}
    </div>
  );
}

function ScheduleRow({
  account,
  notify,
  onRefresh,
  onRelogin,
}: {
  account: AccountDto;
  notify: (message: string, tone?: ToastTone) => void;
  onRefresh: () => Promise<void>;
  onRelogin: (account: AccountDto) => void;
}) {
  const [time, setTime] = useState(account.scheduleTime ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTime(account.scheduleTime ?? '');
  }, [account.scheduleTime]);

  const save = async () => {
    setBusy(true);
    try {
      await patch(`/api/accounts/${account.id}`, { scheduleTime: time.trim() ? time.trim() : null });
      notify('签到时间已保存', 'success');
      await onRefresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      await patch(`/api/accounts/${account.id}`, { enabled: !account.enabled });
      notify(account.enabled ? '已暂停这个账号的定时签到' : '已恢复定时签到', 'success');
      await onRefresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : '操作失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schedule-row">
      <ProviderIcon provider={account.provider} size={28} />
      <div className="schedule-name">
        <strong>{account.label}</strong>
        <span className="muted small">{account.provider.name}</span>
      </div>
      <span className={`pill pill-${account.cookie.expired || account.status === 'needs_reauth' ? 'bad' : account.cookie.configured ? 'ok' : 'muted'}`}>
        <i />
        {account.cookie.expired || account.status === 'needs_reauth' ? '登录失效' : account.cookie.configured ? '登录正常' : '未登录'}
      </span>
      <label className="time-input">
        <IconClock size={13} />
        <input
          value={time}
          placeholder="跟随全局"
          onChange={(event) => setTime(event.target.value)}
          onBlur={() => void save()}
          maxLength={5}
          inputMode="numeric"
          aria-label={`${account.label} 的签到时间`}
        />
      </label>
      <button type="button" className={`toggle ${account.enabled ? 'is-on' : ''}`} onClick={() => void toggle()} disabled={busy} aria-pressed={account.enabled} aria-label={account.enabled ? '暂停定时签到' : '恢复定时签到'}>
        <span />
      </button>
      <span className="schedule-tail">
        {(account.cookie.expired || account.status === 'needs_reauth') && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRelogin(account)}>
            重新登录
          </button>
        )}
        {account.today && (
          <span className="pill pill-ok">
            <i />
            <IconCheck size={11} /> 今日已签
          </span>
        )}
      </span>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { SettingsData } from '../types';
import { del, get, patch, post } from '../api';
import type { ToastTone } from '../components/Toast';
import { IconClock, IconDatabase, IconKey, IconShield } from '../components/icons';

interface Props {
  notify: (message: string, tone?: ToastTone) => void;
}

export function Settings({ notify }: Props) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [time, setTime] = useState('08:10');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [jitter, setJitter] = useState('240');
  const [spread, setSpread] = useState('30');
  const [windowStart, setWindowStart] = useState('08:00');
  const [windowEnd, setWindowEnd] = useState('23:59');
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [tokens, setTokens] = useState<
    Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>
  >([]);
  const [freshToken, setFreshToken] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);

  useEffect(() => {
    get<SettingsData>('/api/settings')
      .then((settings) => {
        setData(settings);
        setTime(settings.schedule.time);
        setTimezone(settings.schedule.timezone);
        setJitter(String(settings.schedule.jitterSeconds));
        setSpread(String(Math.round((settings.schedule.spreadSeconds ?? 1800) / 60)));
        setWindowStart(settings.schedule.windowStart);
        setWindowEnd(settings.schedule.windowEnd);
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : '加载设置失败', 'error'));
  }, [notify]);

  const loadTokens = useCallback(async () => {
    try {
      const result = await get<{ items: typeof tokens }>('/api/extension-tokens');
      setTokens(result.items);
    } catch {
      /* 令牌列表失败不影响其它设置 */
    }
  }, []);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const createToken = async () => {
    setTokenBusy(true);
    try {
      const result = await post<{ token: string; label: string }>('/api/extension-tokens', { label: '浏览器扩展' });
      setFreshToken(result.token);
      await loadTokens();
      notify('已生成扩展令牌，只显示这一次', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '生成失败', 'error');
    } finally {
      setTokenBusy(false);
    }
  };

  const revokeToken = async (id: string) => {
    setTokenBusy(true);
    try {
      await del(`/api/extension-tokens/${id}`);
      await loadTokens();
      notify('令牌已吊销', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '吊销失败', 'error');
    } finally {
      setTokenBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const result = await patch<SettingsData['schedule']>('/api/settings', {
        schedule: {
          time,
          timezone,
          jitterSeconds: Number(jitter),
          spreadSeconds: Math.max(0, Math.round(Number(spread || 0) * 60)),
          windowStart,
          windowEnd,
        },
      });
      notify(`调度已保存：${result.time} ${result.timezone}`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const runBackup = async () => {
    setBusy(true);
    try {
      const result = await post<{ file: string }>('/api/admin/backup');
      setBackup(result.file);
      notify(`备份完成：${result.file}`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '备份失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (next.length < 8) {
      notify('新密码至少 8 位', 'error');
      return;
    }
    if (next !== confirm) {
      notify('两次输入的新密码不一致', 'error');
      return;
    }
    setPasswordBusy(true);
    try {
      await post('/api/auth/password', { current, next });
      setCurrent('');
      setNext('');
      setConfirm('');
      notify('管理员密码已更新', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '修改失败', 'error');
    } finally {
      setPasswordBusy(false);
    }
  };

  if (!data) return <div className="card empty-card">加载设置…</div>;

  return (
    <div className="page settings-page">
      <section className="card">
        <div className="card-head">
          <div>
            <h3>每日调度</h3>
            <p>北京时间 08:00 重置；默认 08:10 执行，另加账号级确定性抖动。</p>
          </div>
          <IconClock size={18} />
        </div>

        <div className="settings-grid">
          <label className="field">
            <span className="field-label">执行时间</span>
            <input type="text" inputMode="numeric" maxLength={5} placeholder="08:10" value={time} onChange={(event) => setTime(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">时区</span>
            <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">抖动上限（秒）</span>
            <input type="number" min="0" max="3600" value={jitter} onChange={(event) => setJitter(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">随机窗口（分钟）</span>
            <input type="number" min="0" max="240" value={spread} onChange={(event) => setSpread(event.target.value)} />
            <span className="field-hint">每天在基准时间后随机散开；账号多时建议 30–60 分钟。</span>
          </label>
          <label className="field">
            <span className="field-label">补跑窗口开始</span>
            <input type="text" inputMode="numeric" maxLength={5} placeholder="08:00" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">补跑窗口结束</span>
            <input type="text" inputMode="numeric" maxLength={5} placeholder="23:59" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} />
          </label>
        </div>

        <div className="settings-actions">
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            保存调度
          </button>
          <span className="muted">服务每分钟检查一次；重启或 NAS 唤醒后会按窗口补跑。</span>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>登录方式</h3>
            <p>登录在你自己的浏览器里完成：控制台点「登录」打开平台登录页，登录后把 Cookie 粘贴回来。</p>
          </div>
          <span className="pill pill-ok">
            <i />
            本机登录
          </span>
        </div>
        <p className="security-note">
          服务端不内置浏览器，也不需要额外的登录窗口：验证码、二次验证都在你本机处理，只把 Cookie 加密后交给服务端。
          镜像因此更小，NAS 上也不占额外内存。
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>网络出口</h3>
            <p>服务每小时探测一次出口 IP、地区与运营商；地区或运营商变化会暂停自动任务，等在这里确认。</p>
          </div>
          <span
            className={`pill pill-${data.environment.blocked ? 'bad' : data.environment.drift === 'minor' ? 'warn' : 'ok'}`}
          >
            <i />
            {data.environment.blocked ? '待确认' : data.environment.drift === 'minor' ? '已沿用新出口' : '稳定'}
          </span>
        </div>
        <div className="settings-grid">
          <div className="field">
            <span className="field-label">出口 IP</span>
            <span className="setting-value">{data.environment.ip ?? '尚未探测'}</span>
          </div>
          <div className="field">
            <span className="field-label">地区 / 运营商</span>
            <span className="setting-value">
              {[data.environment.country, data.environment.org].filter(Boolean).join(' · ') || '未知'}
            </span>
          </div>
          <div className="field">
            <span className="field-label">最近探测</span>
            <span className="setting-value">
              {data.environment.checkedAt ? new Date(data.environment.checkedAt).toLocaleString('zh-CN') : '—'}
            </span>
          </div>
        </div>
        {data.environment.note && <p className="security-note">{data.environment.note}</p>}
        {data.environment.lastError && <p className="form-error">最近探测失败：{data.environment.lastError}</p>}
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={probing}
            onClick={() => {
              setProbing(true);
              void post('/api/risk/environment/refresh', {})
                .then(() => get<SettingsData>('/api/settings'))
                .then((settings) => {
                  setData(settings);
                  notify('已重新探测出口', 'success');
                })
                .catch((error: unknown) => notify(error instanceof Error ? error.message : '探测失败', 'error'))
                .finally(() => setProbing(false));
            }}
          >
            {probing ? '探测中…' : '立即探测'}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>浏览器扩展</h3>
            <p>装一次扩展，之后在平台页面点一下图标就能把 Cookie 发过来，不用再手动复制。</p>
          </div>
          <a className="btn btn-ghost btn-sm" href="/checkin-agent-extension.zip" download>
            下载扩展
          </a>
        </div>

        <ol className="login-steps">
          <li>下载并解压上面的 zip。</li>
          <li>
            打开 <code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>），打开「开发者模式」。
          </li>
          <li>点「加载已解压的扩展程序」，选解压出来的目录。</li>
          <li>在下面生成令牌，粘贴到扩展弹窗里，填上本控制台地址。</li>
          <li>去平台登录，登录完点扩展图标 →「读取当前站点 Cookie 并保存」。</li>
        </ol>

        {freshToken && (
          <div className="token-once">
            <span>新令牌（只显示这一次）</span>
            <code>{freshToken}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(freshToken);
                notify('已复制', 'success');
              }}
            >
              复制
            </button>
          </div>
        )}

        {tokens.length > 0 && (
          <div className="token-list">
            {tokens.map((item) => (
              <div className="token-row" key={item.id}>
                <strong>{item.label}</strong>
                <span className="muted small">
                  {item.lastUsedAt ? `最近使用 ${new Date(item.lastUsedAt).toLocaleString('zh-CN')}` : '还没用过'}
                </span>
                <span className={`pill pill-${item.revokedAt ? 'bad' : 'ok'}`}>
                  <i />
                  {item.revokedAt ? '已吊销' : '有效'}
                </span>
                {!item.revokedAt && (
                  <button type="button" className="link-btn" onClick={() => void revokeToken(item.id)} disabled={tokenBusy}>
                    吊销
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="row-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void createToken()} disabled={tokenBusy}>
            {tokenBusy ? '处理中…' : '生成扩展令牌'}
          </button>
        </div>

        <p className="security-note">
          扩展只读取当前标签所属站点的 Cookie，只发到你填写的这个地址；令牌保存在浏览器本地存储，随时可以在这里吊销。
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>密钥与备份</h3>
            <p>Cookie 使用 AES-256-GCM 加密；数据库和 app.key 必须一起备份。</p>
          </div>
          <IconKey size={18} />
        </div>

        <dl className="info-list">
          <div>
            <dt>版本</dt>
            <dd className="mono">v{data.version}</dd>
          </div>
          <div>
            <dt>APP_KEY 指纹</dt>
            <dd className="mono">{data.keyFingerprint}</dd>
          </div>
          <div>
            <dt>Cookie 传输</dt>
            <dd>{data.cookieSecure ? 'HTTPS / Secure' : 'HTTP（仅建议内网）'}</dd>
          </div>
        </dl>

        <div className="settings-actions">
          <button type="button" className="btn btn-ghost" onClick={runBackup} disabled={busy}>
            <IconDatabase size={14} />
            立即备份
          </button>
          {backup && <span className="mono muted">{backup}</span>}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>管理员密码</h3>
            <p>修改后当前会话继续有效；其他设备需要重新登录。</p>
          </div>
          <IconShield size={18} />
        </div>

        <div className="settings-grid settings-grid-password">
          <label className="field">
            <span className="field-label">当前密码</span>
            <input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" />
          </label>
          <label className="field">
            <span className="field-label">新密码</span>
            <input type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" />
          </label>
          <label className="field">
            <span className="field-label">确认新密码</span>
            <input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" />
          </label>
        </div>

        <div className="settings-actions">
          <button type="button" className="btn btn-primary" onClick={changePassword} disabled={passwordBusy}>
            {passwordBusy ? '保存中…' : '修改密码'}
          </button>
          {data.envPassword && <span className="muted">首次密码来自 ADMIN_PASSWORD 环境变量。</span>}
        </div>
      </section>

      <div className="notice notice-neutral">
        <IconShield size={16} />
        <div>
          <strong>部署提醒</strong>
          <p>
            /data 必须放在本地卷，不要放 SMB/NFS（SQLite WAL 会损坏）。建议用 Caddy/Nginx 反代 HTTPS，并把
            COOKIE_SECURE 设为 1；不要把 8787 直接暴露到公网。
          </p>
        </div>
      </div>
    </div>
  );
}

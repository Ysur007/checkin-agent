import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from './index.js';
import type {
  AccountRow,
  CircuitBreakerRow,
  EnvironmentDrift,
  EnvironmentRow,
  RolloutRow,
  RolloutStage,
  CircuitState,
  ClaimDayRow,
  LoginSessionRow,
  LoginSessionStatus,
  PluginRecord,
  RiskEventRow,
  RunEvent,
  RunRow,
  RunStatus,
  SessionRow,
} from '../types.js';

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

/* ---------------- settings ---------------- */

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value), nowIso());
}

export interface ScheduleSettings {
  time: string;
  timezone: string;
  jitterSeconds: number;
  /** 在基准时间后额外随机散开的秒数，默认 30 分钟。 */
  spreadSeconds: number;
  windowStart: string;
  windowEnd: string;
}

export function getSchedule(): ScheduleSettings {
  const defaults: ScheduleSettings = {
    time: '08:10',
    timezone: config.timezone,
    jitterSeconds: 240,
    spreadSeconds: 1800,
    windowStart: '08:00',
    windowEnd: '23:59',
  };
  const stored = getSetting<Partial<ScheduleSettings>>('schedule', {});
  return { ...defaults, ...stored, spreadSeconds: stored.spreadSeconds ?? defaults.spreadSeconds };
}

export function setSchedule(value: ScheduleSettings): void {
  setSetting('schedule', value);
}

export function getAuthSetting(): { salt: string; hash: string } | null {
  return getSetting<{ salt: string; hash: string } | null>('auth', null);
}

export function setAuthSetting(value: { salt: string; hash: string }): void {
  setSetting('auth', value);
}

/* ---------------- plugins ---------------- */

export interface PluginRow {
  id: string;
  name: string;
  version: string;
  source: string;
  manifest: string;
  adapter: string;
  checksum: string;
  enabled: number;
  installed_at: string;
  updated_at: string;
}

export function upsertPlugin(plugin: PluginRecord): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO plugins (id, name, version, source, manifest, adapter, checksum, enabled, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       version = excluded.version,
       source = excluded.source,
       manifest = excluded.manifest,
       adapter = excluded.adapter,
       checksum = excluded.checksum,
       updated_at = excluded.updated_at`,
  ).run(
    plugin.id,
    plugin.name,
    plugin.version,
    plugin.source,
    JSON.stringify(plugin.manifest),
    JSON.stringify(plugin.adapter),
    plugin.checksum,
    plugin.enabled ? 1 : 0,
    now,
    now,
  );
}

export function listPluginRows(): PluginRow[] {
  return db.prepare('SELECT * FROM plugins ORDER BY source, name').all() as PluginRow[];
}

export function getPluginRow(id: string): PluginRow | undefined {
  return db.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as PluginRow | undefined;
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  db.prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), id);
}

/* ---------------- accounts ---------------- */

export function ensureAccount(pluginId: string, label: string): AccountRow {
  const existing = db
    .prepare('SELECT * FROM accounts WHERE plugin_id = ? ORDER BY created_at LIMIT 1')
    .get(pluginId) as AccountRow | undefined;
  if (existing) return existing;

  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO accounts (id, plugin_id, label, enabled, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'unconfigured', ?, ?)`,
  ).run(id, pluginId, label, now, now);
  return getAccount(id)!;
}

export function createAccount(input: {
  pluginId: string;
  label: string;
  loginUrl?: string | null;
  authSource?: string;
  /** auto：名称来自平台/系统，之后可以被平台昵称替换；user：用户自己命名，保留不改 */
  labelSource?: 'auto' | 'user';
}): AccountRow {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO accounts (id, plugin_id, label, label_source, enabled, auth_source, login_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'unconfigured', ?, ?)`,
  ).run(
    id,
    input.pluginId,
    input.label,
    input.labelSource ?? 'user',
    input.authSource ?? 'manual',
    input.loginUrl ?? null,
    now,
    now,
  );
  return getAccount(id)!;
}

/** 昵称接口能打通，说明这份 Cookie 是有效的；账单类平台的 summary 拿不到校验字段时用它兜底。 */
export function markAccountCookieVerified(id: string): void {
  db.prepare('UPDATE accounts SET cookie_verified = 1, cookie_checked_at = ?, updated_at = ? WHERE id = ?').run(
    nowIso(),
    nowIso(),
    id,
  );
}

/** 同一平台下重名时追加序号，保证列表里能分清。 */
export function nextAccountLabel(pluginId: string, base: string): string {
  const rows = db.prepare('SELECT label FROM accounts WHERE plugin_id = ?').all(pluginId) as Array<{ label: string }>;
  const taken = new Set(rows.map((row) => row.label));
  const name = base.trim().slice(0, 40) || '账号';
  if (!taken.has(name)) return name;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${name} #${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} #${Date.now() % 1000}`;
}

/**
 * 写入平台昵称。label_source=auto 的账号会顺带把显示名改成昵称，
 * 重名时追加序号，避免两个账号在列表里长得一模一样。
 */
export function applyAccountProfile(id: string, displayName: string): void {
  const row = getAccount(id);
  if (!row) return;
  const clean = displayName.trim().slice(0, 40);
  if (!clean) return;

  let label = row.label;
  if (row.label_source === 'auto') {
    const taken = (db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE id != ? AND plugin_id = ? AND label = ?')
      .get(id, row.plugin_id, clean) as { count: number }).count;
    label = taken > 0 ? `${clean} #${taken + 1}` : clean;
  }

  db.prepare('UPDATE accounts SET display_name = ?, label = ?, updated_at = ? WHERE id = ?').run(
    clean,
    label,
    nowIso(),
    id,
  );
}

export function deleteAccount(id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE account_id = ?)').run(id);
    db.prepare('DELETE FROM runs WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM claim_days WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM login_sessions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  });
  tx();
}

export function listAccounts(): AccountRow[] {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as AccountRow[];
}

export function countAccountsByPlugin(): Record<string, number> {
  const rows = db.prepare('SELECT plugin_id, COUNT(*) AS count FROM accounts GROUP BY plugin_id').all() as Array<{
    plugin_id: string;
    count: number;
  }>;
  return Object.fromEntries(rows.map((row) => [row.plugin_id, row.count]));
}

export function getAccount(id: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
}

export function updateAccountCookie(
  id: string,
  sealed: string,
  fp: string,
  len: number,
  keys: string[],
  expiresHint: string | null,
  options?: { expiresAt?: string | null; verified?: boolean; checkedAt?: string | null; authSource?: string },
): void {
  db.prepare(
    `UPDATE accounts SET cookie_sealed = ?, cookie_fp = ?, cookie_len = ?, cookie_keys = ?, expires_hint = ?,
       cookie_expires_at = ?, cookie_verified = ?, cookie_checked_at = ?,
       auth_source = COALESCE(?, auth_source),
       cookie_updated_at = ?, status = 'ok', last_error_code = NULL, updated_at = ? WHERE id = ?`,
  ).run(
    sealed,
    fp,
    len,
    JSON.stringify(keys),
    expiresHint,
    options?.expiresAt ?? null,
    options?.verified ? 1 : 0,
    options?.checkedAt ?? null,
    options?.authSource ?? null,
    nowIso(),
    nowIso(),
    id,
  );
}

export function markCookieChecked(id: string, verified: boolean): void {
  db.prepare('UPDATE accounts SET cookie_checked_at = ?, cookie_verified = ?, updated_at = ? WHERE id = ?').run(
    nowIso(),
    verified ? 1 : 0,
    nowIso(),
    id,
  );
}

export function updateAccountSummary(
  id: string,
  summary: {
    balance: number | null;
    claimedToday: boolean | null;
    available?: boolean | null;
    amount?: number | null;
    resetAt: string | null;
  },
): void {
  db.prepare(
    `UPDATE accounts SET last_balance = ?, last_claimed_today = ?, last_available = ?, last_amount = ?, last_reset_at = ?,
       last_summary_at = ?, expires_hint = COALESCE(?, expires_hint), updated_at = ? WHERE id = ?`,
  ).run(
    summary.balance,
    summary.claimedToday === null ? null : summary.claimedToday ? 1 : 0,
    summary.available === undefined || summary.available === null ? null : summary.available ? 1 : 0,
    summary.amount ?? null,
    summary.resetAt,
    nowIso(),
    summary.resetAt,
    nowIso(),
    id,
  );
}

export function setAccountStatus(id: string, status: string, errorCode: string | null = null): void {
  db.prepare('UPDATE accounts SET status = ?, last_error_code = ?, updated_at = ? WHERE id = ?').run(
    status,
    errorCode,
    nowIso(),
    id,
  );
}

export function updateAccountAfterRun(id: string, status: RunStatus, errorCode: string | null): void {
  const success = status === 'succeeded' || status === 'already_claimed';
  const accountStatus =
    status === 'needs_reauth'
      ? 'needs_reauth'
      : status === 'rate_limited'
        ? 'rate_limited'
        : success
          ? 'ok'
          : status === 'failed' || status === 'unverified'
            ? 'error'
            : 'ok';

  const current = getAccount(id);
  const failStreak = success ? 0 : (current?.fail_streak ?? 0) + 1;

  db.prepare(
    `UPDATE accounts SET status = ?, last_error_code = ?, last_run_at = ?, fail_streak = ?,
       last_ok_at = CASE WHEN ? = 1 THEN ? ELSE last_ok_at END, updated_at = ? WHERE id = ?`,
  ).run(accountStatus, errorCode, nowIso(), failStreak, success ? 1 : 0, nowIso(), nowIso(), id);
}

export function setAccountConfig(id: string, patch: { label?: string; enabled?: boolean; scheduleTime?: string | null }): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.label !== undefined) {
    fields.push('label = ?');
    values.push(patch.label);
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.scheduleTime !== undefined) {
    fields.push('schedule_time = ?');
    values.push(patch.scheduleTime);
  }
  if (fields.length === 0) return;
  values.push(nowIso(), id);
  db.prepare(`UPDATE accounts SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).run(...values);
}

export function acquireLock(id: string, token: string, expiresAt: number): boolean {
  const result = db
    .prepare(
      `UPDATE accounts SET lock_token = ?, lock_expires_at = ? WHERE id = ? AND enabled = 1
       AND (lock_expires_at IS NULL OR lock_expires_at < ?)`,
    )
    .run(token, expiresAt, id, Date.now());
  return result.changes === 1;
}

export function releaseLock(id: string, token: string): void {
  db.prepare('UPDATE accounts SET lock_token = NULL, lock_expires_at = NULL WHERE id = ? AND lock_token = ?').run(id, token);
}

/* ---------------- runs ---------------- */

export interface NewRun {
  id: string;
  accountId: string;
  pluginId: string;
  pluginVersion: string;
  trigger: string;
  localDate: string;
  idemKey: string;
  status: RunStatus;
  attempt: number;
}

export function insertRun(input: NewRun): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO runs
       (id, account_id, plugin_id, plugin_version, trigger, local_date, idem_key, status, attempt, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.accountId,
      input.pluginId,
      input.pluginVersion,
      input.trigger,
      input.localDate,
      input.idemKey,
      input.status,
      input.attempt,
      nowIso(),
    );
  return result.changes === 1;
}

const RUN_PATCH_FIELDS = new Set([
  'status',
  'attempt',
  'error_code',
  'error_message',
  'http_status',
  'pre_balance',
  'post_balance',
  'credits_issued',
  'claimed_flag',
  'latency_ms',
  'finished_at',
  'evidence',
]);

export function updateRun(id: string, patch: Record<string, unknown>): void {
  const entries = Object.entries(patch).filter(([key, value]) => RUN_PATCH_FIELDS.has(key) && value !== undefined);
  if (entries.length === 0) return;
  const sql = `UPDATE runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...entries.map(([, value]) => value as never), id);
}

export function addEvent(runId: string, type: string, detail: unknown): void {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?').get(runId) as { seq: number };
  db.prepare('INSERT INTO run_events (run_id, seq, at, type, detail) VALUES (?, ?, ?, ?, ?)').run(
    runId,
    row.seq + 1,
    nowIso(),
    type,
    JSON.stringify(detail),
  );
}

export function getRun(id: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
}

export function getRunEvents(id: string): RunEvent[] {
  return db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq').all(id) as RunEvent[];
}

export function listRuns(limit = 50, status?: string): RunRow[] {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (status) {
    return db
      .prepare('SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ?')
      .all(status, safeLimit) as RunRow[];
  }
  return db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(safeLimit) as RunRow[];
}

export function countRunsForAccount(accountId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM runs WHERE account_id = ?').get(accountId) as { count: number };
  return row.count;
}

export function latestRunForAccount(accountId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 1').get(accountId) as
    | RunRow
    | undefined;
}

export function runForDate(accountId: string, date: string): RunRow | undefined {
  return db
    .prepare('SELECT * FROM runs WHERE account_id = ? AND local_date = ? ORDER BY started_at DESC LIMIT 1')
    .get(accountId, date) as RunRow | undefined;
}

export function hasSuccessOn(accountId: string, date: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM runs WHERE account_id = ? AND local_date = ? AND status IN ('succeeded','already_claimed') LIMIT 1")
    .get(accountId, date) as { ok: number } | undefined;
  return Boolean(row);
}

export function hasScheduledRunOn(accountId: string, date: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM runs WHERE account_id = ? AND local_date = ? AND trigger IN ('schedule','backfill') LIMIT 1")
    .get(accountId, date) as { ok: number } | undefined;
  return Boolean(row);
}

export interface StatusCount {
  status: string;
  count: number;
  credits: number;
}

export function statsSince(date: string): StatusCount[] {
  return db
    .prepare('SELECT status, COUNT(*) AS count, COALESCE(SUM(credits_issued), 0) AS credits FROM runs WHERE local_date >= ? GROUP BY status')
    .all(date) as StatusCount[];
}

/* ---------------- sessions ---------------- */

export function createSession(
  tokenHash: string,
  csrfHash: string,
  expiresAt: string,
  ip: string | null,
  userAgent: string | null,
): string {
  const id = newId();
  const now = nowIso();
  db.prepare(
    'INSERT INTO sessions (id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, tokenHash, csrfHash, now, expiresAt, now, ip, userAgent);
  return id;
}

export function getSessionByHash(tokenHash: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as SessionRow | undefined;
}

export function touchSession(id: string): void {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function cleanupSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}

/* ---------------- audit + backup ---------------- */

export function audit(actor: string, action: string, target: string | null, meta?: unknown): void {
  db.prepare('INSERT INTO audit_log (at, actor, action, target, meta) VALUES (?, ?, ?, ?, ?)').run(
    nowIso(),
    actor,
    action,
    target,
    meta === undefined ? null : JSON.stringify(meta),
  );
}

export function backupDatabase(): string {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `checkin-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.db'))
    .sort()
    .reverse();
  for (const old of files.slice(5)) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      /* ignore */
    }
  }
  return file;
}

export function getRunByIdem(key: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE idem_key = ?').get(key) as RunRow | undefined;
}

export function countRunsOn(accountId: string, date: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM runs WHERE account_id = ? AND local_date = ?').get(accountId, date) as {
    count: number;
  };
  return row.count;
}

export interface DailyStat {
  date: string;
  runs: number;
  claims: number;
  credits: number;
}

export function dailyStatsSince(date: string): DailyStat[] {
  return db
    .prepare(
      `SELECT local_date AS date,
              COUNT(*) AS runs,
              SUM(CASE WHEN status IN ('succeeded','already_claimed') THEN 1 ELSE 0 END) AS claims,
              COALESCE(SUM(credits_issued), 0) AS credits
       FROM runs WHERE local_date >= ? GROUP BY local_date ORDER BY local_date`,
    )
    .all(date) as DailyStat[];
}

export function updateSessionCsrf(id: string, hash: string): void {
  db.prepare('UPDATE sessions SET csrf_hash = ? WHERE id = ?').run(hash, id);
}


/* ---------------- login sessions ---------------- */

export function createLoginSessionRow(input: {
  id: string;
  providerId: string;
  accountId: string | null;
  ownerSession: string;
  label: string;
  loginUrl: string;
  expiresAt: string;
}): LoginSessionRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO login_sessions
      (id, provider_id, account_id, owner_session, label, login_url, status, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
  ).run(input.id, input.providerId, input.accountId, input.ownerSession, input.label, input.loginUrl, now, now, input.expiresAt);
  return getLoginSession(input.id)!;
}

export function getLoginSession(id: string): LoginSessionRow | undefined {
  return db.prepare('SELECT * FROM login_sessions WHERE id = ?').get(id) as LoginSessionRow | undefined;
}

export function updateLoginSession(
  id: string,
  patch: {
    status?: LoginSessionStatus;
    currentUrl?: string | null;
    pageTitle?: string | null;
    lastError?: string | null;
    detectedCookies?: string | null;
    accountId?: string | null;
    closedAt?: string | null;
  },
): void {
  const entries: Array<[string, unknown]> = [];
  if (patch.status !== undefined) entries.push(['status', patch.status]);
  if (patch.currentUrl !== undefined) entries.push(['current_url', patch.currentUrl]);
  if (patch.pageTitle !== undefined) entries.push(['page_title', patch.pageTitle]);
  if (patch.lastError !== undefined) entries.push(['last_error', patch.lastError]);
  if (patch.detectedCookies !== undefined) entries.push(['detected_cookies', patch.detectedCookies]);
  if (patch.accountId !== undefined) entries.push(['account_id', patch.accountId]);
  if (patch.closedAt !== undefined) entries.push(['closed_at', patch.closedAt]);
  if (entries.length === 0) return;
  entries.push(['updated_at', nowIso()]);
  db.prepare(`UPDATE login_sessions SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`).run(
    ...entries.map(([, value]) => value as never),
    id,
  );
}

export function listOpenLoginSessions(): LoginSessionRow[] {
  return db
    .prepare("SELECT * FROM login_sessions WHERE status IN ('starting','waiting','ready') ORDER BY created_at")
    .all() as LoginSessionRow[];
}

export function expireLoginSessions(now = nowIso()): LoginSessionRow[] {
  const rows = db
    .prepare("SELECT * FROM login_sessions WHERE status IN ('starting','waiting') AND expires_at < ?")
    .all(now) as LoginSessionRow[];
  for (const row of rows) {
    updateLoginSession(row.id, { status: 'expired', closedAt: nowIso(), lastError: '登录窗口已超时' });
  }
  return rows;
}

/* ---------------- claim ledger ---------------- */

export function getClaimDay(accountId: string, date: string): ClaimDayRow | undefined {
  return db.prepare('SELECT * FROM claim_days WHERE account_id = ? AND local_date = ?').get(accountId, date) as
    | ClaimDayRow
    | undefined;
}

export function recordClaimDay(input: {
  accountId: string;
  date: string;
  runId: string;
  status: string;
  credits: number | null;
  httpStatus: number | null;
  verified: boolean;
}): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO claim_days (account_id, local_date, run_id, status, credits, http_status, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, local_date) DO NOTHING`,
  ).run(
    input.accountId,
    input.date,
    input.runId,
    input.status,
    input.credits,
    input.httpStatus,
    input.verified ? 1 : 0,
    now,
    now,
  );
}

export interface ClaimDayWithAccount extends ClaimDayRow {
  label: string | null;
  plugin_id: string | null;
}

export function listClaimDaysSince(date: string): ClaimDayWithAccount[] {
  return db
    .prepare(
      `SELECT c.*, a.label, a.plugin_id
       FROM claim_days c LEFT JOIN accounts a ON a.id = c.account_id
       WHERE c.local_date >= ? ORDER BY c.local_date DESC, c.created_at DESC`,
    )
    .all(date) as ClaimDayWithAccount[];
}

export function countClaimDays(): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM claim_days').get() as { count: number };
  return row.count;
}

export function claimDaysSince(date: string): Array<{ local_date: string; count: number; credits: number }> {
  return db
    .prepare(
      `SELECT local_date, COUNT(*) AS count, COALESCE(SUM(credits), 0) AS credits
       FROM claim_days WHERE local_date >= ? GROUP BY local_date ORDER BY local_date`,
    )
    .all(date) as Array<{ local_date: string; count: number; credits: number }>;
}

/* ---------------- audit ---------------- */

export function listAudit(limit = 50): Array<{ id: number; at: string; actor: string; action: string; target: string | null; meta: string | null }> {
  return db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200)) as Array<{
    id: number;
    at: string;
    actor: string;
    action: string;
    target: string | null;
    meta: string | null;
  }>;
}


/* ---------------- risk controls ---------------- */

export function isAutomationPaused(): boolean {
  return getSetting<boolean>('automationPaused', false);
}

export function setAutomationPaused(paused: boolean): void {
  setSetting('automationPaused', paused);
}

export function recordRiskEvent(input: {
  platformId: string;
  accountId?: string | null;
  kind: string;
  detail?: unknown;
}): void {
  db.prepare('INSERT INTO risk_events (at, platform_id, account_id, kind, detail) VALUES (?, ?, ?, ?, ?)').run(
    nowIso(),
    input.platformId,
    input.accountId ?? null,
    input.kind,
    input.detail === undefined ? null : JSON.stringify(input.detail),
  );
}

export function listRiskEvents(limit = 50, platformId?: string): RiskEventRow[] {
  const safe = Math.min(Math.max(limit, 1), 200);
  if (platformId) {
    return db
      .prepare('SELECT * FROM risk_events WHERE platform_id = ? ORDER BY at DESC LIMIT ?')
      .all(platformId, safe) as RiskEventRow[];
  }
  return db.prepare('SELECT * FROM risk_events ORDER BY at DESC LIMIT ?').all(safe) as RiskEventRow[];
}

export function countRiskEventsSince(platformId: string, since: string, kinds?: string[]): number {
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map(() => '?').join(',');
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM risk_events WHERE platform_id = ? AND at >= ? AND kind IN (${placeholders})`)
      .get(platformId, since, ...kinds) as { count: number };
    return row.count;
  }
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM risk_events WHERE platform_id = ? AND at >= ?')
    .get(platformId, since) as { count: number };
  return row.count;
}

export function countAllRiskEventsSince(since: string, kinds?: string[]): number {
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map(() => '?').join(',');
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM risk_events WHERE at >= ? AND kind IN (${placeholders})`)
      .get(since, ...kinds) as { count: number };
    return row.count;
  }
  const row = db.prepare('SELECT COUNT(*) AS count FROM risk_events WHERE at >= ?').get(since) as { count: number };
  return row.count;
}

export function countAccountRiskEventsSince(accountId: string, since: string, kinds?: string[]): number {
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map(() => '?').join(',');
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM risk_events WHERE account_id = ? AND at >= ? AND kind IN (${placeholders})`)
      .get(accountId, since, ...kinds) as { count: number };
    return row.count;
  }
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM risk_events WHERE account_id = ? AND at >= ?')
    .get(accountId, since) as { count: number };
  return row.count;
}

export function getPolicyAck(platformId: string): string | null {
  const row = db.prepare('SELECT acked_at FROM policy_acks WHERE platform_id = ?').get(platformId) as
    | { acked_at: string }
    | undefined;
  return row?.acked_at ?? null;
}

export function setPolicyAck(platformId: string, note = '用户已核对平台条款'): void {
  db.prepare(
    'INSERT INTO policy_acks (platform_id, acked_at, note) VALUES (?, ?, ?) ON CONFLICT(platform_id) DO UPDATE SET acked_at = excluded.acked_at, note = excluded.note',
  ).run(platformId, nowIso(), note);
}

export function listPolicyAcks(): Record<string, string> {
  const rows = db.prepare('SELECT platform_id, acked_at FROM policy_acks').all() as Array<{
    platform_id: string;
    acked_at: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.platform_id, row.acked_at]));
}

export function getBreaker(platformId: string): CircuitBreakerRow | undefined {
  return db.prepare('SELECT * FROM circuit_breakers WHERE platform_id = ?').get(platformId) as
    | CircuitBreakerRow
    | undefined;
}

export function listBreakers(): CircuitBreakerRow[] {
  return db.prepare('SELECT * FROM circuit_breakers ORDER BY updated_at DESC').all() as CircuitBreakerRow[];
}

export function saveBreaker(input: {
  platformId: string;
  state: CircuitState;
  reason: string | null;
  openedAt: string | null;
  openUntil: string | null;
  strikes: number;
  windowStart: string;
}): void {
  db.prepare(
    `INSERT INTO circuit_breakers (platform_id, state, reason, opened_at, open_until, strikes, window_start, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform_id) DO UPDATE SET
       state = excluded.state,
       reason = excluded.reason,
       opened_at = excluded.opened_at,
       open_until = excluded.open_until,
       strikes = excluded.strikes,
       window_start = excluded.window_start,
       updated_at = excluded.updated_at`,
  ).run(
    input.platformId,
    input.state,
    input.reason,
    input.openedAt,
    input.openUntil,
    input.strikes,
    input.windowStart,
    nowIso(),
  );
}

export function countRunsStartedSince(iso: string, triggers: string[] = ['schedule', 'backfill']): number {
  const placeholders = triggers.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM runs WHERE started_at >= ? AND trigger IN (${placeholders})`)
    .get(iso, ...triggers) as { count: number };
  return row.count;
}

export function countPlatformRunsSince(platformId: string, since: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM runs WHERE plugin_id = ? AND started_at >= ?')
    .get(platformId, since) as { count: number };
  return row.count;
}

export function countActiveLocks(now = Date.now()): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM accounts WHERE lock_expires_at IS NOT NULL AND lock_expires_at > ?')
    .get(now) as { count: number };
  return row.count;
}

export function platformHasActiveLock(platformId: string, now = Date.now()): boolean {
  const row = db
    .prepare('SELECT 1 AS busy FROM accounts WHERE plugin_id = ? AND lock_expires_at > ? LIMIT 1')
    .get(platformId, now) as { busy: number } | undefined;
  return Boolean(row);
}


/* ---------------- canary rollout ---------------- */

export function getRollout(platformId: string): RolloutRow | undefined {
  return db.prepare('SELECT * FROM platform_rollout WHERE platform_id = ?').get(platformId) as RolloutRow | undefined;
}

export function listRollouts(): RolloutRow[] {
  return db.prepare('SELECT * FROM platform_rollout ORDER BY updated_at DESC').all() as RolloutRow[];
}

export function saveRollout(input: {
  platformId: string;
  stage: RolloutStage;
  canaryAccountId: string | null;
  startedAt: string | null;
  successDays: number;
  lastSuccessDate: string | null;
  pluginVersion: string | null;
  note: string | null;
}): void {
  db.prepare(
    `INSERT INTO platform_rollout
       (platform_id, stage, canary_account_id, started_at, success_days, last_success_date, plugin_version, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform_id) DO UPDATE SET
       stage = excluded.stage,
       canary_account_id = excluded.canary_account_id,
       started_at = excluded.started_at,
       success_days = excluded.success_days,
       last_success_date = excluded.last_success_date,
       plugin_version = excluded.plugin_version,
       note = excluded.note,
       updated_at = excluded.updated_at`,
  ).run(
    input.platformId,
    input.stage,
    input.canaryAccountId,
    input.startedAt,
    input.successDays,
    input.lastSuccessDate,
    input.pluginVersion,
    input.note,
    nowIso(),
  );
}

/* ---------------- environment baseline ---------------- */

export function getEnvironment(scope = 'global'): EnvironmentRow | undefined {
  return db.prepare('SELECT * FROM environment_baseline WHERE scope = ?').get(scope) as EnvironmentRow | undefined;
}

export function saveEnvironment(input: {
  scope?: string;
  ip: string | null;
  country: string | null;
  org: string | null;
  changedAt: string | null;
  drift: EnvironmentDrift;
  driftNote: string | null;
  samples: number;
}): void {
  db.prepare(
    `INSERT INTO environment_baseline (scope, ip, country, org, checked_at, changed_at, drift, drift_note, samples)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       ip = excluded.ip,
       country = excluded.country,
       org = excluded.org,
       checked_at = excluded.checked_at,
       changed_at = excluded.changed_at,
       drift = excluded.drift,
       drift_note = excluded.drift_note,
       samples = excluded.samples`,
  ).run(
    input.scope ?? 'global',
    input.ip,
    input.country,
    input.org,
    nowIso(),
    input.changedAt,
    input.drift,
    input.driftNote,
    input.samples,
  );
}

/* ---------------- local login pairing ---------------- */

export interface PairingRow {
  code: string;
  account_id: string;
  created_at: string;
  expires_at: string;
  token_hash: string | null;
  token_expires_at: string | null;
  used_at: string | null;
}

export function createPairing(code: string, accountId: string, ttlMs: number): PairingRow {
  const now = Date.now();
  db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(new Date(now).toISOString());
  db.prepare(
    'INSERT INTO pairing_codes (code, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(code, accountId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  return getPairingByCode(code)!;
}

export function getPairingByCode(code: string): PairingRow | undefined {
  return db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code) as PairingRow | undefined;
}

export function setPairingToken(code: string, tokenHash: string, ttlMs: number): void {
  db.prepare('UPDATE pairing_codes SET token_hash = ?, token_expires_at = ? WHERE code = ?').run(
    tokenHash,
    new Date(Date.now() + ttlMs).toISOString(),
    code,
  );
}

export function getPairingByTokenHash(tokenHash: string): PairingRow | undefined {
  return db.prepare('SELECT * FROM pairing_codes WHERE token_hash = ?').get(tokenHash) as PairingRow | undefined;
}

export function markPairingUsed(code: string): void {
  db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code = ?').run(new Date().toISOString(), code);
}

export function dropPairing(code: string): void {
  db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code);
}

/* ---------------- browser extension tokens ---------------- */

export interface ExtensionTokenRow {
  id: string;
  label: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function createExtensionToken(id: string, label: string, tokenHash: string): ExtensionTokenRow {
  const now = nowIso();
  db.prepare('INSERT INTO extension_tokens (id, label, token_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    label,
    tokenHash,
    now,
  );
  return db.prepare('SELECT * FROM extension_tokens WHERE id = ?').get(id) as ExtensionTokenRow;
}

export function listExtensionTokens(): ExtensionTokenRow[] {
  return db.prepare('SELECT * FROM extension_tokens ORDER BY created_at DESC').all() as ExtensionTokenRow[];
}

export function getExtensionTokenByHash(tokenHash: string): ExtensionTokenRow | undefined {
  return db
    .prepare('SELECT * FROM extension_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(tokenHash) as ExtensionTokenRow | undefined;
}

export function touchExtensionToken(id: string): void {
  db.prepare('UPDATE extension_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
}

export function revokeExtensionToken(id: string): void {
  db.prepare('UPDATE extension_tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), id);
}

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  manifest TEXT NOT NULL,
  adapter TEXT NOT NULL,
  checksum TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cookie_sealed TEXT,
  cookie_fp TEXT,
  cookie_len INTEGER,
  cookie_keys TEXT,
  cookie_updated_at TEXT,
  cookie_expires_at TEXT,
  cookie_checked_at TEXT,
  cookie_verified INTEGER NOT NULL DEFAULT 0,
  auth_source TEXT NOT NULL DEFAULT 'manual',
  login_url TEXT,
  expires_hint TEXT,
  status TEXT NOT NULL DEFAULT 'unconfigured',
  schedule_time TEXT,
  lock_token TEXT,
  lock_expires_at INTEGER,
  last_ok_at TEXT,
  last_run_at TEXT,
  last_error_code TEXT,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  last_balance REAL,
  last_claimed_today INTEGER,
  last_available INTEGER,
  last_amount REAL,
  last_reset_at TEXT,
  last_summary_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  trigger TEXT NOT NULL,
  local_date TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT,
  http_status INTEGER,
  pre_balance REAL,
  post_balance REAL,
  credits_issued REAL,
  claimed_flag INTEGER,
  latency_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  evidence TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_idem ON runs(idem_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_sched ON runs(account_id, local_date)
  WHERE trigger IN ('schedule', 'backfill');
CREATE INDEX IF NOT EXISTS ix_runs_account_time ON runs(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_runs_status_time ON runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_runs_date ON runs(local_date);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS ix_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at DESC);
`;

/**
 * v2：账号登录会话、签到账本。
 * 账本 (account_id, local_date) 是主键，重复签到在数据库层就不可能写入成功。
 */
export const MIGRATION_2_SQL = `
CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_id TEXT,
  owner_session TEXT NOT NULL,
  label TEXT NOT NULL,
  login_url TEXT NOT NULL,
  status TEXT NOT NULL,
  current_url TEXT,
  page_title TEXT,
  last_error TEXT,
  detected_cookies TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_login_sessions_owner ON login_sessions(owner_session, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_login_sessions_status ON login_sessions(status);

CREATE TABLE IF NOT EXISTS claim_days (
  account_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  credits REAL,
  http_status INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, local_date)
);

CREATE INDEX IF NOT EXISTS ix_claim_days_date ON claim_days(local_date DESC);
`;

/**
 * v3：风险事件与平台级熔断。
 * risk_events 只记录行为层信号（挑战、限流、暂停、熔断），不记录 Cookie 或响应正文。
 */
export const MIGRATION_3_SQL = `
CREATE TABLE IF NOT EXISTS risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  account_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS ix_risk_events_platform_at ON risk_events(platform_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_risk_events_at ON risk_events(at DESC);

CREATE TABLE IF NOT EXISTS circuit_breakers (
  platform_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'closed',
  reason TEXT,
  opened_at TEXT,
  open_until TEXT,
  strikes INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * v4：平台条款确认。unknown 策略在执行前需要用户显式确认一次。
 */
export const MIGRATION_4_SQL = `
CREATE TABLE IF NOT EXISTS policy_acks (
  platform_id TEXT PRIMARY KEY,
  acked_at TEXT NOT NULL,
  note TEXT
);
`;

/**
 * v5：金丝雀灰度与出口环境基线。
 * platform_rollout 记录某个平台是否只允许一个账号先行验证；
 * environment_baseline 记录出口 IP / 国家 / 运营商，用于发现网络环境突变。
 */
export const MIGRATION_5_SQL = `
CREATE TABLE IF NOT EXISTS platform_rollout (
  platform_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'open',
  canary_account_id TEXT,
  started_at TEXT,
  success_days INTEGER NOT NULL DEFAULT 0,
  last_success_date TEXT,
  plugin_version TEXT,
  note TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environment_baseline (
  scope TEXT PRIMARY KEY,
  ip TEXT,
  country TEXT,
  org TEXT,
  checked_at TEXT NOT NULL,
  changed_at TEXT,
  drift TEXT NOT NULL DEFAULT 'none',
  drift_note TEXT,
  samples INTEGER NOT NULL DEFAULT 1
);
`;

/**
 * v6：本机浏览器登录配对。
 * 控制台生成一次性配对码，本机登录助手用码换短期令牌，再把 Cookie 回传到服务端。
 * 服务端只存码与令牌哈希，不存明文。
 */
export const MIGRATION_6_SQL = `
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  token_hash TEXT,
  token_expires_at TEXT,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_pairing_expires ON pairing_codes(expires_at);
`;

export const MIGRATION_VERSION = 6;

/** 旧库升级时需要补的列；新库已包含在 MIGRATION_SQL 里。 */
export const ACCOUNT_COLUMNS_V2: Array<{ name: string; ddl: string }> = [
  { name: 'cookie_expires_at', ddl: 'ALTER TABLE accounts ADD COLUMN cookie_expires_at TEXT' },
  { name: 'cookie_checked_at', ddl: 'ALTER TABLE accounts ADD COLUMN cookie_checked_at TEXT' },
  { name: 'cookie_verified', ddl: 'ALTER TABLE accounts ADD COLUMN cookie_verified INTEGER NOT NULL DEFAULT 0' },
  { name: 'auth_source', ddl: "ALTER TABLE accounts ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'manual'" },
  { name: 'login_url', ddl: 'ALTER TABLE accounts ADD COLUMN login_url TEXT' },
];

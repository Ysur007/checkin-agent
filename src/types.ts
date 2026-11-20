export interface Manifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  author?: string;
  homepage?: string;
  description: string;
  license?: string;
  auth: {
    type: 'cookie';
    primaryCookie: string;
    hintUrl?: string;
  };
  permissions: {
    network: string[];
    hooks?: boolean;
  };
  schedule: {
    timezone: string;
    defaultTime: string;
    jitterSeconds: number;
    windowStart: string;
    windowEnd: string;
  };
  limits: {
    timeoutMs: number;
    maxAttempts: number;
  };
}

export interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface ErrorRule {
  status?: number[];
  statusMin?: number;
  bodyCode?: string;
  messageIncludes?: string;
  contentTypeIncludes?: string;
  error: string;
  retry?: boolean;
}

export type RuleOp = 'eq' | 'neq' | 'truthy' | 'falsy' | 'gte' | 'lte' | 'includes';

export interface Rule {
  source: 'summary' | 'claim' | 'verify';
  field: string;
  op: RuleOp;
  value?: unknown;
  result: string;
}

export interface Adapter {
  schemaVersion: 1;
  baseUrl: string;
  defaultHeaders: Record<string, string>;
  requests: {
    summary: RequestSpec;
    /** 有些平台「签到」就是访问一次首页接口（登录即到账），此时 claim 只是触发请求。 */
    claim?: RequestSpec;
    /** 复核请求；缺省时复用 summary。 */
    verify?: RequestSpec;
  };
  extract: {
    summary: ExtractMapping;
    claim: ExtractMapping;
    /** 复核响应的取值路径；缺省时复用 summary。 */
    verify?: ExtractMapping;
  };
  /**
   * 账单模式：平台不给「今天领没领」的布尔值，只给流水。
   * 配置后，preflight 与复核都按账单里当天的 EARN 记录判定，余额增量改为参考值。
   */
  ledger?: LedgerSpec;
  rules: {
    preflight: Rule[];
    /** 留空时按 HTTP 2xx 视为已触发，最终以复核为准。 */
    claim: Rule[];
    /** 留空时只以复核字段判定。 */
    verify: Rule[];
  };
  errors: ErrorRule[];
  retry: {
    maxAttempts: number;
    backoffMs: number[];
  };
}

/** 取值映射：值为单个路径，或按顺序尝试的候选路径数组。 */
export type ExtractMapping = Record<string, string | string[]>;

export interface LedgerSpec {
  /** 账单数组的取值路径，可给多个候选（兼容 Data / data 两种信封） */
  records: string | string[];
  /** 记录时间字段，取前 10 位作为日期 */
  dateField: string;
  /** 记录类型字段与期望值，如 type = EARN */
  typeField?: string;
  typeValue?: string;
  /** 计入「每日签到」的规则键，如 daily_active */
  ruleKeys: string[];
  /** 计入魔粒数的字段 */
  amountField?: string;
  /** 账单日期所用时区，缺省用 manifest 的 timezone */
  timezone?: string;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  manifest: Manifest;
  adapter: Adapter;
  checksum: string;
  enabled: boolean;
  source: 'builtin' | 'installed';
}

export type RunStatus =
  | 'queued'
  | 'preflight'
  | 'claiming'
  | 'verifying'
  | 'succeeded'
  | 'already_claimed'
  | 'unverified'
  | 'needs_reauth'
  | 'rate_limited'
  | 'skipped'
  | 'failed';

export interface AccountRow {
  id: string;
  plugin_id: string;
  label: string;
  enabled: number;
  cookie_sealed: string | null;
  cookie_fp: string | null;
  cookie_len: number | null;
  cookie_keys: string | null;
  cookie_updated_at: string | null;
  cookie_expires_at: string | null;
  cookie_checked_at: string | null;
  cookie_verified: number;
  auth_source: string;
  login_url: string | null;
  expires_hint: string | null;
  status: string;
  schedule_time: string | null;
  lock_token: string | null;
  lock_expires_at: number | null;
  last_ok_at: string | null;
  last_run_at: string | null;
  last_error_code: string | null;
  fail_streak: number;
  last_balance: number | null;
  last_claimed_today: number | null;
  last_available: number | null;
  last_amount: number | null;
  last_reset_at: string | null;
  last_summary_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  account_id: string;
  plugin_id: string;
  plugin_version: string;
  trigger: string;
  local_date: string;
  idem_key: string;
  status: RunStatus;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  http_status: number | null;
  pre_balance: number | null;
  post_balance: number | null;
  credits_issued: number | null;
  claimed_flag: number | null;
  latency_ms: number | null;
  started_at: string;
  finished_at: string | null;
  evidence: string | null;
}

export interface RunEvent {
  id: number;
  run_id: string;
  seq: number;
  at: string;
  type: string;
  detail: string;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  csrf_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}


export type LoginSessionStatus = 'starting' | 'waiting' | 'ready' | 'captured' | 'expired' | 'failed' | 'closed';

export interface LoginSessionRow {
  id: string;
  provider_id: string;
  account_id: string | null;
  owner_session: string;
  label: string;
  login_url: string;
  status: LoginSessionStatus;
  current_url: string | null;
  page_title: string | null;
  last_error: string | null;
  detected_cookies: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  closed_at: string | null;
}

export interface ClaimDayRow {
  account_id: string;
  local_date: string;
  run_id: string | null;
  status: string;
  credits: number | null;
  http_status: number | null;
  verified: number;
  created_at: string;
  updated_at: string;
}


export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerRow {
  platform_id: string;
  state: CircuitState;
  reason: string | null;
  opened_at: string | null;
  open_until: string | null;
  strikes: number;
  window_start: string;
  updated_at: string;
}

export interface RiskEventRow {
  id: number;
  at: string;
  platform_id: string;
  account_id: string | null;
  kind: string;
  detail: string | null;
}


export type RolloutStage = 'open' | 'canary';

export interface RolloutRow {
  platform_id: string;
  stage: RolloutStage;
  canary_account_id: string | null;
  started_at: string | null;
  success_days: number;
  last_success_date: string | null;
  plugin_version: string | null;
  note: string | null;
  updated_at: string;
}

export type EnvironmentDrift = 'none' | 'minor' | 'major';

export interface EnvironmentRow {
  scope: string;
  ip: string | null;
  country: string | null;
  org: string | null;
  checked_at: string;
  changed_at: string | null;
  drift: EnvironmentDrift;
  drift_note: string | null;
  samples: number;
}

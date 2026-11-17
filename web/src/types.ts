export interface AuthStatus {
  setupRequired: boolean;
  authed: boolean;
  version: string;
}

export interface AutomationPolicy {
  automation: 'allowed' | 'unknown' | 'prohibited';
  officialApi: boolean;
  termsUrl?: string;
  note: string;
  reviewedAt?: string;
}

export interface ProviderMeta {
  id: string;
  name: string;
  short: string;
  tint: string;
  description: string;
  primaryCookie: string | null;
  checkIn: boolean;
  policy: AutomationPolicy;
}

export interface CookieInfo {
  configured: boolean;
  fingerprint: string | null;
  length: number | null;
  fields: string[];
  updatedAt: string | null;
  expiresAt: string | null;
  expiresHint: string | null;
  checkedAt: string | null;
  verified: boolean;
  expired: boolean;
}

export interface AccountToday {
  status: string;
  credits: number | null;
  verified: boolean;
  runId: string | null;
  at: string;
  httpStatus: number | null;
}

export interface HealthScore {
  score: number;
  level: 'healthy' | 'watch' | 'at_risk' | 'invalid';
  label: string;
  reasons: string[];
}

export interface AccountDto {
  id: string;
  label: string;
  pluginId: string;
  provider: ProviderMeta;
  enabled: boolean;
  status: string;
  authSource: string;
  loginUrl: string | null;
  cookie: CookieInfo;
  scheduleTime: string | null;
  lastOkAt: string | null;
  lastRunAt: string | null;
  lastErrorCode: string | null;
  failStreak: number;
  balance: number | null;
  claimedToday: boolean | null;
  available: boolean | null;
  amount: number | null;
  resetAt: string | null;
  summaryAt: string | null;
  createdAt: string;
  updatedAt: string;
  health: HealthScore;
  canCheckIn: boolean;
  today: AccountToday | null;
}

export interface RunDto {
  id: string;
  trigger: string;
  localDate: string;
  status: string;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  preBalance: number | null;
  postBalance: number | null;
  creditsIssued: number | null;
  claimed: boolean | null;
  latencyMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  verified: boolean;
  evidence: Record<string, unknown>;
}

export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

export interface RunDetail {
  run: RunDto;
  events: RunEvent[];
}

export interface PluginDto {
  id: string;
  name: string;
  version: string;
  description: string;
  homepage?: string;
  source: string;
  enabled: boolean;
  checksum: string;
  auth: { type: string; primaryCookie: string; hintUrl?: string };
  permissions: { network: string[]; hooks?: boolean };
  schedule: {
    timezone: string;
    defaultTime: string;
    jitterSeconds: number;
    windowStart: string;
    windowEnd: string;
  };
  baseUrl: string;
  requests: {
    summary: { method: string; path: string };
    claim: { method: string; path: string };
  };
}

export interface DiscoverPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  permissions: string[];
  status: string;
}

export interface PluginsData {
  builtin: PluginDto[];
  installed: PluginDto[];
  discover: DiscoverPlugin[];
}

export interface Schedule {
  time: string;
  timezone: string;
  jitterSeconds: number;
  spreadSeconds: number;
  windowStart: string;
  windowEnd: string;
}

export interface CheckinStats {
  progressDone: number;
  progressTotal: number;
  scheduledEnabled: number;
  scheduledTotal: number;
  attention: number;
  records: number;
  credits30: number;
  accounts: number;
}

export interface CheckinTodayData {
  today: string;
  timezone: string;
  accounts: AccountDto[];
  stats: CheckinStats;
  nextRun: { label: string; date: string; time: string } | null;
}

export interface ProviderCatalogItem {
  id: string;
  name: string;
  short: string;
  tint: string;
  description: string;
  loginUrl: string | null;
  primaryCookie: string | null;
  checkIn: 'adapter' | 'none';
  category: 'agent' | 'custom';
  homepage?: string;
  hint?: string;
  adapterReady: boolean;
  accountCount: number;
  accounts: Array<{ id: string; label: string; status: string }>;
}

export interface ProvidersData {
  items: ProviderCatalogItem[];
}

export interface LoginSessionDto {
  id: string;
  providerId: string;
  provider: ProviderMeta;
  accountId: string | null;
  label: string;
  status: 'starting' | 'waiting' | 'ready' | 'captured' | 'expired' | 'failed' | 'closed';
  loginUrl: string | null;
  currentUrl: string | null;
  pageTitle: string | null;
  cookieNames: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CheckinRecordItem {
  accountId: string;
  label: string;
  provider: ProviderMeta;
  status: string;
  credits: number | null;
  verified: boolean;
  httpStatus: number | null;
  runId: string | null;
  at: string;
}

export interface CheckinRecordsData {
  days: number;
  summary: { records: number; credits: number; verified: number };
  groups: Array<{ date: string; credits: number; items: CheckinRecordItem[] }>;
}

export interface SettingsData {
  version: string;
  schedule: Schedule;
  keyFingerprint: string;
  cookieSecure: boolean;
  envPassword: boolean;
  environment: EnvironmentView;
  risk: {
    paused: boolean;
    strikeLimit: number;
    challengeRate: number;
    minSamples: number;
    openHours: number;
  };
  browser: {
    enabled: boolean;
    available: boolean;
    allowPrivate: boolean;
    sessionMinutes: number;
    executable: string;
  };
}

export interface AuditItem {
  id: number;
  at: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
}


export interface RolloutView {
  platformId: string;
  stage: 'open' | 'canary';
  canaryAccountId: string | null;
  canaryLabel: string | null;
  successDays: number;
  requiredDays: number;
  startedAt: string | null;
  note: string | null;
}

export interface EnvironmentView {
  ip: string | null;
  country: string | null;
  org: string | null;
  checkedAt: string | null;
  changedAt: string | null;
  drift: 'none' | 'minor' | 'major';
  note: string | null;
  samples: number;
  blocked: boolean;
  probing: boolean;
  lastError: string | null;
}

export interface RiskPlatform {
  platformId: string;
  name: string;
  state: 'closed' | 'open' | 'half_open';
  blocked: boolean;
  reason: string | null;
  openUntil: string | null;
  strikes: number;
  runs24h: number;
  challenges24h: number;
  challengeRate: number;
  accountCount: number;
  checkIn: boolean;
  policy: AutomationPolicy;
  policyAcknowledged: boolean;
  rollout: RolloutView;
}

export interface RiskOverview {
  paused: boolean;
  totals: {
    runs24h: number;
    challenges24h: number;
    rate: number;
    events24h: number;
  };
  platforms: RiskPlatform[];
  environment: EnvironmentView;
  generatedAt: string;
}

export interface RiskEventItem {
  id: number;
  at: string;
  platformId: string;
  platform: string;
  accountId: string | null;
  kind: string;
  detail: Record<string, unknown>;
}

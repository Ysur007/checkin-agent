import { config } from '../config.js';
import { getEnvironment, recordRiskEvent, saveEnvironment } from '../db/repo.js';
import { logger } from '../logger.js';
import type { EnvironmentDrift, EnvironmentRow } from '../types.js';

const PROBE_TIMEOUT_MS = 6000;

export interface EgressInfo {
  ip: string | null;
  country: string | null;
  /** 运营商 / ASN 描述，例如 "AS4134 Chinanet"。 */
  org: string | null;
}

export interface EnvironmentView {
  ip: string | null;
  country: string | null;
  org: string | null;
  checkedAt: string | null;
  changedAt: string | null;
  drift: EnvironmentDrift;
  note: string | null;
  samples: number;
  /** 是否因环境突变而暂停自动调度。 */
  blocked: boolean;
  probing: boolean;
  lastError: string | null;
}

let probing = false;
let lastError: string | null = null;

function asnOf(org: string | null): string | null {
  if (!org) return null;
  const match = org.match(/\bAS\d+\b/i);
  return match ? match[0].toUpperCase() : org.trim().slice(0, 24);
}

function parseProbe(text: string): EgressInfo | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const ip = typeof json.ip === 'string' ? json.ip : null;
      if (!ip) return null;
      const country =
        typeof json.country === 'string'
          ? json.country
          : typeof json.country_code === 'string'
            ? json.country_code
            : null;
      const org = typeof json.org === 'string' ? json.org : null;
      return { ip, country: country ? country.toUpperCase() : null, org };
    } catch {
      return null;
    }
  }

  // Cloudflare trace 形式的 key=value 文本
  const map = new Map<string, string>();
  for (const line of trimmed.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) map.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const ip = map.get('ip') ?? null;
  if (!ip) return null;
  return { ip, country: map.get('loc') ?? null, org: null };
}

/** 只读探测出口 IP；失败返回 null，不抛异常、不影响签到。 */
export async function probeEgress(): Promise<EgressInfo | null> {
  if (!config.egressProbe) return null;
  probing = true;
  try {
    const response = await fetch(config.egressProbeUrl, {
      headers: { accept: 'application/json, text/plain;q=0.9', 'user-agent': 'checkin-agent/egress-probe' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) {
      lastError = `探测返回 HTTP ${response.status}`;
      return null;
    }
    const info = parseProbe(await response.text());
    if (!info) {
      lastError = '探测响应无法解析';
      return null;
    }
    lastError = null;
    return info;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    probing = false;
  }
}

export function classifyDrift(previous: EnvironmentRow | undefined, next: EgressInfo): EnvironmentDrift {
  if (!previous || !previous.ip) return 'none';
  if (previous.ip === next.ip) {
    if (previous.country && next.country && previous.country !== next.country) return 'major';
    if (asnOf(previous.org) && asnOf(next.org) && asnOf(previous.org) !== asnOf(next.org)) return 'major';
    return 'none';
  }
  if (previous.country && next.country && previous.country !== next.country) return 'major';
  const prevAsn = asnOf(previous.org);
  const nextAsn = asnOf(next.org);
  if (prevAsn && nextAsn && prevAsn !== nextAsn) return 'major';
  return 'minor';
}

function describe(previous: EnvironmentRow | undefined, next: EgressInfo): string {
  const before = [previous?.ip, previous?.country, asnOf(previous?.org ?? null)].filter(Boolean).join(' / ');
  const after = [next.ip, next.country, asnOf(next.org)].filter(Boolean).join(' / ');
  return `${before || '未知出口'} → ${after || '未知出口'}`;
}

export interface RefreshResult {
  info: EgressInfo | null;
  drift: EnvironmentDrift;
  note: string | null;
}

/**
 * 刷新出口基线。
 * - minor：同地区 IP 变动，更新基线，只记录事件；
 * - major：地区或运营商变化，保留旧基线并阻止自动调度，直到用户确认。
 */
export async function refreshEnvironment(): Promise<RefreshResult> {
  const info = await probeEgress();
  if (!info) return { info: null, drift: 'none', note: lastError };

  const previous = getEnvironment();
  const drift = classifyDrift(previous, info);
  const note = drift === 'none' ? null : describe(previous, info);

  if (drift === 'major') {
    saveEnvironment({
      ip: previous?.ip ?? info.ip,
      country: previous?.country ?? info.country,
      org: previous?.org ?? info.org,
      changedAt: new Date().toISOString(),
      drift,
      driftNote: note,
      samples: (previous?.samples ?? 0) + 1,
    });
    recordRiskEvent({ platformId: 'system', kind: 'environment_drift', detail: { from: previous?.ip, to: info.ip, note } });
    logger.warn({ note }, 'egress environment changed');
    return { info, drift, note };
  }

  saveEnvironment({
    ip: info.ip,
    country: info.country,
    org: info.org,
    changedAt: drift === 'minor' ? new Date().toISOString() : (previous?.changed_at ?? null),
    drift,
    driftNote: note,
    samples: (previous?.samples ?? 0) + 1,
  });
  if (drift === 'minor') {
    recordRiskEvent({ platformId: 'system', kind: 'environment_shift', detail: { from: previous?.ip, to: info.ip, note } });
  }
  return { info, drift, note };
}

/** 用户确认环境变化：把当前出口写为新基线并解除自动调度限制。 */
export async function ackEnvironment(): Promise<EnvironmentView> {
  const info = await probeEgress();
  const previous = getEnvironment();
  if (info) {
    saveEnvironment({
      ip: info.ip,
      country: info.country,
      org: info.org,
      changedAt: new Date().toISOString(),
      drift: 'none',
      driftNote: null,
      samples: (previous?.samples ?? 0) + 1,
    });
    recordRiskEvent({ platformId: 'system', kind: 'environment_ack', detail: { from: previous?.ip, to: info.ip } });
  }
  return getEnvironmentView();
}

export function getEnvironmentView(): EnvironmentView {
  const row = getEnvironment();
  return {
    ip: row?.ip ?? null,
    country: row?.country ?? null,
    org: row?.org ?? null,
    checkedAt: row?.checked_at ?? null,
    changedAt: row?.changed_at ?? null,
    drift: row?.drift ?? 'none',
    note: row?.drift_note ?? null,
    samples: row?.samples ?? 0,
    blocked: (row?.drift ?? 'none') === 'major',
    probing,
    lastError,
  };
}

export function isEnvironmentBlocked(): boolean {
  return getEnvironment()?.drift === 'major';
}

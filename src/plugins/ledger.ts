import type { LedgerSpec } from '../types.js';
import { getPath } from './jsonpath.js';

export interface LedgerDerived {
  /** 账单里是否有「今天已到账」的记录 */
  claimedToday: boolean;
  /** 今天符合规则的到账总额 */
  credits: number;
  /** 命中的记录条数 */
  matched: number;
  /** 账单里一共读了多少条记录（用于区分「没领」和「读不到」） */
  scanned: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function amount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

/**
 * 从流水里推导「今天是否已到账、到账多少」。
 *
 * 平台不提供布尔值时，账单是唯一可信证据：只认当天、type=EARN、rule_key 在白名单里的记录。
 * 只要读不到记录数组就抛错，避免把「读不到」误判成「没领」。
 */
export function deriveLedger(spec: LedgerSpec, payload: unknown, today: string): LedgerDerived {
  const candidates = Array.isArray(spec.records) ? spec.records : [spec.records];
  let records: unknown;
  for (const path of candidates) {
    const value = getPath(payload, path);
    if (Array.isArray(value)) {
      records = value;
      break;
    }
  }
  if (!Array.isArray(records)) {
    throw new Error(`ledger records not found at ${candidates.join(' / ')}`);
  }

  const ruleKeys = new Set(spec.ruleKeys.map((key) => key.toLowerCase()));
  let credits = 0;
  let matched = 0;

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const row = record as Record<string, unknown>;
    if (text(row[spec.dateField]).slice(0, 10) !== today) continue;
    if (spec.typeField && spec.typeValue !== undefined) {
      if (text(row[spec.typeField]).toUpperCase() !== spec.typeValue.toUpperCase()) continue;
    }
    const ruleKey = text(row.rule_key ?? row.ruleKey ?? row.rulekey).toLowerCase();
    if (ruleKeys.size > 0 && !ruleKeys.has(ruleKey)) continue;
    matched += 1;
    if (spec.amountField) credits += amount(row[spec.amountField]);
  }

  return { claimedToday: matched > 0, credits, matched, scanned: records.length };
}

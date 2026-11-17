import type { RunStatus } from '../types.js';

export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'ORIGIN_BLOCKED'
  | 'CHALLENGE_DETECTED'
  | 'RATE_LIMITED'
  | 'HTTP_5XX'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PARSE_ERROR'
  | 'SCHEMA_MISMATCH'
  | 'CLAIM_REJECTED'
  | 'VERIFY_MISMATCH'
  | 'NOT_AVAILABLE'
  | 'COOKIE_MISSING'
  | 'LOCK_HELD'
  | 'PLUGIN_INVALID'
  | 'INTERNAL';

export interface RunnerError {
  code: ErrorCode;
  message: string;
  httpStatus?: number;
  retryable?: boolean;
}

export const ERROR_STATUS: Record<ErrorCode, RunStatus> = {
  AUTH_REQUIRED: 'needs_reauth',
  ORIGIN_BLOCKED: 'failed',
  CHALLENGE_DETECTED: 'needs_reauth',
  RATE_LIMITED: 'rate_limited',
  HTTP_5XX: 'failed',
  HTTP_ERROR: 'failed',
  TIMEOUT: 'failed',
  NETWORK: 'failed',
  PARSE_ERROR: 'failed',
  SCHEMA_MISMATCH: 'unverified',
  CLAIM_REJECTED: 'failed',
  VERIFY_MISMATCH: 'unverified',
  NOT_AVAILABLE: 'skipped',
  COOKIE_MISSING: 'failed',
  LOCK_HELD: 'failed',
  PLUGIN_INVALID: 'failed',
  INTERNAL: 'failed',
};

export function friendlyMessage(code: ErrorCode, raw: string): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Cookie 无效或已过期，请在平台详情里更新 Cookie。';
    case 'CHALLENGE_DETECTED':
      return '平台返回了登录页/验证码/风控挑战，已停止。请人工处理后更新 Cookie。';
    case 'ORIGIN_BLOCKED':
      return '请求被平台拒绝：Origin/Referer 不在允许范围内（适配器配置问题）。';
    case 'RATE_LIMITED':
      return '平台限流，已停止本次请求；稍后再试。';
    case 'HTTP_ERROR':
      return '平台返回了意外的 HTTP 状态。';
    case 'SCHEMA_MISMATCH':
      return '平台响应缺少预期字段，可能已改版；本次结果未验证。';
    case 'CLAIM_REJECTED':
      return '平台明确拒绝了领取请求。';
    case 'VERIFY_MISMATCH':
      return '领取接口声称成功，但 summary 未确认余额/今日状态，本次标记为未验证。';
    case 'NOT_AVAILABLE':
      return '当前没有可领取额度（可能未到重置时间或账号不参与）。';
    case 'COOKIE_MISSING':
      return '还没有保存 Cookie。';
    case 'LOCK_HELD':
      return '该账号已有任务在运行。';
    default:
      return raw;
  }
}

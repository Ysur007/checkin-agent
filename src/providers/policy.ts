export type AutomationLevel = 'allowed' | 'unknown' | 'prohibited';

export interface AutomationPolicy {
  /** allowed：条款允许或有明确授权；unknown：需用户自行核对；prohibited：禁止执行签到。 */
  automation: AutomationLevel;
  /** 平台是否提供公开、可申请的官方接口。 */
  officialApi: boolean;
  termsUrl?: string;
  note: string;
  reviewedAt?: string;
}

const POLICIES: Record<string, AutomationPolicy> = {
  breezeblue: {
    automation: 'unknown',
    officialApi: false,
    termsUrl: 'https://breezeblue.ai',
    note: '使用网页端 summary / daily-claim 接口，未见公开的自动化授权说明；请自行核对服务条款后再执行。',
  },
  demo: {
    automation: 'allowed',
    officialApi: false,
    note: '本地联调平台，仅用于验证链路。',
    reviewedAt: '2026-11-17',
  },
};

const DEFAULT_POLICY: AutomationPolicy = {
  automation: 'unknown',
  officialApi: false,
  note: '未收录该平台的自动化条款；默认按“待确认”处理，只做低频执行。',
};

export function getAutomationPolicy(platformId: string): AutomationPolicy {
  return POLICIES[platformId] ?? DEFAULT_POLICY;
}

export function listAutomationPolicies(): Array<{ platformId: string; policy: AutomationPolicy }> {
  return Object.entries(POLICIES).map(([platformId, policy]) => ({ platformId, policy }));
}

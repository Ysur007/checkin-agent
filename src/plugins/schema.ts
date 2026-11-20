import { z } from 'zod';

const httpsUrl = z.string().url().refine((value) => value.startsWith('https://'), 'must be https');

export const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),
    name: z.string().min(1).max(60),
    version: z.string().min(1).max(30),
    author: z.string().max(60).optional(),
    homepage: httpsUrl.optional(),
    description: z.string().min(1).max(300),
    license: z.string().max(40).optional(),
    auth: z.object({
      type: z.literal('cookie'),
      primaryCookie: z.string().min(1).max(80),
      hintUrl: httpsUrl.optional(),
    }),
    permissions: z.object({
      network: z.array(httpsUrl).min(1),
      hooks: z.boolean().optional(),
    }),
    schedule: z.object({
      timezone: z.string().min(1),
      defaultTime: z.string().regex(/^\d{2}:\d{2}$/),
      jitterSeconds: z.number().int().min(0).max(3600),
      windowStart: z.string().regex(/^\d{2}:\d{2}$/),
      windowEnd: z.string().regex(/^\d{2}:\d{2}$/),
    }),
    limits: z.object({
      timeoutMs: z.number().int().min(1000).max(120000),
      maxAttempts: z.number().int().min(1).max(5),
    }),
  })
  .strict();

export const RequestSchema = z
  .object({
    method: z.enum(['GET', 'POST']),
    path: z.string().startsWith('/').max(300),
    body: z.unknown().optional(),
  })
  .strict();

export const ErrorRuleSchema = z
  .object({
    status: z.array(z.number().int().min(100).max(599)).optional(),
    statusMin: z.number().int().min(100).max(599).optional(),
    bodyCode: z.string().max(80).optional(),
    messageIncludes: z.string().max(200).optional(),
    contentTypeIncludes: z.string().max(80).optional(),
    error: z.string().min(1).max(80),
    retry: z.boolean().optional(),
  })
  .strict();

export const RuleSchema = z
  .object({
    source: z.enum(['summary', 'claim', 'verify']),
    field: z.string().min(1).max(80),
    op: z.enum(['eq', 'neq', 'truthy', 'falsy', 'gte', 'lte', 'includes']),
    value: z.unknown().optional(),
    result: z.string().min(1).max(80),
  })
  .strict();

const ExtractValue = z.union([z.string().max(200), z.array(z.string().max(200)).min(1).max(6)]);

const LedgerSchema = z
  .object({
    records: z.union([z.string().max(200), z.array(z.string().max(200)).min(1).max(4)]),
    dateField: z.string().min(1).max(80),
    typeField: z.string().min(1).max(80).optional(),
    typeValue: z.string().min(1).max(80).optional(),
    ruleKeys: z.array(z.string().min(1).max(80)).max(20),
    amountField: z.string().min(1).max(80).optional(),
    timezone: z.string().min(1).max(60).optional(),
  })
  .strict();

export const AdapterSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseUrl: httpsUrl,
    defaultHeaders: z.record(z.string().max(500)),
    requests: z.object({
      summary: RequestSchema,
      // 有些平台没有独立的签到按钮，claim 只负责「触发」，甚至可以省略。
      claim: RequestSchema.optional(),
      verify: RequestSchema.optional(),
    }),
    extract: z.object({
      summary: z.record(ExtractValue),
      claim: z.record(ExtractValue),
      verify: z.record(ExtractValue).optional(),
    }),
    ledger: LedgerSchema.optional(),
    rules: z.object({
      preflight: z.array(RuleSchema),
      claim: z.array(RuleSchema),
      verify: z.array(RuleSchema),
    }),
    errors: z.array(ErrorRuleSchema).min(1),
    retry: z.object({
      maxAttempts: z.number().int().min(1).max(5),
      backoffMs: z.array(z.number().int().min(0).max(60000)).min(1).max(5),
    }),
  })
  .strict();

export type ManifestInput = z.infer<typeof ManifestSchema>;
export type AdapterInput = z.infer<typeof AdapterSchema>;

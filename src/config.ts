import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((value) => value === '1' || value === 'true');

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATA_DIR: z.string().default('./data'),
  APP_KEY: z.string().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  TZ: z.string().default('Asia/Shanghai'),
  LOG_LEVEL: z.string().default('info'),
  COOKIE_SECURE: bool,
  EGRESS_PROBE: z.string().optional().default('1'),
  /** 首次初始化时把自动化设为暂停，用于"装好后先观察"的部署方式。 */
  AUTOMATION_PAUSED: bool,
  EGRESS_PROBE_URL: z.string().optional().default('https://ipinfo.io/json'),
});

const raw = schema.parse(process.env);
const dataDir = path.resolve(raw.DATA_DIR);

fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  version: '0.2.7',
  port: raw.PORT,
  dataDir,
  dbPath: path.join(dataDir, 'checkin.db'),
  appKey: raw.APP_KEY,
  adminPassword: raw.ADMIN_PASSWORD,
  timezone: raw.TZ,
  logLevel: raw.LOG_LEVEL,
  cookieSecure: raw.COOKIE_SECURE,
  webDist: path.resolve(process.cwd(), 'dist/web'),
  pluginDir: path.resolve(process.cwd(), 'plugins'),
  dataPluginDir: path.join(dataDir, 'plugins'),
  sessionDays: 30,
  egressProbe: raw.EGRESS_PROBE !== '0',
  automationPaused: raw.AUTOMATION_PAUSED,
  egressProbeUrl: raw.EGRESS_PROBE_URL,
} as const;

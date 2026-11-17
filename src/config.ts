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
  BROWSER_LOGIN: z.string().optional().default('1'),
  LOGIN_ALLOW_PRIVATE: bool,
  PLAYWRIGHT_CHROMIUM_PATH: z.string().optional(),
});

const raw = schema.parse(process.env);
const dataDir = path.resolve(raw.DATA_DIR);

fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  version: '0.2.0',
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
  browserLogin: raw.BROWSER_LOGIN !== '0',
  loginAllowPrivate: raw.LOGIN_ALLOW_PRIVATE,
  chromiumPath: raw.PLAYWRIGHT_CHROMIUM_PATH || '',
  loginSessionMinutes: 12,
  profileDir: path.join(dataDir, 'profiles'),
} as const;

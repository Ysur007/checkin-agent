#!/usr/bin/env node
/**
 * 本机浏览器登录助手。
 *
 * 在你自己电脑上打开真实的 Edge / Chrome 完成登录，登录成功后读取该站点的 Cookie，
 * 通过一次性配对码回传给 NAS 上的签到执行台。服务端不运行浏览器，也不保存任何
 * 明文凭据到日志。
 *
 * 用法：
 *   npm run login:local -- --host http://192.168.31.143:8787 --code ABCD-1234
 *
 * 可选：
 *   --browser edge|chrome|chromium   指定浏览器，默认依次尝试 edge → chrome
 *   --profile <dir>                  浏览器配置目录，默认 ~/.checkin-agent/profiles/<平台>
 *   --timeout <seconds>              等待登录的最长时间，默认 600
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const out = { browser: '', profile: '', timeout: 600 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') out.host = argv[++i];
    else if (arg === '--code') out.code = argv[++i];
    else if (arg === '--browser') out.browser = String(argv[++i] ?? '').toLowerCase();
    else if (arg === '--profile') out.profile = argv[++i];
    else if (arg === '--timeout') out.timeout = Number(argv[++i] ?? 600);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.host || !args.code) {
  console.log(`
本机浏览器登录助手

  npm run login:local -- --host <控制台地址> --code <配对码>

示例：
  npm run login:local -- --host http://192.168.31.143:8787 --code ABCD-1234

配对码在控制台的「账号 → 本机登录」里生成，10 分钟内有效、只能用一次。
`);
  process.exit(args.help ? 0 : 1);
}

const host = String(args.host).replace(/\/+$/, '');
const code = String(args.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
const waitMs = Math.max(60, Number(args.timeout) || 600) * 1000;

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${host}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

async function claim() {
  const result = await api(`/api/pair/${code}`);
  if (result.status !== 200) {
    const message = result.body?.error?.message ?? `HTTP ${result.status}`;
    throw new Error(`配对码不可用：${message}`);
  }
  return result.body;
}

function domainMatches(cookieDomain, allowed) {
  const domain = String(cookieDomain ?? '').replace(/^\./, '').toLowerCase();
  return allowed.some((entry) => {
    const target = String(entry).replace(/^\./, '').toLowerCase();
    return domain === target || domain.endsWith(`.${target}`);
  });
}

function buildCookieHeader(cookies, domains) {
  const now = Math.floor(Date.now() / 1000);
  return cookies
    .filter((cookie) => cookie.value && (!cookie.expires || cookie.expires <= 0 || cookie.expires > now))
    .filter((cookie) => (domains.length === 0 ? true : domainMatches(cookie.domain, domains)))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function resolveExecutable(browser) {
  if (browser === 'edge') return 'msedge';
  if (browser === 'chrome') return 'chrome';
  if (browser === 'chromium') return 'chromium';
  return '';
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    log('缺少 playwright-core。先在项目目录执行一次：');
    log('  npm install --no-audit --no-fund');
    process.exit(1);
  }
}

async function main() {
  log(`控制台：${host}`);
  const info = await claim();
  log(`账号：${info.accountLabel}（${info.provider.name}）`);
  if (!info.provider.loginUrl) {
    throw new Error('这个平台还没有配置登录页地址，请先在控制台补充');
  }

  const { chromium } = await loadPlaywright();
  const profileDir =
    args.profile || path.join(os.homedir(), '.checkin-agent', 'profiles', String(info.provider.id));
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const channels = args.browser ? [resolveExecutable(args.browser)] : ['msedge', 'chrome'];
  let context = null;
  let lastError = null;
  for (const channel of channels) {
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel,
        headless: false,
        viewport: { width: 1280, height: 900 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        acceptDownloads: false,
      });
      log(`已用系统浏览器打开（${channel}）`);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!context) {
    throw new Error(
      `无法启动本机浏览器，请确认已安装 Edge 或 Chrome。底层错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(info.provider.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {
    log('页面加载较慢，继续等待……');
  });

  log('');
  log('请在弹出的浏览器里完成登录（验证码、二次验证都由你自己操作）。');
  log(`检测到 ${info.provider.primaryCookie ?? '登录 Cookie'} 后会自动回传并关闭窗口。`);
  log('');

  const primary = info.provider.primaryCookie;
  const deadline = Date.now() + waitMs;
  let detected = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (page.isClosed() && context.pages().length === 0) break;
    const cookies = await context.cookies().catch(() => []);
    const names = cookies.map((cookie) => cookie.name);
    if (primary ? names.includes(primary) : names.length > 0) {
      log(`检测到登录 Cookie：${primary ?? names.slice(0, 3).join('、')}`);
      detected = true;
      break;
    }
  }

  if (!detected) {
    log('等待超时，没有检测到登录态。窗口保留，你可以关掉后重新运行。');
    await context.close().catch(() => undefined);
    process.exit(2);
  }

  // 给页面一点时间写完剩余 Cookie（登录跳转常有第二次 Set-Cookie）
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const cookies = await context.cookies();
  const header = buildCookieHeader(cookies, info.provider.cookieDomains ?? []);
  if (!header) {
    log('没有读到可用的 Cookie，请确认登录已完成。');
    await context.close().catch(() => undefined);
    process.exit(3);
  }

  let token = info.token;
  let result = await api('/api/pair/cookie', {
    method: 'POST',
    body: JSON.stringify({ token, cookie: header }),
  });

  // 令牌只有 5 分钟，登录久了会过期；用配对码再换一次再提交。
  if (result.status === 401) {
    const again = await claim();
    token = again.token;
    result = await api('/api/pair/cookie', {
      method: 'POST',
      body: JSON.stringify({ token, cookie: header }),
    });
  }

  await context.close().catch(() => undefined);

  if (result.status !== 200) {
    log('');
    log(`回传失败：${result.body?.error?.message ?? `HTTP ${result.status}`}`);
    log('窗口已关闭，你可以在控制台里重试，或改用「手动 Cookie」。');
    process.exit(4);
  }

  const account = result.body?.account;
  log('');
  log('已保存并加密。');
  log(`  账号：${account?.label ?? info.accountLabel}`);
  log(`  字段：${(account?.cookie?.fields ?? []).join(', ') || '—'}`);
  log(`  指纹：${account?.cookie?.fingerprint ?? '—'}`);
  log(`  校验：${account?.cookie?.verified ? '通过（服务端只读 summary 已确认）' : '已保存，但未通过平台校验'}`);
  if (result.body?.warning) log(`  提示：${result.body.warning}`);
  log('');
  log('回到控制台刷新即可看到状态。');
}

main().catch((error) => {
  log(`出错了：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

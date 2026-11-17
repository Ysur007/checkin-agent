import 'dotenv/config';
import fs from 'node:fs';
import { loadBuiltinPlugins } from '../plugins/loader.js';
import { requestWithRetry } from '../runner/http.js';
import { extractFields } from '../plugins/jsonpath.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const plugins = loadBuiltinPlugins();
  const plugin = plugins.find((item) => item.id === 'breezeblue');
  if (!plugin) {
    console.error('BreezeBlue plugin not found under ./plugins/breezeblue');
    process.exitCode = 1;
    return;
  }

  const cookieFile = arg('--cookie-file');
  const inline = arg('--cookie') ?? process.env.BREEZE_COOKIE;
  let cookie = inline ?? '';
  if (cookieFile) {
    cookie = fs.readFileSync(cookieFile, 'utf8').trim();
  }
  if (/^cookie\s*:/i.test(cookie)) cookie = cookie.replace(/^cookie\s*:/i, '').trim();

  if (!cookie) {
    console.error('Usage: npm run probe -- --cookie-file ./cookie.txt');
    console.error('The probe only calls GET /api/credits/summary. It never claims. Do not paste cookies into chat.');
    process.exitCode = 2;
    return;
  }

  const result = await requestWithRetry(plugin, 'summary', cookie, plugin.manifest.limits.timeoutMs);
  if (result.error) {
    console.log(
      JSON.stringify(
        { ok: false, code: result.error.code, message: result.error.message, httpStatus: result.error.httpStatus },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (!result.result) {
    console.log(JSON.stringify({ ok: false, code: 'EMPTY_RESPONSE' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const summary = extractFields(result.result.json, plugin.adapter.extract.summary);
  console.log(
    JSON.stringify(
      {
        ok: true,
        httpStatus: result.result.status,
        latencyMs: result.result.latencyMs,
        requestId: result.result.requestId,
        balance: summary.balance ?? null,
        claimedToday: summary.claimedToday ?? null,
        available: summary.available ?? null,
        amount: summary.amount ?? null,
        resetAt: summary.resetAt ?? null,
      },
      null,
      2,
    ),
  );
}

main();

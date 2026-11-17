import 'dotenv/config';
import { config } from './config.js';
import { logger } from './logger.js';
import { loadAppKey } from './crypto/appKey.js';
import { db } from './db/index.js';
import { getSetting, setAutomationPaused, upsertPlugin } from './db/repo.js';
import { loadBuiltinPlugins } from './plugins/loader.js';
import { ClaimRunner } from './runner/claimRunner.js';
import { startScheduler } from './scheduler/scheduler.js';
import { createApp } from './api.js';
import { createLoginManager } from './login/manager.js';
import { sweepAccountHealth } from './accounts/health.js';
import { refreshEnvironment } from './risk/environment.js';

async function main(): Promise<void> {
  const appKey = loadAppKey(config.dataDir, config.appKey);
  logger.info(
    { dataDir: config.dataDir, keyFingerprint: appKey.fingerprint, keySource: appKey.source },
    'starting checkin-agent',
  );

  const plugins = loadBuiltinPlugins();
  for (const plugin of plugins) upsertPlugin(plugin);
  if (plugins.length === 0) {
    logger.warn({ pluginDir: config.pluginDir }, 'no builtin plugins loaded');
  }

  // 首次初始化时按环境变量决定是否以暂停状态启动；之后以控制台设置为准。
  if (config.automationPaused && getSetting<boolean | undefined>('automationPaused', undefined) === undefined) {
    setAutomationPaused(true);
    logger.info('automation initialised as paused (AUTOMATION_PAUSED=1)');
  }

  const runner = new ClaimRunner(appKey.key);
  const login = createLoginManager();
  const app = await createApp({
    runner,
    login,
    appKey: appKey.key,
    keyFingerprint: appKey.fingerprint,
  });

  const stopScheduler = startScheduler(runner);

  // 出口探测：启动后先取一次基线，之后每小时刷新；失败只记日志，不影响签到。
  const probeEnvironment = () => {
    void refreshEnvironment()
      .then((result) => {
        if (result.drift !== 'none') logger.warn(result, 'egress environment drift detected');
      })
      .catch((error) => logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'egress probe failed'));
  };
  const bootProbe = setTimeout(probeEnvironment, 4_000);
  bootProbe.unref();
  const envTimer = setInterval(probeEnvironment, 60 * 60_000);
  envTimer.unref();

  const healthTimer = setInterval(() => {
    void sweepAccountHealth(appKey.key)
      .then((result) => {
        if (result.checked || result.expired || result.needsReauth) {
          logger.info(result, 'cookie health sweep finished');
        }
      })
      .catch((error) => logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'health sweep failed'));
  }, 30 * 60_000);
  healthTimer.unref();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info({ port: config.port, plugins: plugins.map((plugin) => plugin.id) }, 'console is ready');

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    stopScheduler();
    clearInterval(healthTimer);
    clearInterval(envTimer);
    clearTimeout(bootProbe);
    await login.shutdown().catch(() => undefined);
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
}

main().catch((error) => {
  logger.fatal({ error: error instanceof Error ? error.message : String(error) }, 'failed to start');
  process.exit(1);
});

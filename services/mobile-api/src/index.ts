/** Process entry point: load config, report findings, start, shut down cleanly. */
import { formatFindings, hasBlockingFindings, loadConfig } from './config/env.ts';
import { validateRoleMapping } from './auth/roles.ts';
import { buildServices } from './services.ts';
import { buildApp } from './app.ts';
import { SERVER_VERSION } from './version.ts';

async function main(): Promise<void> {
  const { config, findings } = loadConfig();

  // The startup banner names every missing or suspicious setting by key.
  // It never prints a value.
  for (const line of formatFindings(findings)) {
    console[line.includes('[config:error]') ? 'error' : 'warn'](line);
  }

  for (const problem of validateRoleMapping(config.roles)) {
    console.warn(`[config:warn] ROLE_*_GROUPS — ${problem}`);
  }

  if (hasBlockingFindings(findings)) {
    console.error(
      '\nRefusing to start: the settings above are required in production. ' +
        'See .env.example for the required configuration keys.',
    );
    process.exit(1);
  }

  const services = buildServices(config);
  const app = await buildApp(services);

  // Periodic housekeeping; cheap and keeps the auth tables bounded.
  const purgeTimer = setInterval(
    () => {
      try {
        const removed = services.sessions.purgeExpired();
        const total = Object.values(removed).reduce((sum, count) => sum + count, 0);
        if (total > 0) app.log.info({ removed, total }, 'expired gateway state purged');
      } catch (error) {
        app.log.error({ err: error }, 'expired gateway state purge failed');
      }
    },
    10 * 60 * 1000,
  );
  purgeTimer.unref();

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      version: SERVER_VERSION,
      environment: config.env,
      orionis: config.orionis.configured,
      adguard: config.adguard.configured,
      oidc: config.oidc.configured,
      push: config.apns.configured,
    },
    'Orionis Control mobile API gateway started',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(purgeTimer);
    await app.close();
    services.db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

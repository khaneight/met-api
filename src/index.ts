import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp({
  config,
  logger: {
    level: config.LOG_LEVEL,
    // pino-pretty is a devDependency, so never load it in production.
    ...(process.env.NODE_ENV !== 'production' && process.stdout.isTTY && { transport: { target: 'pino-pretty' } }),
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}

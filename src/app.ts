import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import { AppError, UpstreamRateLimitedError } from './errors.js';
import { RedisCache, type RemoteCache } from './lib/remote-cache.js';
import { MetClient } from './met/client.js';
import { registerWorksRoutes } from './works/routes.js';
import { RecentWorksService } from './works/service.js';

export interface AppOptions {
  config: Config;
  logger?: FastifyServerOptions['logger'];
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable for tests; otherwise created from REDIS_URL when set. */
  remoteCache?: RemoteCache;
}

export function buildApp({ config, logger = true, fetch, remoteCache }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  const remote =
    remoteCache ??
    (config.REDIS_URL ? new RedisCache(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX, logger: app.log }) : undefined);
  // Only close what we created; an injected cache belongs to the caller.
  if (remote && !remoteCache) app.addHook('onClose', () => remote.close());
  app.log.info({ remoteCache: remote ? 'redis' : 'none' }, 'cache configuration');

  const met = new MetClient({
    baseUrl: config.MET_BASE_URL,
    timeoutMs: config.MET_TIMEOUT_MS,
    maxRetries: config.MET_MAX_RETRIES,
    maxConcurrency: config.MET_MAX_CONCURRENCY,
    minRequestIntervalMs: config.MET_MIN_REQUEST_INTERVAL_MS,
    searchCacheTtlMs: config.SEARCH_CACHE_TTL_MS,
    objectCacheTtlMs: config.OBJECT_CACHE_TTL_MS,
    logger: app.log,
    ...(fetch && { fetch }),
    ...(remote && { remoteCache: remote }),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  // Demo UI: a single static page. Same relative path from src/ and dist/.
  const indexHtml = new URL('../public/index.html', import.meta.url);
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(await readFile(indexHtml)));
  registerWorksRoutes(app, new RecentWorksService(met));

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found`, requestId: request.id },
    });
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      const log = err.statusCode >= 500 ? request.log.warn : request.log.info;
      log.call(request.log, { err }, err.message);
      if (err instanceof UpstreamRateLimitedError) reply.header('retry-after', String(err.retryAfterSeconds));
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          requestId: request.id,
          ...(err.details !== undefined && { details: err.details }),
        },
      });
    }

    // Fastify's own client errors (e.g. malformed requests) carry a 4xx status.
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: 'BAD_REQUEST', message: (err as Error).message, requestId: request.id },
      });
    }

    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id },
    });
  });

  return app;
}

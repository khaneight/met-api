import type { FastifyBaseLogger } from 'fastify';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * A shared, persistent second-tier cache (e.g. Redis) behind the in-process
 * LRU. Implementations may throw; callers treat any failure as a cache miss.
 */
export interface RemoteCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface RedisCacheOptions {
  /** Prepended to every key. Bump its version when cached value shapes change. */
  keyPrefix: string;
  logger: FastifyBaseLogger;
}

/**
 * Redis-backed RemoteCache storing JSON values with a per-key TTL.
 *
 * Tuned to fail fast rather than queue: when Redis is unreachable, commands
 * reject immediately (no offline queue, one attempt, short timeout) so a
 * request falls through to the Met instead of hanging on the cache.
 */
export class RedisCache implements RemoteCache {
  private readonly redis: Redis;
  private state: 'connecting' | 'up' | 'down' = 'connecting';

  constructor(
    target: string | Redis,
    private readonly opts: RedisCacheOptions,
  ) {
    this.redis = typeof target === 'string' ? new Redis(target, FAIL_FAST) : target;

    // Log state transitions once each, not every reconnect attempt, but always
    // surface the first failure so a bad REDIS_URL doesn't go unnoticed.
    this.redis.on('ready', () => {
      this.state = 'up';
      opts.logger.info('redis cache connected');
    });
    this.redis.on('error', (err: Error) => {
      if (this.state === 'down') return;
      this.state = 'down';
      opts.logger.warn({ err: err.message }, 'redis cache unavailable; serving from memory + upstream');
    });
  }

  async get(key: string): Promise<unknown> {
    const raw = await this.redis.get(this.opts.keyPrefix + key);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.redis.set(this.opts.keyPrefix + key, JSON.stringify(value), 'PX', ttlMs);
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

const FAIL_FAST: RedisOptions = {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  connectTimeout: 1_000,
  commandTimeout: 500,
  // Keep reconnecting in the background, backing off up to 5s.
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
};

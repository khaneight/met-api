import type { FastifyBaseLogger } from 'fastify';
import { LRUCache } from 'lru-cache';
import type { RemoteCache } from './remote-cache.js';

export interface CachedLoaderOptions {
  max: number;
  ttlMs: number;
  /** Optional shared second tier, consulted on local misses. */
  remote?: {
    cache: RemoteCache;
    /** Namespaces this loader's keys within the remote cache. */
    namespace: string;
    logger: FastifyBaseLogger;
  };
}

/**
 * Memoizes an async loader with an LRU+TTL cache and coalesces concurrent
 * calls for the same key into a single in-flight load. Failures are not cached.
 *
 * With a remote cache configured, lookups go local LRU → remote → loader, and
 * loaded values are written to both tiers. The remote tier is best-effort:
 * any error reading or writing it is logged and treated as a miss.
 */
export class CachedLoader<K extends string | number, V extends {}> {
  private readonly cache: LRUCache<K, V>;
  private readonly inFlight = new Map<K, Promise<V>>();

  constructor(
    private readonly load: (key: K) => Promise<V>,
    private readonly options: CachedLoaderOptions,
  ) {
    this.cache = new LRUCache<K, V>({ max: options.max, ttl: options.ttlMs });
  }

  get(key: K): Promise<V> {
    const cached = this.cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = this.loadThroughRemote(key)
      .then((value) => {
        this.cache.set(key, value);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async loadThroughRemote(key: K): Promise<V> {
    const remote = this.options.remote;
    if (!remote) return this.load(key);

    const remoteKey = `${remote.namespace}:${key}`;
    try {
      // Values are only ever written by this loader under a versioned prefix,
      // so they are trusted to have shape V.
      const hit = await remote.cache.get(remoteKey);
      if (hit !== undefined) return hit as V;
    } catch (err) {
      remote.logger.debug({ err: (err as Error).message, key: remoteKey }, 'remote cache read failed');
    }

    const value = await this.load(key);
    // Fire-and-forget: the response shouldn't wait on, or fail because of, the write.
    remote.cache.set(remoteKey, value, this.options.ttlMs).catch((err: unknown) => {
      remote.logger.debug({ err: (err as Error).message, key: remoteKey }, 'remote cache write failed');
    });
    return value;
  }
}

import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { UpstreamError, UpstreamRateLimitedError } from '../errors.js';
import { CachedLoader } from '../lib/cached-loader.js';
import { RateLimiter, sleep } from '../lib/limiter.js';
import type { RemoteCache } from '../lib/remote-cache.js';
import { type MetObject, MetObjectSchema, SearchResponseSchema } from './schemas.js';

export interface SearchParams {
  q: string;
  hasImages?: boolean;
  /** Inclusive year range; the Met requires both bounds together. */
  dateRange?: { begin: number; end: number };
}

export interface MetClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  minRequestIntervalMs: number;
  searchCacheTtlMs: number;
  objectCacheTtlMs: number;
  logger: FastifyBaseLogger;
  /** Optional shared cache tier (Redis) behind the in-process LRUs. */
  remoteCache?: RemoteCache;
  fetch?: typeof fetch;
}

const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * Thin, resilient client for the Met Collection API
 * (https://metmuseum.github.io/). All requests go through a shared rate
 * limiter, transient failures are retried with backoff, and responses are
 * cached with in-flight de-duplication.
 */
export class MetClient {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly searches: CachedLoader<string, { ids: number[] }>;
  private readonly objects: CachedLoader<number, { object: MetObject | null }>;

  constructor(private readonly opts: MetClientOptions) {
    this.limiter = new RateLimiter(opts.maxConcurrency, opts.minRequestIntervalMs);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    const remote = (namespace: string) =>
      opts.remoteCache && { cache: opts.remoteCache, namespace, logger: opts.logger };
    this.searches = new CachedLoader((key) => this.loadSearch(key), {
      max: 1_000,
      ttlMs: opts.searchCacheTtlMs,
      ...withRemote(remote('search')),
    });
    this.objects = new CachedLoader((id) => this.loadObject(id), {
      max: 10_000,
      ttlMs: opts.objectCacheTtlMs,
      ...withRemote(remote('object')),
    });
  }

  /** Returns matching object IDs (deduplicated, upstream order). */
  async search(params: SearchParams): Promise<number[]> {
    const { ids } = await this.searches.get(buildSearchQuery(params));
    return ids;
  }

  /** Returns the object, or null if the Met no longer has it (404). */
  async getObject(id: number): Promise<MetObject | null> {
    const { object } = await this.objects.get(id);
    return object;
  }

  private async loadSearch(query: string): Promise<{ ids: number[] }> {
    const body = await this.getJson(`/search?${query}`, SearchResponseSchema);
    if (body === null) throw new UpstreamError('Met search endpoint returned 404');
    return { ids: [...new Set(body.objectIDs ?? [])] };
  }

  private async loadObject(id: number): Promise<{ object: MetObject | null }> {
    return { object: await this.getJson(`/objects/${id}`, MetObjectSchema) };
  }

  /** GET + parse. Resolves null on 404. */
  private async getJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | null> {
    const url = `${this.opts.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.limiter.run(() => this.attempt(url, schema));
      } catch (err) {
        const retryable = err instanceof TransientError;
        if (!retryable || attempt >= this.opts.maxRetries) {
          throw retryable ? new UpstreamError(err.message, { cause: err }) : err;
        }
        const delayMs = 250 * 2 ** attempt + Math.random() * 100;
        this.opts.logger.warn({ url, attempt, delayMs, err: err.message }, 'retrying Met request');
        await sleep(delayMs);
      }
    }
  }

  private async attempt<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S> | null> {
    const startedAt = performance.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      this.opts.logger.debug(
        { url, status: res.status, ms: Math.round(performance.now() - startedAt) },
        'met request',
      );
    } catch (err) {
      throw new TransientError(`Met request failed: ${(err as Error).message}`, { cause: err });
    }

    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    // The Met's CDN answers bursts with 403 (bot protection) or 429. Retrying
    // immediately only extends the block, so surface it to the caller instead.
    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel();
      throw new UpstreamRateLimitedError(parseRetryAfter(res.headers.get('retry-after')));
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      throw new TransientError(`Met responded ${res.status}`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError(`Met responded ${res.status}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new TransientError('Met returned a non-JSON body', { cause: err });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new UpstreamError('Met returned an unexpected response shape', { cause: parsed.error });
    }
    return parsed.data;
  }
}

class TransientError extends Error {}

// Satisfies exactOptionalPropertyTypes: omit `remote` entirely when unset.
function withRemote<T>(remote: T | undefined): { remote: T } | Record<string, never> {
  return remote ? { remote } : {};
}

export function buildSearchQuery({ q, hasImages, dateRange }: SearchParams): string {
  const params = new URLSearchParams();
  if (hasImages !== undefined) params.set('hasImages', String(hasImages));
  if (dateRange) {
    params.set('dateBegin', String(dateRange.begin));
    params.set('dateEnd', String(dateRange.end));
  }
  // The Met docs place `q` last; keep that ordering to be safe.
  params.set('q', q);
  return params.toString();
}

function parseRetryAfter(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_SECONDS;
}

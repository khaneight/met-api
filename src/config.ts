import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MET_BASE_URL: z.url().default('https://collectionapi.metmuseum.org/public/collection/v1'),
  /** Per-attempt timeout for a single upstream request. */
  MET_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  /** Retries for transient upstream failures (network, timeout, 5xx). */
  MET_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /**
   * The Met sits behind a bot-protection CDN that hard-blocks bursty clients
   * (observed: 403s after ~70 requests in a few seconds). Keep this low.
   */
  MET_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
  MET_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).default(100),
  /** Optional Redis for a persistent, shared cache tier. Unset = in-memory only. */
  REDIS_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  /** Bump the version suffix when cached value shapes change. */
  REDIS_KEY_PREFIX: z.string().default('met-recent-works:v1:'),
  SEARCH_CACHE_TTL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  OBJECT_CACHE_TTL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

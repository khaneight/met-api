/**
 * `pnpm dev`: starts the API in watch mode with a Redis cache when one can be
 * found or started, falling back to in-memory caching otherwise.
 *
 * Resolution order:
 *   1. REDIS_URL already set            → use it as-is
 *   2. Redis answering on localhost:6379 → use it (e.g. `brew services start redis`)
 *   3. Docker available                  → `docker compose up -d redis`
 *   4. `redis-server` on PATH            → run it as a child process (stopped on exit)
 *   5. none of the above                 → warn, run with in-memory caching only
 *
 * `pnpm dev:memory` skips all of this.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { connect } from 'node:net';

const REDIS_PORT = 6379;
const LOCAL_REDIS_URL = `redis://localhost:${REDIS_PORT}`;

const children: ChildProcess[] = [];

async function main(): Promise<void> {
  const redisUrl = await resolveRedis();
  const server = spawn('tsx', ['watch', 'src/index.ts'], {
    stdio: 'inherit',
    env: redisUrl ? { ...process.env, REDIS_URL: redisUrl } : process.env,
  });
  children.push(server);
  server.on('exit', (code) => shutdown(code ?? 0));
}

async function resolveRedis(): Promise<string | undefined> {
  if (process.env.REDIS_URL) {
    log(`using REDIS_URL from the environment`);
    return process.env.REDIS_URL;
  }
  if (await ping(REDIS_PORT)) {
    log(`using Redis already running on localhost:${REDIS_PORT}`);
    return LOCAL_REDIS_URL;
  }
  if (commandSucceeds('docker', ['info'])) {
    log('starting Redis with docker compose…');
    const up = spawnSync('docker', ['compose', 'up', '-d', 'redis'], { stdio: 'inherit' });
    if (up.status === 0 && (await waitForRedis())) return LOCAL_REDIS_URL;
    warn('docker compose did not bring Redis up');
  }
  if (commandSucceeds('redis-server', ['--version'])) {
    log(`starting redis-server on port ${REDIS_PORT} (data in .redis-data/)…`);
    mkdirSync('.redis-data', { recursive: true });
    const redis = spawn(
      'redis-server',
      ['--port', String(REDIS_PORT), '--dir', '.redis-data', '--save', '60', '1', '--maxmemory', '256mb', '--maxmemory-policy', 'allkeys-lru'],
      { stdio: 'ignore' },
    );
    children.push(redis);
    if (await waitForRedis()) return LOCAL_REDIS_URL;
    warn('redis-server did not become ready');
  }
  warn(
    'no Redis available; caching in memory only (lost on restart).\n' +
      '       Install one of: `brew install redis` or Docker Desktop. Or run `pnpm dev:memory` to skip this check.',
  );
  return undefined;
}

/** Resolves true if something on the port answers PING with PONG. */
function ping(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('error', () => done(false));
    socket.on('connect', () => socket.write('PING\r\n'));
    socket.on('data', (data) => done(data.toString().startsWith('+PONG')));
  });
}

async function waitForRedis(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(REDIS_PORT)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function commandSucceeds(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

function shutdown(code: number): void {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exit(code);
}

function log(message: string): void {
  console.log(`[dev] ${message}`);
}

function warn(message: string): void {
  console.warn(`[dev] warning: ${message}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(0));

await main();

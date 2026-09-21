import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CachedLoader } from '../src/lib/cached-loader.js';
import { RedisCache, type RemoteCache } from '../src/lib/remote-cache.js';
import { FakeMet, type FakeObject } from './fake-met.js';

const silent = { debug() {}, info() {}, warn() {} } as never;

/** In-memory RemoteCache; optionally broken to simulate Redis being down. */
class FakeRemote implements RemoteCache {
  readonly store = new Map<string, unknown>();
  down = false;

  async get(key: string) {
    if (this.down) throw new Error('ECONNREFUSED');
    return this.store.get(key);
  }
  async set(key: string, value: unknown) {
    if (this.down) throw new Error('ECONNREFUSED');
    this.store.set(key, structuredClone(value));
  }
  async close() {}
}

describe('CachedLoader with a remote tier', () => {
  const make = (remote: RemoteCache, load: (k: string) => Promise<{ v: string }>) =>
    new CachedLoader(load, { max: 10, ttlMs: 60_000, remote: { cache: remote, namespace: 'ns', logger: silent } });

  it('serves remote hits without calling the loader', async () => {
    const remote = new FakeRemote();
    remote.store.set('ns:k', { v: 'from-remote' });
    let loads = 0;
    const loader = make(remote, async () => ({ v: `loaded-${++loads}` }));

    await expect(loader.get('k')).resolves.toEqual({ v: 'from-remote' });
    expect(loads).toBe(0);
  });

  it('writes loaded values through to the remote tier', async () => {
    const remote = new FakeRemote();
    const loader = make(remote, async (k) => ({ v: k.toUpperCase() }));

    await loader.get('k');
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget write land

    expect(remote.store.get('ns:k')).toEqual({ v: 'K' });
  });

  it('falls back to the loader when the remote tier is down', async () => {
    const remote = new FakeRemote();
    remote.down = true;
    const loader = make(remote, async () => ({ v: 'loaded' }));

    await expect(loader.get('k')).resolves.toEqual({ v: 'loaded' });
  });
});

describe('RedisCache', () => {
  it('round-trips JSON under the key prefix with a TTL', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const cache = new RedisCache(redis, { keyPrefix: 'test:v1:', logger: silent });

    await cache.set('object:1', { object: null }, 60_000);

    await expect(cache.get('object:1')).resolves.toEqual({ object: null });
    await expect(cache.get('object:2')).resolves.toBeUndefined();
    expect(await redis.pttl('test:v1:object:1')).toBeGreaterThan(0);
    await cache.close();
  });
});

describe('app with a remote cache', () => {
  const config = loadConfig({ MET_MIN_REQUEST_INTERVAL_MS: '0' });
  const objects: FakeObject[] = Array.from({ length: 300 }, (_, i) => ({
    objectID: i + 1,
    objectBeginDate: 1000 + i * 3,
    objectEndDate: 1000 + i * 3 + (i % 7),
  }));
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  function start(remote: RemoteCache) {
    const met = new FakeMet(objects);
    const app = buildApp({ config, logger: false, fetch: met.fetch, remoteCache: remote });
    apps.push(app);
    return { met, get: (url: string) => app.inject({ method: 'GET', url }) };
  }

  it('serves a restarted instance entirely from the shared cache', async () => {
    const remote = new FakeRemote();
    const first = start(remote);
    const before = (await first.get('/works/recent?offset=5')).json();
    await new Promise((r) => setImmediate(r));

    const restarted = start(remote); // fresh process: empty in-memory LRUs
    const after = (await restarted.get('/works/recent?offset=5')).json();

    expect(after).toEqual(before);
    expect(restarted.met.calls).toHaveLength(0);
  });

  it('keeps serving correct results when Redis is down', async () => {
    const remote = new FakeRemote();
    remote.down = true;
    const { met, get } = start(remote);

    const res = await get('/works/recent');

    expect(res.statusCode).toBe(200);
    expect(res.json().works.map((w: { objectId: number }) => w.objectId)).toEqual([300, 299, 298, 297, 296]);
    expect(met.calls.length).toBeGreaterThan(0);
  });
});

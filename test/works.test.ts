import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FakeMet, type FakeObject, seededRandom } from './fake-met.js';

const config = loadConfig({ MET_MIN_REQUEST_INTERVAL_MS: '0', MET_MAX_RETRIES: '2' });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(objects: FakeObject[]) {
  const met = new FakeMet(objects);
  app = buildApp({ config, logger: false, fetch: met.fetch });
  const get = (url: string) => app!.inject({ method: 'GET', url });
  return { met, get };
}

/** A realistic spread: mostly ancient/early-modern, a handful of recent works. */
function generateObjects(count: number, seed = 42): FakeObject[] {
  const rand = seededRandom(seed);
  return Array.from({ length: count }, (_, i) => {
    const begin = Math.floor(-3000 + rand() * 5000); // -3000 .. 2000
    const end = Math.min(2025, begin + Math.floor(rand() * 60));
    return { objectID: 1000 + i, objectBeginDate: begin, objectEndDate: end, hasImage: rand() > 0.5 };
  });
}

function expectedTop(objects: FakeObject[], limit: number): number[] {
  return [...objects]
    .sort((a, b) => b.objectEndDate - a.objectEndDate || b.objectID - a.objectID)
    .slice(0, limit)
    .map((o) => o.objectID);
}

describe('GET /works/recent', () => {
  it('defaults to "bread" and returns the 5 most recent works by objectEndDate', async () => {
    const objects = generateObjects(2000);
    const { met, get } = setup(objects);

    const res = await get('/works/recent');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.query).toBe('bread');
    expect(body.total).toBe(2000);
    expect(body.works.map((w: { objectId: number }) => w.objectId)).toEqual(expectedTop(objects, 5));
    expect(met.calls[0]).toBe('/search?q=bread');
  });

  it('fetches only a handful of objects instead of every match', async () => {
    const { met, get } = setup(generateObjects(2000));

    await get('/works/recent');

    expect(met.objectCalls).toBeLessThanOrEqual(5);
    expect(met.calls.length).toBeLessThan(30);
  });

  it.each([1, 3, 20])('is correct for limit=%i across many random datasets', async (limit) => {
    for (let seed = 1; seed <= 10; seed++) {
      const objects = generateObjects(300, seed);
      const { get } = setup(objects);
      const res = await get(`/works/recent?limit=${limit}`);
      expect(res.json().works.map((w: { objectId: number }) => w.objectId)).toEqual(expectedTop(objects, limit));
      await app!.close();
    }
  });

  it('breaks ties on the boundary year by objectID, fetching only what it needs', async () => {
    const objects: FakeObject[] = [
      { objectID: 1, objectBeginDate: 1990, objectEndDate: 2000 },
      { objectID: 2, objectBeginDate: 1990, objectEndDate: 2000 },
      ...Array.from({ length: 50 }, (_, i) => ({ objectID: 100 + i, objectBeginDate: 1900, objectEndDate: 1950 })),
      ...Array.from({ length: 50 }, (_, i) => ({ objectID: 500 + i, objectBeginDate: 1000, objectEndDate: 1100 })),
    ];
    const { met, get } = setup(objects);

    const ids = (await get('/works/recent')).json().works.map((w: { objectId: number }) => w.objectId);

    expect(ids).toEqual([2, 1, 149, 148, 147]);
    expect(met.objectCalls).toBe(5);
  });

  it('finds objects whose date range starts long before it ends', async () => {
    const objects: FakeObject[] = [
      { objectID: 1, objectBeginDate: -500, objectEndDate: 1999 }, // very wide range
      ...generateObjects(200).map((o) => ({ ...o, objectEndDate: Math.min(o.objectEndDate, 1800) })),
    ];
    const { get } = setup(objects);

    const res = await get('/works/recent?limit=1');

    expect(res.json().works[0].objectId).toBe(1);
  });

  it('ranks Palaeolithic objects by their dates, not as newest (regression: "humans")', async () => {
    // Real Met data: stone tools dated "ca. 240,000–40,000 B.C.".
    const stoneTools: FakeObject[] = Array.from({ length: 15 }, (_, i) => ({
      objectID: 573_090 + i,
      objectBeginDate: -240_000,
      objectEndDate: -40_000,
    }));
    const objects = [...generateObjects(300), ...stoneTools];
    const { met, get } = setup(objects);

    const body = (await get('/works/recent')).json();

    expect(body.works.map((w: { objectId: number }) => w.objectId)).toEqual(expectedTop(objects, 5));
    expect(met.calls.filter((c) => c.startsWith('/search')).length).toBeLessThan(25);
  });

  it('ranks objects outside every date window last instead of first', async () => {
    const unplaceable: FakeObject[] = Array.from({ length: 10 }, (_, i) => ({
      objectID: 900_000 + i,
      objectBeginDate: -300_000_000, // beyond even the widened filter bounds
      objectEndDate: 1990,
    }));
    const dated = generateObjects(100);
    const { get } = setup([...dated, ...unplaceable]);

    const first = (await get('/works/recent')).json();
    const last = (await get('/works/recent?offset=100&limit=10')).json();

    expect(first.works.map((w: { objectId: number }) => w.objectId)).toEqual(expectedTop(dated, 5));
    expect(last.works.map((w: { objectId: number }) => w.objectId).sort()).toEqual(
      unplaceable.map((o) => o.objectID).sort(),
    );
  });

  it('drops objects that 404 without shifting page boundaries', async () => {
    const objects = generateObjects(500);
    const top = expectedTop(objects, 10);
    const met = new FakeMet(objects);
    // Search still lists the object but the object endpoint 404s.
    const fetchWith404 = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith(`/objects/${top[1]}`)
        ? new Response('{"message":"ObjectID not found"}', { status: 404 })
        : met.fetch(input, init)) as typeof fetch;
    app = buildApp({ config, logger: false, fetch: fetchWith404 });
    const get = (url: string) => app!.inject({ method: 'GET', url });

    const page1 = (await get('/works/recent')).json();
    const page2 = (await get('/works/recent?offset=5')).json();

    expect(page1.works.map((w: { objectId: number }) => w.objectId)).toEqual([top[0], ...top.slice(2, 5)]);
    expect(page1.nextOffset).toBe(5);
    expect(page2.works.map((w: { objectId: number }) => w.objectId)).toEqual(top.slice(5, 10));
  });

  it('fetches everything directly for small result sets', async () => {
    const objects = generateObjects(8);
    const { met, get } = setup(objects);

    const res = await get('/works/recent?limit=3');

    expect(res.json().works.map((w: { objectId: number }) => w.objectId)).toEqual(expectedTop(objects, 3));
    expect(met.calls.filter((c) => c.startsWith('/search'))).toHaveLength(1);
  });

  it('returns an empty list when nothing matches', async () => {
    const { get } = setup(generateObjects(10));

    const res = await get('/works/recent?q=unicorn');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ query: 'unicorn', total: 0, offset: 0, limit: 5, nextOffset: null, works: [] });
  });

  it('supports changed queries and serves repeats from cache', async () => {
    const objects: FakeObject[] = [
      ...generateObjects(300),
      { objectID: 9001, objectBeginDate: 1880, objectEndDate: 1889, terms: ['sunflowers'] },
    ];
    const { met, get } = setup(objects);

    await get('/works/recent');
    const callsAfterFirst = met.calls.length;
    await get('/works/recent');
    expect(met.calls.length).toBe(callsAfterFirst);

    const res = await get('/works/recent?q=sunflowers');
    expect(res.json().works.map((w: { objectId: number }) => w.objectId)).toEqual([9001]);
  });

  it('coalesces concurrent identical requests', async () => {
    const { met, get } = setup(generateObjects(1000));

    await Promise.all([get('/works/recent'), get('/works/recent'), get('/works/recent')]);
    const concurrentCalls = met.calls.length;
    await app!.close();

    const solo = setup(generateObjects(1000));
    await solo.get('/works/recent');
    expect(concurrentCalls).toBe(solo.met.calls.length);
  });

  it('filters by hasImages', async () => {
    const objects = generateObjects(500);
    const { get } = setup(objects);

    const res = await get('/works/recent?hasImages=true');

    expect(res.json().works.map((w: { objectId: number }) => w.objectId)).toEqual(
      expectedTop(
        objects.filter((o) => o.hasImage),
        5,
      ),
    );
  });

  it('trims the query term', async () => {
    const { met, get } = setup(generateObjects(10));
    await get('/works/recent?q=%20%20bread%20');
    expect(met.calls[0]).toBe('/search?q=bread');
  });

  it.each([
    ['limit=0', 'limit'],
    ['limit=21', 'limit'],
    ['limit=abc', 'limit'],
    ['q=', 'q'],
    [`q=${'x'.repeat(201)}`, 'q'],
    ['hasImages=yes', 'hasImages'],
    ['offset=-1', 'offset'],
    ['offset=10001', 'offset'],
  ])('rejects invalid input %s with a structured 400', async (qs, field) => {
    const { met, get } = setup([]);

    const res = await get(`/works/recent?${qs}`);

    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.details).toHaveProperty(field);
    expect(error.requestId).toBe(res.headers['x-request-id']);
    expect(met.calls).toHaveLength(0);
  });
});

describe('pagination', () => {
  const ids = (body: { works: Array<{ objectId: number }> }) => body.works.map((w) => w.objectId);

  /** Many works share end years, so ties routinely straddle page boundaries. */
  function tieHeavyObjects(count: number, seed: number): FakeObject[] {
    const rand = seededRandom(seed);
    return Array.from({ length: count }, (_, i) => {
      const end = 1900 + Math.floor(rand() * 12);
      return { objectID: 1 + Math.floor(rand() * 1_000_000) * 10 + i, objectBeginDate: end - 10, objectEndDate: end };
    });
  }

  it.each([
    ['spread-out dates', (seed: number) => generateObjects(150, seed)],
    ['tie-heavy dates', (seed: number) => tieHeavyObjects(150, seed)],
  ])('walking every page reproduces the full ordering (%s)', async (_label, make) => {
    for (let seed = 1; seed <= 5; seed++) {
      const objects = make(seed);
      const { get } = setup(objects);

      const seen: number[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const body: { offset: number; nextOffset: number | null; works: Array<{ objectId: number }> } = (
          await get(`/works/recent?limit=7&offset=${offset}`)
        ).json();
        expect(body.offset).toBe(offset);
        seen.push(...ids(body));
        offset = body.nextOffset;
      }

      expect(seen).toEqual(expectedTop(objects, objects.length));
      await app!.close();
    }
  });

  it('fetches only the objects on the requested page', async () => {
    const { met, get } = setup(generateObjects(2000));

    await get('/works/recent?offset=40&limit=10');

    expect(met.objectCalls).toBe(10);
  });

  it('reports nextOffset and handles offsets past the end', async () => {
    const objects = generateObjects(30);
    const { get } = setup(objects);

    const last = (await get('/works/recent?offset=25&limit=10')).json();
    expect(ids(last)).toEqual(expectedTop(objects, 30).slice(25));
    expect(last.nextOffset).toBeNull();

    const beyond = (await get('/works/recent?offset=30')).json();
    expect(beyond).toMatchObject({ total: 30, offset: 30, nextOffset: null, works: [] });
  });

  it('never advertises a nextOffset beyond the maximum allowed offset', async () => {
    const { get } = setup(generateObjects(10_050));

    const res = await get('/works/recent?offset=10000&limit=20');

    expect(res.statusCode).toBe(200);
    expect(res.json().nextOffset).toBeNull();
  }, 20_000);

  it('paginates small result sets fetched directly', async () => {
    const objects = generateObjects(12);
    const { get } = setup(objects);

    const page2 = (await get('/works/recent?offset=5&limit=5')).json();

    expect(ids(page2)).toEqual(expectedTop(objects, 12).slice(5, 10));
    expect(page2.nextOffset).toBe(10);
  });
});

describe('upstream failures', () => {
  it('maps a bot-protection 403 to 503 with Retry-After and does not retry', async () => {
    const { met, get } = setup(generateObjects(10));
    met.failWith = 403;

    const res = await get('/works/recent');

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.json().error.code).toBe('UPSTREAM_RATE_LIMITED');
    expect(met.calls).toHaveLength(1);
  });

  it('retries transient 5xx errors and recovers', async () => {
    const objects = generateObjects(10);
    const { met, get } = setup(objects);
    met.transientFailures = 2;

    const res = await get('/works/recent');

    expect(res.statusCode).toBe(200);
    expect(res.json().works).toHaveLength(5);
  });

  it('returns 502 once retries are exhausted, and does not cache the failure', async () => {
    const { met, get } = setup(generateObjects(10));
    met.failWith = 500;

    const res = await get('/works/recent');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM_ERROR');
    expect(met.calls).toHaveLength(1 + config.MET_MAX_RETRIES);

    met.failWith = null;
    expect((await get('/works/recent')).statusCode).toBe(200);
  });

  it('returns 502 when the Met responds with an unexpected shape', async () => {
    const app_ = buildApp({
      config,
      logger: false,
      fetch: (async () => new Response('{"total":"lots"}', { status: 200 })) as typeof fetch,
    });
    app = app_;

    const res = await app_.inject({ method: 'GET', url: '/works/recent' });

    expect(res.statusCode).toBe(502);
  });
});

describe('misc routes', () => {
  it('serves a health check and structured 404s', async () => {
    const { get } = setup([]);
    expect((await get('/healthz')).json()).toEqual({ status: 'ok' });
    const res = await get('/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('serves the demo UI at /', async () => {
    const { get } = setup([]);
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('/works/recent');
  });
});

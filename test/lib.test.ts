import { describe, expect, it } from 'vitest';
import { CachedLoader } from '../src/lib/cached-loader.js';
import { RateLimiter, sleep } from '../src/lib/limiter.js';

describe('RateLimiter', () => {
  it('never exceeds max concurrency', async () => {
    const limiter = new RateLimiter(3, 0);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.run(async () => {
          peak = Math.max(peak, ++active);
          await sleep(5);
          active--;
        }),
      ),
    );

    expect(peak).toBe(3);
  });

  it('spaces out task starts', async () => {
    const limiter = new RateLimiter(10, 20);
    const starts: number[] = [];

    await Promise.all(Array.from({ length: 4 }, () => limiter.run(async () => void starts.push(Date.now()))));

    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(15);
    }
  });

  it('releases the slot when a task throws', async () => {
    const limiter = new RateLimiter(1, 0);
    await expect(limiter.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('CachedLoader', () => {
  it('caches values and coalesces concurrent loads', async () => {
    let loads = 0;
    const loader = new CachedLoader(async (k: string) => ({ v: `${k}:${++loads}` }), { max: 10, ttlMs: 60_000 });

    const [a, b] = await Promise.all([loader.get('x'), loader.get('x')]);
    const c = await loader.get('x');

    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(loads).toBe(1);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const loader = new CachedLoader(
      async () => {
        if (++calls === 1) throw new Error('first');
        return { ok: true };
      },
      { max: 10, ttlMs: 60_000 },
    );

    await expect(loader.get('k')).rejects.toThrow('first');
    await expect(loader.get('k')).resolves.toEqual({ ok: true });
  });
});

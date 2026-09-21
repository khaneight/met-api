/**
 * Bounds concurrent work and enforces a minimum gap between task starts.
 * Used to stay under the Met's bot-protection thresholds.
 */
export class RateLimiter {
  private active = 0;
  private nextStartAt = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
    } else {
      // release() hands its slot directly to us, so `active` is unchanged.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    // Reserve a start slot synchronously so concurrent acquirers are spaced out.
    const now = Date.now();
    const startAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = startAt + this.minIntervalMs;
    if (startAt > now) await sleep(startAt - now);
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

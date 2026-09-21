/**
 * Live correctness canary: checks the service's ranking against a brute-force
 * sort of every matching object fetched straight from the Met API.
 *
 *   pnpm verify:live [term] [--ranks 20] [--interval 1000] [--has-images]
 *
 * The brute force deliberately shares no code with the service (plain fetch,
 * its own sort). It is slow on purpose: one request per --interval ms, pausing
 * five minutes whenever the Met's bot protection answers 403/429. Fetched dates
 * are saved to .verify-cache/, so an interrupted run resumes where it stopped.
 *
 * Exit code 0 = service matches brute force for the first --ranks ranks.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const MET = 'https://collectionapi.metmuseum.org/public/collection/v1';
const BLOCKED_PAUSE_MS = 5 * 60_000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ranks: { type: 'string', default: '20' },
    interval: { type: 'string', default: '1000' },
    'has-images': { type: 'boolean', default: false },
  },
});
const q = positionals[0] ?? 'bread';
const ranks = Number(values.ranks);
const intervalMs = Number(values.interval);
const hasImages = values['has-images'];

/** [objectBeginDate, objectEndDate], or null when the object 404s. */
type Dates = [number, number] | null;

async function main(): Promise<void> {
  // 1. What the service says (a handful of upstream calls, done first).
  const actual = await serviceRanking();
  log(`service returned ${actual.length} ranked works`);

  // 2. Ground truth: every match, fetched one by one.
  const ids = await searchAll();
  const dates = await fetchAllDates(ids);
  const missing = ids.filter((id) => dates.get(id) === null);
  const expected = ids
    .filter((id) => dates.get(id) != null)
    .sort((a, b) => dates.get(b)![1] - dates.get(a)![1] || b - a);

  // The service drops objects that 404 (it can't show them), so compare
  // against the brute-force order with those removed as well.
  const expectedTop = expected.slice(0, actual.length);
  const mismatches = actual.flatMap((id, i) => (id === expectedTop[i] ? [] : [i]));

  console.log(`\n${q}: ${ids.length} matches, ${missing.length} returned 404`);
  console.log('rank  expected (end, id)        service (end, id)');
  for (let i = 0; i < actual.length; i++) {
    const e = expectedTop[i];
    const a = actual[i]!;
    const mark = e === a ? ' ' : '✗';
    console.log(
      `${mark} ${String(i + 1).padStart(3)}  ${fmt(e, dates)}  ${fmt(a, dates)}`,
    );
  }

  if (mismatches.length === 0) {
    console.log(`\nPASS: service matches brute force for the top ${actual.length} ranks`);
  } else {
    console.log(`\nFAIL: ${mismatches.length} rank(s) differ`);
    process.exitCode = 1;
  }
}

/** Walks the service's pages in-process until `ranks` works are collected. */
async function serviceRanking(): Promise<number[]> {
  const app = buildApp({ config: loadConfig(process.env), logger: false });
  const out: number[] = [];
  try {
    let offset: number | null = 0;
    while (offset !== null && offset < ranks) {
      const limit = Math.min(20, ranks - offset);
      const qs = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
      if (hasImages) qs.set('hasImages', 'true');
      const res = await app.inject({ method: 'GET', url: `/works/recent?${qs}` });
      if (res.statusCode === 503) {
        log(`service reports the Met is blocking us; pausing ${BLOCKED_PAUSE_MS / 1000}s`);
        await sleep(BLOCKED_PAUSE_MS);
        continue;
      }
      if (res.statusCode !== 200) throw new Error(`service responded ${res.statusCode}: ${res.body}`);
      const body = res.json() as { nextOffset: number | null; works: Array<{ objectId: number }> };
      out.push(...body.works.map((w) => w.objectId));
      offset = body.nextOffset;
    }
  } finally {
    await app.close();
  }
  return out;
}

async function searchAll(): Promise<number[]> {
  const qs = new URLSearchParams({ q });
  if (hasImages) qs.set('hasImages', 'true');
  const body = (await getJson(`${MET}/search?${qs}`)) as {
    objectIDs: number[] | null;
  };
  return [...new Set(body?.objectIDs ?? [])];
}

async function fetchAllDates(ids: number[]): Promise<Map<number, Dates>> {
  mkdirSync('.verify-cache', { recursive: true });
  const file = '.verify-cache/objects.json';
  const cache = new Map<number, Dates>(Object.entries(readJson(file)).map(([k, v]) => [Number(k), v as Dates]));
  const todo = ids.filter((id) => !cache.has(id));
  log(`${ids.length - todo.length} objects cached, ${todo.length} to fetch (~${Math.ceil((todo.length * intervalMs) / 60_000)} min)`);

  for (const [i, id] of todo.entries()) {
    const body = (await getJson(`${MET}/objects/${id}`)) as { objectBeginDate: number; objectEndDate: number } | null;
    cache.set(id, body ? [body.objectBeginDate, body.objectEndDate] : null);
    if (i % 25 === 24 || i === todo.length - 1) {
      writeFileSync(file, JSON.stringify(Object.fromEntries(cache)));
      log(`fetched ${i + 1}/${todo.length}`);
    }
    await sleep(intervalMs);
  }
  return cache;
}

/** GET JSON; null on 404; waits out bot-protection blocks and retries. */
async function getJson(url: string): Promise<unknown> {
  for (;;) {
    const res = await fetch(url).catch(() => null);
    if (res?.status === 404) return null;
    if (res?.ok) return res.json();
    const why = res ? `HTTP ${res.status}` : 'network error';
    const wait = res && (res.status === 403 || res.status === 429) ? BLOCKED_PAUSE_MS : 10_000;
    log(`${why} on ${url.replace(MET, '')}; pausing ${wait / 1000}s`);
    await sleep(wait);
  }
}

function fmt(id: number | undefined, dates: Map<number, Dates>): string {
  if (id === undefined) return '—'.padEnd(24);
  return `(${dates.get(id)?.[1] ?? '?'}, ${id})`.padEnd(24);
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function log(message: string): void {
  console.error(`[verify] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

await main();

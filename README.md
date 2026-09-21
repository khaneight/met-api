# Met Recent Works API

An HTTP API that searches [The Met Collection API](https://metmuseum.github.io/) and returns the
most recent matching works, ordered by `objectEndDate` (descending). The default search term is `bread`.

## Quick start

```bash
pnpm install
pnpm dev                      # http://localhost:3000, hot reload, with Redis if it can find or start one
pnpm dev:memory               # same, but always in-memory caching only
open http://localhost:3000    # demo UI: search, object details, pagination
curl 'localhost:3000/works/recent'
curl 'localhost:3000/works/recent?q=sunflowers&limit=3&hasImages=true'
curl 'localhost:3000/works/recent?offset=5'          # page 2

pnpm test                     # vitest
pnpm typecheck
pnpm build && pnpm start      # production build
```

Requires Node 22+ (`.nvmrc` pins 24).

`pnpm dev` (`scripts/dev.ts`) sets up the optional Redis cache for you. It uses the first of these that works:

1. `REDIS_URL` from the environment.
2. A Redis already answering on `localhost:6379` (for example `brew services start redis`).
3. `docker compose up -d redis`, if Docker is running. The container keeps running after dev exits; stop it with
   `docker compose down`.
4. A `redis-server` binary. It's started as a child process with data in `.redis-data/`, and stopped when dev
   exits.
5. Otherwise it prints a warning and runs with in-memory caching only. Dev never fails because of Redis.

## API

### `GET /works/recent`

| Param       | Type            | Default | Notes                                  |
| ----------- | --------------- | ------- | -------------------------------------- |
| `q`         | string (1–200)  | `bread` | Trimmed. Passed to Met search.         |
| `limit`     | int (1–20)      | `5`     | Page size.                             |
| `offset`    | int (0–10000)   | `0`     | Rank of the first work on the page.    |
| `hasImages` | `true`/`false`  | –       | Passed through to Met search. See note. |

```jsonc
// 200
{
  "query": "bread",
  "total": 2173,               // objects the Met matched
  "offset": 0,
  "limit": 5,
  "nextOffset": 5,             // null on the last page
  "works": [
    {
      "objectId": 284537,
      "title": "Untitled",
      "objectName": "Photograph",
      "artist": "Gregory Crewdson",
      "culture": null,
      "department": "Photographs",
      "medium": "Chromogenic print",
      "date": "1998",           // display date as catalogued
      "objectBeginDate": 1998,
      "objectEndDate": 1998,
      "imageUrl": null,
      "thumbnailUrl": null,
      "url": "https://www.metmuseum.org/art/collection/search/284537"
    }
  ]
}
```

**Note on `hasImages`:** the Met matches works that are *pictured on metmuseum.org*. The API only returns image
URLs (`primaryImage`) for public-domain works. Recent works are mostly still in copyright, so the top results
usually have `imageUrl: null` even with `hasImages=true`.

Errors share one shape, and every response carries an `x-request-id` header. If the client sends that header, the server uses the client's value.

```json
{ "error": { "code": "INVALID_REQUEST", "message": "...", "requestId": "...", "details": { "limit": ["..."] } } }
```

| Status | Code                    | When                                                          |
| ------ | ----------------------- | ------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`       | Query param validation failed (`details` has per-field errors) |
| 404    | `NOT_FOUND`             | Unknown route                                                 |
| 502    | `UPSTREAM_ERROR`        | Met failed after retries, timed out, or returned a bad shape  |
| 503    | `UPSTREAM_RATE_LIMITED` | Met bot protection/rate limit hit; includes `Retry-After`     |
| 500    | `INTERNAL_ERROR`        | Bug                                                           |

`GET /healthz` returns `{ "status": "ok" }`. `GET /` serves the demo UI (`public/index.html`).

## How it works

For a component-by-component deep dive, with diagrams, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Three facts about the Met API shape the design:

1. `/search` returns **only object IDs**, in no meaningful order (2,173 for "bread").
2. Dates live on `/objects/{id}`, one request per object.
3. The API sits behind a bot-protection CDN that **hard-blocks bursty clients with 403s**. In testing it tripped after
   about 70 requests in a few seconds, and even about 3 req/s sequential eventually got blocked. The block lasts a
   few minutes.

So the naive approach doesn't work: fetching every match and sorting would take thousands of requests and get the
server IP-banned.

### Narrowing with the date filter

`/search` accepts `dateBegin`/`dateEnd`. I verified against the live API that these use **containment** semantics:

```
search(q, dateBegin=B, dateEnd=E) = { o : o.objectBeginDate >= B  AND  o.objectEndDate <= E }
```

It follows that `search(q) \ search(q, dateBegin=-100000, dateEnd=E)` is **exactly** the set of matches with
`objectEndDate > E`, obtained purely from cheap ID-only searches. `RecentWorksService`
(`src/works/service.ts`) then:

1. Gallops backwards from the current year (steps of 4, 8, 16, … years) to bracket the boundary. It then
   binary-searches for the largest year `E` whose "newer than E" set still has at least `limit` items.
2. Fetches every object strictly newer than the boundary (fewer than `limit`). It fills the remaining slots from
   the boundary year's tie group, using the highest `objectID` first.
3. Sorts the fetched objects by their real `objectEndDate` (ties broken by `objectID` desc), so ordering never
   depends on the filter.

For "bread" this costs **about 11 searches and 5 object fetches**, instead of about 2,175 requests. That's about
3s cold and about 15ms warm. Result sets of 20 or fewer are fetched directly without narrowing.

### Pagination

Order is total and deterministic: `objectEndDate` desc, then `objectID` desc. Within one end year, rank depends
only on the ID. So the set of the top `k` IDs, `topIds(k)`, can be computed from searches alone: it's the works
newer than the boundary year plus the highest IDs from the boundary year. A page is then

```
page(offset, limit) = topIds(offset + limit) \ topIds(offset)
```

Only that page's objects are fetched, so page 50 costs about the same as page 1. Year probes are shared through
the search cache, so page 2 of "bread" costs about 4 new searches and 5 fetches (about 1.4s cold). The two
boundary searches run concurrently.

If a search lists an object but the object endpoint 404s, it's **dropped, not backfilled**. The page comes back
short, but every other work keeps its rank. `nextOffset` is always `offset + limit` while more matches exist, so
clients must page with `nextOffset` rather than stopping at a short page.

### Resilience

- **Shared rate limiter** (`src/lib/limiter.ts`): at most 4 concurrent upstream requests, with starts spaced at
  least 100ms apart. Both are configurable.
- **Retries**: network errors, timeouts (8s per attempt), 5xx responses and non-JSON bodies are retried twice with
  exponential backoff and jitter. 403/429 are **not** retried because hammering extends the block. Instead they
  become a 503 with `Retry-After`.
- **Optional Redis tier** (`src/lib/remote-cache.ts`): set `REDIS_URL` and the in-process caches gain a
  persistent, shared second tier. Restarts, deploys and extra replicas start warm instead of re-fetching from the
  Met. It's best effort: if Redis is down or unreachable, requests fail over to the Met at normal speed (one
  `warn` log, no errors). Unset means in-memory only, as below.
- **Caching + request coalescing** (`src/lib/cached-loader.ts`): LRU+TTL caches for searches (1h) and objects
  (24h, since catalogue data rarely changes). Concurrent identical requests share one in-flight promise. Failures
  aren't cached. Repeated and changed queries work without a restart, and repeats cost zero upstream calls.
- **Upstream validation**: zod parses only the fields we use, so additive upstream changes don't break us, but a
  broken shape becomes a clean 502.

### Layout

```
src/
  index.ts           entrypoint: config, listen, graceful shutdown
  app.ts             buildApp(): wiring, error + 404 handlers (DI for tests)
  config.ts          env parsing/validation (zod)
  errors.ts          AppError hierarchy → HTTP status + stable code
  met/client.ts      Met API client: limiter, retries, caching, error mapping
  met/schemas.ts     upstream response schemas
  works/service.ts   the "most recent N" algorithm
  works/routes.ts    GET /works/recent + input validation
  lib/               RateLimiter, CachedLoader, RemoteCache/RedisCache
public/
  index.html         demo UI (vanilla HTML/JS, no build step)
test/
  fake-met.ts        in-memory Met with the verified filter semantics
  works.test.ts      HTTP-level tests incl. randomized correctness vs brute force
  lib.test.ts        limiter / cache unit tests
  cache.test.ts      Redis tier: write-through, fallback when down, restart served from cache
```

## Configuration

All settings are optional environment variables. See `src/config.ts`.

| Var                           | Default    |
| ----------------------------- | ---------- |
| `PORT` / `HOST`               | `3000` / `0.0.0.0` |
| `LOG_LEVEL`                   | `info` (`debug` logs every upstream call with latency) |
| `MET_BASE_URL`                | Met v1 URL |
| `MET_TIMEOUT_MS`              | `8000`     |
| `MET_MAX_RETRIES`             | `2`        |
| `MET_MAX_CONCURRENCY`         | `4`        |
| `MET_MIN_REQUEST_INTERVAL_MS` | `100`      |
| `REDIS_URL`                   | unset (in-memory only) |
| `REDIS_KEY_PREFIX`            | `met-recent-works:v1:` |
| `SEARCH_CACHE_TTL_MS`         | `3600000`  |
| `OBJECT_CACHE_TTL_MS`         | `86400000` |

## Tradeoffs and next steps

- **Correctness depends on the date-filter semantics**, which are undocumented. They were verified empirically
  and are encoded in the test fake. A scheduled canary comparing narrowing with brute force on a small query
  would catch drift.
- **Cold latency** is dominated by about 11 sequential searches. Options: probe several years in parallel per round
  (k-ary search), start the gallop from a smarter guess, or pre-warm popular terms at startup.
- **Rate limit is per instance.** Redis shares the caches, but each replica still has its own upstream limiter.
  The IP ban applies to all instances behind one egress IP, so the next step is a token bucket in Redis.
- **Circuit breaker**: after a 403, short-circuit all upstream calls for the `Retry-After` window instead of
  probing. Also serve stale cache entries while blocked.
- **Search v1.1** (`/v1.1/search`) returns cheap filtered `total` counts (`limit=1`, about 36 bytes). The
  year search only needs counts, which would make probes constant-size for broad terms. v1.1 can't simply be
  swapped in, though. It matches a different set of objects (only "publicly available": 2,053 vs 2,173 for
  bread), so v1 and v1.1 can't be mixed in set arithmetic. It caps `offset + limit` at 10,000. Its pages come
  from an unordered ID list, not from date order.
- **Cursor pagination**: `offset` is stable only while the upstream data is. An opaque cursor encoding
  `(endDate, objectID)` of the last item would survive catalogue changes.
- Observability: metrics for upstream call counts and latency, cache hit rate, and 403 rate.

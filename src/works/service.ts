import type { MetClient, SearchParams } from '../met/client.js';
import type { MetObject } from '../met/schemas.js';

export interface RecentWorksQuery {
  q: string;
  limit: number;
  offset: number;
  hasImages?: boolean;
}

export interface Work {
  objectId: number;
  title: string;
  objectName: string;
  artist: string | null;
  culture: string | null;
  department: string;
  medium: string | null;
  /** Human-readable date as catalogued, e.g. "ca. 1922". */
  date: string;
  objectBeginDate: number;
  objectEndDate: number;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  url: string;
}

export interface RecentWorksResult {
  query: string;
  /** Number of objects the Met matched for the query. */
  total: number;
  offset: number;
  limit: number;
  /** Offset of the next page, or null on the last page. */
  nextOffset: number | null;
  works: Work[];
}

/** Bounds that include every object the Met catalogues. */
const MIN_YEAR = -100_000;
const MAX_YEAR = 100_000;
/** Deepest offset a client may request; pages beyond it are not advertised. */
export const MAX_OFFSET = 10_000;
/** At or below this many matches it is cheaper to fetch everything than to narrow. */
const DIRECT_FETCH_THRESHOLD = 20;

/**
 * Finds the N works with the latest objectEndDate for a search term.
 *
 * The Met's search endpoint returns only IDs, in no useful order, and the
 * per-object endpoint is behind aggressive bot protection, so fetching every
 * match (thousands for "bread") is not viable. Instead we exploit the search
 * endpoint's date filter, which has *containment* semantics:
 *
 *   search(q, dateBegin=B, dateEnd=E) = { o : o.beginDate >= B && o.endDate <= E }
 *
 * Hence `all \ search(q, MIN_YEAR, E)` is exactly the set with endDate > E.
 * We search for the largest E whose "newer than E" set still has >= N items,
 * costing O(log years) cheap ID-only searches, then fetch only those objects.
 * The final ordering always comes from the fetched objects themselves.
 */
export class RecentWorksService {
  constructor(
    private readonly met: MetClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Returns works at ranks [offset, offset + limit) in (objectEndDate desc,
   * objectID desc) order. Each page fetches only its own objects, so deep
   * pages cost about the same as the first.
   */
  async findRecent({ q, limit, offset, hasImages }: RecentWorksQuery): Promise<RecentWorksResult> {
    const base: SearchParams = hasImages === undefined ? { q } : { q, hasImages };
    const all = await this.met.search(base);
    const end = offset + limit;

    let works: MetObject[];
    if (all.length <= DIRECT_FETCH_THRESHOLD) {
      // Small result set: cheaper to fetch everything and slice.
      works = (await this.fetchAll(all)).sort(byMostRecent).slice(offset, end);
    } else if (offset >= all.length) {
      works = [];
    } else {
      // The page is exactly the top `end` IDs minus the top `offset` IDs.
      const [upToEnd, beforeOffset] = await Promise.all([
        this.topIds(base, all, end),
        this.topIds(base, all, offset),
      ]);
      const pageIds = [...upToEnd].filter((id) => !beforeOffset.has(id));
      // An object listed by search can still 404; it is dropped rather than
      // backfilled so that page boundaries stay stable across requests.
      works = (await this.fetchAll(pageIds)).sort(byMostRecent);
    }

    return {
      query: q,
      total: all.length,
      offset,
      limit,
      nextOffset: end < all.length && end <= MAX_OFFSET ? end : null,
      works: works.map(toWork),
    };
  }

  /**
   * The IDs of the `k` most recent works, computed from searches alone.
   * Within a single end year, rank is decided by objectID (descending), so
   * the boundary year's tie group can be cut without fetching any objects.
   */
  private async topIds(base: SearchParams, all: number[], k: number): Promise<Set<number>> {
    if (k <= 0) return new Set();
    if (k >= all.length) return new Set(all);

    const { newer, ties } = await this.boundary(base, all, k);
    const fromTies = ties.sort((a, b) => b - a).slice(0, k - newer.length);
    return new Set([...newer, ...fromTies]);
  }

  /**
   * Finds adjacent years (lo, lo + 1) such that fewer than `k` works end after
   * lo + 1 but at least `k` end after lo. Returns the works ending after lo + 1
   * (`newer`, all of rank < k) and those ending exactly in lo + 1 (`ties`).
   */
  private async boundary(
    base: SearchParams,
    all: number[],
    k: number,
  ): Promise<{ newer: number[]; ties: number[] }> {
    const newerThan = async (year: number): Promise<number[]> => {
      const olderOrEqual = new Set(await this.met.search({ ...base, dateRange: { begin: MIN_YEAR, end: year } }));
      return all.filter((id) => !olderOrEqual.has(id));
    };

    // Invariant once bracketed: |newerThan(hi)| < k <= |newerThan(lo)|.
    let hi = this.now().getUTCFullYear();
    let hiSet = await newerThan(hi);
    let lo: number;
    let loSet: number[];

    if (hiSet.length >= k) {
      // Enough future-dated objects (cataloguing quirks): search above today.
      [lo, loSet] = [hi, hiSet];
      [hi, hiSet] = [MAX_YEAR, await newerThan(MAX_YEAR)];
    } else {
      // Gallop backwards in time to bracket the boundary...
      let step = 4;
      lo = hi - step;
      loSet = await newerThan(lo);
      while (loSet.length < k) {
        if (lo <= MIN_YEAR) {
          // Whatever remains has no usable end date; rank it by ID.
          const newer = new Set(loSet);
          return { newer: loSet, ties: all.filter((id) => !newer.has(id)) };
        }
        [hi, hiSet] = [lo, loSet];
        step *= 2;
        lo = Math.max(MIN_YEAR, hi - step);
        loSet = await newerThan(lo);
      }
    }

    // ...then binary search down to adjacent years.
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const midSet = await newerThan(mid);
      if (midSet.length >= k) [lo, loSet] = [mid, midSet];
      else [hi, hiSet] = [mid, midSet];
    }

    const newer = new Set(hiSet);
    return { newer: hiSet, ties: loSet.filter((id) => !newer.has(id)) };
  }

  private async fetchAll(ids: number[]): Promise<MetObject[]> {
    const objects = await Promise.all(ids.map((id) => this.met.getObject(id)));
    return objects.filter((o): o is MetObject => o !== null);
  }
}

function byMostRecent(a: MetObject, b: MetObject): number {
  return b.objectEndDate - a.objectEndDate || b.objectID - a.objectID;
}

function toWork(o: MetObject): Work {
  return {
    objectId: o.objectID,
    title: o.title,
    objectName: o.objectName,
    artist: o.artistDisplayName || null,
    culture: o.culture || null,
    department: o.department,
    medium: o.medium || null,
    date: o.objectDate,
    objectBeginDate: o.objectBeginDate,
    objectEndDate: o.objectEndDate,
    imageUrl: o.primaryImage || null,
    thumbnailUrl: o.primaryImageSmall || null,
    url: o.objectURL || `https://www.metmuseum.org/art/collection/search/${o.objectID}`,
  };
}

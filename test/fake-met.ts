export interface FakeObject {
  objectID: number;
  objectBeginDate: number;
  objectEndDate: number;
  title?: string;
  hasImage?: boolean;
  /** Search terms this object matches (default: ["bread"]). */
  terms?: string[];
}

/**
 * In-memory stand-in for the Met API that reproduces the behaviour we rely
 * on: ID-only search, `null` objectIDs on no match, and *containment*
 * semantics for dateBegin/dateEnd (verified against the live API).
 */
export class FakeMet {
  readonly calls: string[] = [];
  /** Return this status for every request while set. */
  failWith: number | null = null;
  /** Fail this many upcoming requests with a 500 before recovering. */
  transientFailures = 0;

  constructor(private readonly objects: FakeObject[]) {}

  get objectCalls(): number {
    return this.calls.filter((c) => c.startsWith('/objects/')).length;
  }

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^.*\/v1/, '');
    this.calls.push(`${path}${url.search}`);

    if (this.failWith !== null) return json({ message: 'nope' }, this.failWith);
    if (this.transientFailures > 0) {
      this.transientFailures--;
      return json({ message: 'boom' }, 500);
    }

    if (path === '/search') {
      const q = url.searchParams.get('q') ?? '';
      const hasImages = url.searchParams.get('hasImages');
      const begin = url.searchParams.get('dateBegin');
      const end = url.searchParams.get('dateEnd');
      const ids = this.objects
        .filter((o) => (o.terms ?? ['bread']).includes(q))
        .filter((o) => hasImages !== 'true' || o.hasImage)
        .filter((o) => begin === null || o.objectBeginDate >= Number(begin))
        .filter((o) => end === null || o.objectEndDate <= Number(end))
        .map((o) => o.objectID);
      return json({ total: ids.length, objectIDs: ids.length ? ids : null });
    }

    const match = /^\/objects\/(\d+)$/.exec(path);
    const obj = match && this.objects.find((o) => o.objectID === Number(match[1]));
    if (!obj) return json({ message: 'ObjectID not found' }, 404);
    return json({
      objectID: obj.objectID,
      title: obj.title ?? `Object ${obj.objectID}`,
      objectName: 'Thing',
      objectDate: String(obj.objectEndDate),
      objectBeginDate: obj.objectBeginDate,
      objectEndDate: obj.objectEndDate,
      artistDisplayName: '',
      culture: '',
      department: 'Test',
      medium: '',
      primaryImage: obj.hasImage ? `https://img/${obj.objectID}.jpg` : '',
      primaryImageSmall: '',
      objectURL: `https://www.metmuseum.org/art/collection/search/${obj.objectID}`,
    });
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Deterministic PRNG so generated datasets are reproducible. */
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

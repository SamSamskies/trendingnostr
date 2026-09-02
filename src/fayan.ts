/** Official Fayan API — GET is CORS-allowed (`Access-Control-Allow-Origin: *`). */
export const FAYAN_BASE_URL = "https://fayan.jumble.social";
/** Authors at or above this percentile are kept. Below (or missing) are hidden. */
export const FAYAN_MIN_PERCENTILE = 40;
/** Parallel GETs per batch; keep modest to avoid hammering Fayan. */
export const FAYAN_CONCURRENCY = 10;
/** How long a successful reputation hit stays fresh. */
export const FAYAN_HIT_TTL_MS = 60 * 60 * 1000;
/** Shorter TTL for 404s so newly indexed authors can appear. */
export const FAYAN_MISSING_TTL_MS = 20 * 60 * 1000;

const FAYAN_CACHE_STORAGE_KEY = "trendingnostr:fayan-users";
const FAYAN_CACHE_MAX_ENTRIES = 500;
/** Drop persisted rows older than this regardless of hit vs missing TTL. */
const FAYAN_CACHE_MAX_AGE_MS = FAYAN_HIT_TTL_MS * 7;

export type FayanUser = {
  pubkey: string;
  rank: number;
  percentile: number;
  followers: number;
  following: number;
};

/** Map keyed by lowercase hex pubkey. */
export type FayanUserMap = Map<string, FayanUser>;

type CachedFayanHit = {
  missing: false;
  user: FayanUser;
  cachedAt: number;
};

type CachedFayanMissing = {
  missing: true;
  cachedAt: number;
};

type CachedFayan = CachedFayanHit | CachedFayanMissing;

let fayanMemoryCache: Map<string, CachedFayan> | null = null;

function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function parseFayanUser(raw: unknown): FayanUser | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.pubkey !== "string" || !isHexPubkey(record.pubkey)) {
    return null;
  }
  const percentile = Number(record.percentile);
  const rank = Number(record.rank);
  if (!Number.isFinite(percentile) || !Number.isFinite(rank)) return null;
  return {
    pubkey: record.pubkey.toLowerCase(),
    rank,
    percentile,
    followers: Number.isFinite(Number(record.followers))
      ? Number(record.followers)
      : 0,
    following: Number.isFinite(Number(record.following))
      ? Number(record.following)
      : 0,
  };
}

function ttlForEntry(entry: CachedFayan): number {
  return entry.missing ? FAYAN_MISSING_TTL_MS : FAYAN_HIT_TTL_MS;
}

function isFreshCacheEntry(entry: CachedFayan, now = Date.now()): boolean {
  return now - entry.cachedAt < ttlForEntry(entry);
}

function getFayanMemoryCache(): Map<string, CachedFayan> {
  if (fayanMemoryCache) return fayanMemoryCache;

  fayanMemoryCache = new Map();
  try {
    const raw = localStorage.getItem(FAYAN_CACHE_STORAGE_KEY);
    if (!raw) return fayanMemoryCache;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    for (const [pubkey, value] of Object.entries(parsed)) {
      if (!isHexPubkey(pubkey) || !value || typeof value !== "object") continue;
      const entry = value as Partial<CachedFayan> & {
        user?: Partial<FayanUser>;
      };
      if (typeof entry.cachedAt !== "number") continue;
      if (now - entry.cachedAt > FAYAN_CACHE_MAX_AGE_MS) continue;

      if (entry.missing === true) {
        fayanMemoryCache.set(pubkey.toLowerCase(), {
          missing: true,
          cachedAt: entry.cachedAt,
        });
        continue;
      }

      if (entry.missing !== false || !entry.user) continue;
      const user = parseFayanUser(entry.user);
      if (!user) continue;
      fayanMemoryCache.set(pubkey.toLowerCase(), {
        missing: false,
        user,
        cachedAt: entry.cachedAt,
      });
    }
  } catch {
    // Ignore corrupt / unavailable storage.
  }

  return fayanMemoryCache;
}

function persistFayanMemoryCache(): void {
  const cache = getFayanMemoryCache();
  const now = Date.now();
  const entries = [...cache.entries()]
    .filter(([, entry]) => now - entry.cachedAt <= FAYAN_CACHE_MAX_AGE_MS)
    .sort((a, b) => b[1].cachedAt - a[1].cachedAt);

  if (entries.length > FAYAN_CACHE_MAX_ENTRIES) {
    for (const [pubkey] of entries.slice(FAYAN_CACHE_MAX_ENTRIES)) {
      cache.delete(pubkey);
    }
  }

  const payload: Record<string, CachedFayan> = {};
  for (const [pubkey, entry] of cache) {
    if (now - entry.cachedAt > FAYAN_CACHE_MAX_AGE_MS) {
      cache.delete(pubkey);
      continue;
    }
    payload[pubkey] = entry;
  }

  try {
    localStorage.setItem(FAYAN_CACHE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota / private mode — memory cache still works for the session.
  }
}

function rememberFayanEntry(pubkey: string, entry: CachedFayan): void {
  getFayanMemoryCache().set(pubkey.trim().toLowerCase(), entry);
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await fn(items[index]);
      }
    })
  );
}

/**
 * Look up Fayan reputation for unique pubkeys via browser GET
 * (`/users/{pubkey}`). Vercel serverless IPs get Cloudflare HTML challenges
 * talking to Fayan, so we must not proxy from `/api/fayan`.
 *
 * Fresh hits/404s are cached in memory + localStorage. Hard failures are not
 * cached; any network failure returns `null` so callers can fail open.
 *
 * 404 (unknown author) is success: the pubkey is omitted from the returned map
 * but remembered as missing. An empty map after all lookups succeed means every
 * author was unknown.
 */
export async function fetchFayanUsers(
  pubkeys: string[]
): Promise<FayanUserMap | null> {
  const unique = [
    ...new Set(
      pubkeys.map((pk) => pk.trim().toLowerCase()).filter((pk) => isHexPubkey(pk))
    ),
  ];
  if (unique.length === 0) return new Map();

  const byPubkey: FayanUserMap = new Map();
  const cache = getFayanMemoryCache();
  const now = Date.now();
  const missing: string[] = [];

  for (const pubkey of unique) {
    const entry = cache.get(pubkey);
    if (entry && isFreshCacheEntry(entry, now)) {
      if (!entry.missing) byPubkey.set(entry.user.pubkey, entry.user);
      continue;
    }
    missing.push(pubkey);
  }

  if (missing.length === 0) return byPubkey;

  let completed = 0;
  let wroteCache = false;

  try {
    await mapPool(missing, FAYAN_CONCURRENCY, async (pubkey) => {
      const res = await fetch(
        `${FAYAN_BASE_URL}/users/${encodeURIComponent(pubkey)}`,
        { headers: { Accept: "application/json" } }
      );

      const cachedAt = Date.now();

      if (res.status === 404) {
        rememberFayanEntry(pubkey, { missing: true, cachedAt });
        wroteCache = true;
        completed += 1;
        return;
      }
      if (!res.ok) throw new Error(`fayan_${res.status}`);

      const data: unknown = await res.json();
      const user = parseFayanUser(data);
      if (user) {
        byPubkey.set(user.pubkey, user);
        rememberFayanEntry(pubkey, { missing: false, user, cachedAt });
        if (user.pubkey !== pubkey) {
          rememberFayanEntry(user.pubkey, { missing: false, user, cachedAt });
        }
      } else {
        // Unparseable 200 — treat like unknown for filtering, cache as missing.
        rememberFayanEntry(pubkey, { missing: true, cachedAt });
      }
      wroteCache = true;
      completed += 1;
    });

    if (wroteCache) persistFayanMemoryCache();

    // Only trust the map when every uncached key got a 200 or 404.
    return completed === missing.length ? byPubkey : null;
  } catch {
    if (wroteCache) persistFayanMemoryCache();
    return null;
  }
}

/** True when the author is missing from Fayan or below the percentile floor. */
export function isLowFayanReputation(
  pubkey: string,
  users: FayanUserMap,
  minPercentile = FAYAN_MIN_PERCENTILE
): boolean {
  const user = users.get(pubkey.trim().toLowerCase());
  if (!user) return true;
  return user.percentile < minPercentile;
}

/**
 * Drop notes from low-reputation / unknown authors.
 * Pass the map from a successful Fayan lookup only (never call with `null`).
 */
export function filterNotesByFayanReputation<T extends { pubkey: string }>(
  notes: T[],
  users: FayanUserMap,
  minPercentile = FAYAN_MIN_PERCENTILE
): T[] {
  return notes.filter(
    (note) => !isLowFayanReputation(note.pubkey, users, minPercentile)
  );
}

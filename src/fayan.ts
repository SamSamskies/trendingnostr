/** Official Fayan API — GET is CORS-allowed (`Access-Control-Allow-Origin: *`). */
export const FAYAN_BASE_URL = "https://fayan.jumble.social";
/** Authors at or above this percentile are kept. Below (or missing) are hidden. */
export const FAYAN_MIN_PERCENTILE = 40;
/** Parallel GETs per batch; keep modest to avoid hammering Fayan. */
export const FAYAN_CONCURRENCY = 10;

export type FayanUser = {
  pubkey: string;
  rank: number;
  percentile: number;
  followers: number;
  following: number;
};

/** Map keyed by lowercase hex pubkey. */
export type FayanUserMap = Map<string, FayanUser>;

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
 * Returns `null` on any hard failure so callers can fail open.
 * 404 (unknown author) is success: the pubkey is simply omitted from the map.
 * An empty map after all lookups succeed means every author was unknown.
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
  let completed = 0;

  try {
    await mapPool(unique, FAYAN_CONCURRENCY, async (pubkey) => {
      const res = await fetch(
        `${FAYAN_BASE_URL}/users/${encodeURIComponent(pubkey)}`,
        { headers: { Accept: "application/json" } }
      );

      if (res.status === 404) {
        completed += 1;
        return;
      }
      if (!res.ok) throw new Error(`fayan_${res.status}`);

      const data: unknown = await res.json();
      const user = parseFayanUser(data);
      if (user) byPubkey.set(user.pubkey, user);
      completed += 1;
    });

    // Only trust the map when every key got a 200 or 404.
    return completed === unique.length ? byPubkey : null;
  } catch {
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

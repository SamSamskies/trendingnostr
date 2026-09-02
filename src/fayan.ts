/** Match the upstream Fayan batch limit. */
export const FAYAN_ENDPOINT = "/api/fayan";
/** Authors at or above this percentile are kept. Below (or missing) are hidden. */
export const FAYAN_MIN_PERCENTILE = 40;
export const FAYAN_BATCH_SIZE = 100;

export type FayanUser = {
  pubkey: string;
  rank: number;
  percentile: number;
  followers: number;
  following: number;
};

/** Map keyed by lowercase hex pubkey (and request key when that differed). */
export type FayanUserMap = Map<string, FayanUser>;

function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
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

/**
 * Batch-lookup Fayan reputation for unique pubkeys via `/api/fayan`.
 * Returns `null` on any failure so callers can fail open.
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

  try {
    for (const chunk of chunkArray(unique, FAYAN_BATCH_SIZE)) {
      const res = await fetch(FAYAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkeys: chunk }),
      });
      if (!res.ok) return null;

      const data: unknown = await res.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;

      for (const [key, value] of Object.entries(data)) {
        const user = parseFayanUser(value);
        if (!user) continue;
        byPubkey.set(user.pubkey, user);
        const requestKey = key.trim().toLowerCase();
        if (requestKey && requestKey !== user.pubkey) {
          byPubkey.set(requestKey, user);
        }
      }
    }
    // Empty map after a real lookup is unusable (parse failures / empty payload).
    // Return null so callers fail open instead of hiding every note.
    return byPubkey.size > 0 ? byPubkey : null;
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

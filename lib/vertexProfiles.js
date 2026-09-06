/**
 * Probe Vertex for curated kind-0 presence (ranking signal).
 * Shared by server feed builder and client fallback ranking.
 */

import { SimplePool } from "nostr-tools";
import {
  VERTEX_PROFILE_RELAY,
  VERTEX_PROFILE_AUTHOR_CHUNK,
  RELAY_MAX_WAIT_MS,
  chunkArray,
} from "./trendingShared.js";

function isHexPubkey(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Pubkeys that have a kind 0 on Vertex's curated relay.
 * Returns `null` when Vertex could not be queried (fail-open: skip demotion).
 *
 * @param {string[]} pubkeys
 * @returns {Promise<Set<string> | null>}
 */
export async function fetchVertexProfilePubkeys(pubkeys) {
  const unique = [
    ...new Set(
      pubkeys.map((pubkey) => pubkey.toLowerCase()).filter(isHexPubkey)
    ),
  ];
  if (unique.length === 0) return new Set();

  const found = new Set();
  let queriedOk = false;
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;

  try {
    for (const authors of chunkArray(unique, VERTEX_PROFILE_AUTHOR_CHUNK)) {
      try {
        const events = await pool.querySync(
          [VERTEX_PROFILE_RELAY],
          { kinds: [0], authors, limit: authors.length },
          { maxWait: RELAY_MAX_WAIT_MS }
        );
        queriedOk = true;
        for (const event of events) {
          if (typeof event.pubkey === "string") {
            found.add(event.pubkey.toLowerCase());
          }
        }
      } catch {
        // Try remaining chunks; if none succeed we fail open below.
      }
    }
  } finally {
    pool.destroy();
  }

  return queriedOk ? found : null;
}

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

/** Same string SimplePool emits when subscribeEose completes cleanly. */
const EOSE_CLOSE_REASON = "closed automatically on eose";

function isHexPubkey(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * querySync resolves [] on connection failure / timeout. Use EOSE close
 * reason so outages fail open instead of looking like "no profiles".
 *
 * @param {SimplePool} pool
 * @param {string[]} authors
 * @returns {Promise<{ events: import("nostr-tools").Event[]; ok: boolean }>}
 */
function queryVertexChunk(pool, authors) {
  return new Promise((resolve) => {
    const events = [];
    pool.subscribeEose(
      [VERTEX_PROFILE_RELAY],
      { kinds: [0], authors, limit: authors.length },
      {
        maxWait: RELAY_MAX_WAIT_MS,
        onevent(event) {
          events.push(event);
        },
        onclose(reasons) {
          const closeReason = reasons[0]?.reason ?? "unknown";
          resolve({ events, ok: closeReason === EOSE_CLOSE_REASON });
        },
      }
    );
  });
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
  const pool = new SimplePool();
  pool.maxWaitForConnection = RELAY_MAX_WAIT_MS;

  try {
    for (const authors of chunkArray(unique, VERTEX_PROFILE_AUTHOR_CHUNK)) {
      let events;
      let ok;
      try {
        ({ events, ok } = await queryVertexChunk(pool, authors));
      } catch {
        return null;
      }
      if (!ok) return null;
      for (const event of events) {
        if (typeof event.pubkey === "string") {
          found.add(event.pubkey.toLowerCase());
        }
      }
    }
  } finally {
    pool.destroy();
  }

  return found;
}

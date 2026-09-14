import { nip19, type Event } from "nostr-tools";
import { isSafeHttpUrl } from "./identity";
import { sanitizeRelayHints } from "./mentions";

/** NIP-23 long-form content. */
export const KIND_LONG_FORM = 30023;

/** NIP-84 text highlight. */
export const KIND_HIGHLIGHT = 9802;

export type AddressPointer = {
  kind: number;
  pubkey: string;
  identifier: string;
  relayHints: string[];
};

export type LongFormMeta = {
  title: string | null;
  summary: string | null;
  image: string | null;
  tags: string[];
};

export function parseAddressPointer(raw: string): AddressPointer | null {
  const parts = raw.split(":");
  if (parts.length < 3) return null;
  const kind = Number(parts[0]);
  const pubkey = parts[1]?.trim().toLowerCase();
  const identifier = parts.slice(2).join(":").trim();
  if (!Number.isInteger(kind) || kind < 0 || !pubkey || !identifier) return null;
  return { kind, pubkey, identifier, relayHints: [] };
}

export function encodeNaddr(
  kind: number,
  pubkey: string,
  identifier: string,
  relayHints: readonly string[] = []
): string | null {
  try {
    return nip19.naddrEncode({
      kind,
      pubkey,
      identifier,
      relays: sanitizeRelayHints(relayHints).slice(0, 3),
    });
  } catch {
    return null;
  }
}

export function readLongFormMeta(event: Event): LongFormMeta {
  let title: string | null = null;
  let summary: string | null = null;
  let image: string | null = null;
  const tags: string[] = [];
  const seenTags = new Set<string>();

  for (const tag of event.tags) {
    const key = tag[0];
    const value = tag[1]?.trim();
    if (!value) continue;
    if (key === "title" && !title) title = value;
    else if (key === "summary" && !summary) summary = value;
    else if (key === "image" && !image && isSafeHttpUrl(value)) image = value;
    else if (key === "t") {
      const normalized = value.toLowerCase();
      if (!seenTags.has(normalized)) {
        seenTags.add(normalized);
        tags.push(value);
      }
    }
  }

  return { title, summary, image, tags };
}

/** Prefer NIP-84 `a` (article), then `r` (URL). */
export function highlightSourceFromTags(tags: string[][]): {
  address?: AddressPointer;
  url?: string;
} {
  let address: AddressPointer | undefined;
  let url: string | undefined;

  for (const tag of tags) {
    if (tag[0] === "a" && !address) {
      const parsed = parseAddressPointer(tag[1] ?? "");
      if (parsed?.kind === KIND_LONG_FORM) {
        address = {
          ...parsed,
          relayHints: sanitizeRelayHints(tag[2] ? [tag[2]] : []),
        };
      }
    } else if (tag[0] === "r" && !url) {
      const candidate = tag[1]?.trim();
      if (candidate && isSafeHttpUrl(candidate)) url = candidate;
    }
  }

  return { address, url };
}

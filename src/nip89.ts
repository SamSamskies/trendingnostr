import { SimplePool, type Event } from "nostr-tools";
import { isSafeHttpUrl } from "./identity";
import { parseNostrEntity } from "./mentions";
import {
  clientHref,
  clientsForPlatform,
  detectClientPlatform,
  MAX_RELAY_HINTS,
  type ClientPlatform,
} from "./nostr-clients";
import { RELAY_MAX_WAIT_MS } from "./nostr";

/** Handler information events (NIP-89). */
export const HANDLER_KIND = 31990;

/**
 * Relays that index kind 31990. Direct handler lookup (bypassing kind 31989)
 * should stay on well-known relays to limit spam.
 */
export const HANDLER_RELAYS = [
  "wss://relay.ditto.pub",
  "wss://relay.primal.net",
  "wss://relay.damus.io",
] as const;

const HANDLER_QUERY_LIMIT = 80;
const MAX_HANDLER_LINKS = 10;
const CACHE_TTL_MS = 10 * 60 * 1000;

const NIP19_TYPES = new Set([
  "npub",
  "nprofile",
  "note",
  "nevent",
  "naddr",
  "nrelay",
  "nsec",
]);

const BLOCKED_PROTOCOLS = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
]);

export type OpenInLink = {
  id: string;
  name: string;
  href: string;
};

type HandlerCacheEntry = {
  fetchedAt: number;
  events: Event[];
  recs: Map<string, number>;
};

function knownClientLinks(
  code: string,
  platform: ClientPlatform
): OpenInLink[] {
  return clientsForPlatform(platform).map((client) => ({
    id: client.id,
    name: client.name,
    href: clientHref(client, code, "note"),
  }));
}

export function fillBech32Template(
  template: string,
  code: string
): string | null {
  let filled = template;
  if (filled.includes("<bech32>")) {
    filled = filled.replaceAll("<bech32>", code);
  }
  if (filled.includes("{bech32}")) {
    filled = filled.replaceAll("{bech32}", code);
  }
  if (/\bbech32\b/.test(filled)) {
    filled = filled.replaceAll("bech32", code);
  }
  if (filled === template || filled.includes("bech32")) return null;
  return filled;
}

function isSafeHandlerHref(href: string): boolean {
  if (isSafeHttpUrl(href)) return true;
  try {
    const url = new URL(href);
    if (BLOCKED_PROTOCOLS.has(url.protocol.toLowerCase())) return false;
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

function handlerName(event: Event, href: string): string {
  try {
    const meta = JSON.parse(event.content) as Record<string, unknown>;
    const name =
      (typeof meta.display_name === "string" && meta.display_name.trim()) ||
      (typeof meta.displayName === "string" && meta.displayName.trim()) ||
      (typeof meta.name === "string" && meta.name.trim());
    if (name) return name;
  } catch {
    // Content is optional kind-0 JSON.
  }
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "Nostr app";
  }
}

function handlerCoord(event: Event): string {
  const d = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
  return `${HANDLER_KIND}:${event.pubkey}:${d}`;
}

function recommendationCounts(events: Event[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 31989) continue;
    for (const tag of event.tags) {
      if (tag[0] !== "a" || !tag[1]?.startsWith(`${HANDLER_KIND}:`)) continue;
      counts.set(tag[1], (counts.get(tag[1]) ?? 0) + 1);
    }
  }
  return counts;
}

function uniqueHandlerEvents(
  events: Event[],
  kind: number,
  recs: Map<string, number>
): Event[] {
  const kindKey = String(kind);
  const byCoord = new Map<string, Event>();
  for (const event of events) {
    if (event.kind !== HANDLER_KIND) continue;
    if (!event.tags.some((tag) => tag[0] === "k" && tag[1] === kindKey)) {
      continue;
    }
    const key = handlerCoord(event);
    const prev = byCoord.get(key);
    if (prev && prev.created_at >= event.created_at) continue;
    byCoord.set(key, event);
  }
  return [...byCoord.values()].sort((a, b) => {
    const recDiff =
      (recs.get(handlerCoord(b)) ?? 0) - (recs.get(handlerCoord(a)) ?? 0);
    if (recDiff !== 0) return recDiff;
    return b.created_at - a.created_at;
  });
}

function pickTemplate(
  event: Event,
  platform: ClientPlatform,
  entityType: string
): string | null {
  const tagNames =
    platform === "web" ? ["web"] : [platform, "web"];
  for (const tagName of tagNames) {
    const tags = event.tags.filter((tag) => tag[0] === tagName && tag[1]);
    const specific = tags.find((tag) => tag[2] === entityType);
    if (specific?.[1]) return specific[1];
    const generic = tags.find((tag) => !tag[2] || !NIP19_TYPES.has(tag[2]));
    if (generic?.[1]) return generic[1];
  }
  return null;
}

function linksFromHandlers(
  events: Event[],
  kind: number,
  code: string,
  platform: ClientPlatform,
  recs: Map<string, number>
): OpenInLink[] {
  const links: OpenInLink[] = [];
  const seenNames = new Set<string>();

  for (const event of uniqueHandlerEvents(events, kind, recs)) {
    const template = pickTemplate(event, platform, "naddr");
    if (!template) continue;
    const href = fillBech32Template(template, code);
    if (!href || !isSafeHandlerHref(href)) continue;
    const name = handlerName(event, href);
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    links.push({
      id: `${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1] ?? event.id}`,
      name,
      href,
    });
    if (links.length >= MAX_HANDLER_LINKS) break;
  }

  return links;
}

function isNjumpHref(href: string): boolean {
  try {
    return new URL(href).hostname.replace(/^www\./, "") === "njump.me";
  } catch {
    return false;
  }
}

function mergeAddressLinks(
  code: string,
  handlers: OpenInLink[],
  platform: ClientPlatform
): OpenInLink[] {
  const known = knownClientLinks(code, platform);
  const links: OpenInLink[] = [];
  const seen = new Set<string>();
  const add = (link: OpenInLink | null) => {
    if (!link) return;
    const key = link.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  const njump = known.find((link) => link.id === "njump") ?? null;
  for (const link of known) {
    if (link.id === "njump") continue;
    add(link);
  }
  for (const handler of handlers) add(handler);
  if (!links.some((link) => isNjumpHref(link.href))) add(njump);
  return links;
}

async function queryHandlerBundle(
  kind: number,
  extraRelays: string[]
): Promise<{ events: Event[]; recs: Map<string, number> }> {
  const relays = [
    ...new Set(
      [...HANDLER_RELAYS, ...extraRelays.slice(0, MAX_RELAY_HINTS)].filter(
        (url) => {
          try {
            return new URL(url).hostname.replace(/^www\./, "") !== "relay.nostr.band";
          } catch {
            return false;
          }
        }
      )
    ),
  ];
  const pool = new SimplePool();
  const byId = new Map<string, Event>();
  const recEvents: Event[] = [];
  const kindKey = String(kind);

  try {
    const settled = await Promise.allSettled(
      relays.flatMap((relay) => [
        pool.querySync(
          [relay],
          {
            kinds: [HANDLER_KIND],
            "#k": [kindKey],
            limit: HANDLER_QUERY_LIMIT,
          },
          { maxWait: RELAY_MAX_WAIT_MS }
        ),
        pool.querySync(
          [relay],
          {
            kinds: [31989],
            "#d": [kindKey],
            limit: HANDLER_QUERY_LIMIT,
          },
          { maxWait: RELAY_MAX_WAIT_MS }
        ),
      ])
    );

    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const event of result.value) {
        if (event.kind === 31989) {
          recEvents.push(event);
          continue;
        }
        const prev = byId.get(event.id);
        if (prev && prev.created_at >= event.created_at) continue;
        byId.set(event.id, event);
      }
    }
  } catch {
    // Return whatever arrived.
  } finally {
    pool.destroy();
  }

  return { events: [...byId.values()], recs: recommendationCounts(recEvents) };
}

type HandlerBundle = {
  events: Event[];
  recs: Map<string, number>;
};

const handlerCache = new Map<number, HandlerCacheEntry>();
const inflight = new Map<number, Promise<HandlerBundle>>();

async function handlerBundleForKind(
  kind: number,
  extraRelays: string[]
): Promise<HandlerBundle> {
  const cached = handlerCache.get(kind);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { events: cached.events, recs: cached.recs };
  }

  const pending = inflight.get(kind);
  if (pending) return pending;

  const request = queryHandlerBundle(kind, extraRelays).then((bundle) => {
    handlerCache.set(kind, {
      fetchedAt: Date.now(),
      events: bundle.events,
      recs: bundle.recs,
    });
    inflight.delete(kind);
    return bundle;
  });
  inflight.set(kind, request);
  return request;
}

export function addressPlaceholderLinks(
  code: string,
  platform: ClientPlatform = detectClientPlatform()
): OpenInLink[] {
  return knownClientLinks(code, platform);
}

export async function fetchAddressOpenInLinks(
  code: string,
  platform: ClientPlatform = detectClientPlatform()
): Promise<OpenInLink[]> {
  const fallbacks = knownClientLinks(code, platform);
  const entity = parseNostrEntity(code);
  if (entity?.type !== "address") return fallbacks;

  try {
    const bundle = await handlerBundleForKind(entity.kind, entity.relayHints);
    return mergeAddressLinks(
      code,
      linksFromHandlers(
        bundle.events,
        entity.kind,
        code,
        platform,
        bundle.recs
      ),
      platform
    );
  } catch {
    return fallbacks;
  }
}

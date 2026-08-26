import { nip19 } from "nostr-tools";
import type { LocatedEvent } from "./nostr";

export type ClientPlatform = "android" | "ios" | "web";

export type OpenInKind = "note" | "profile" | "address";

export type NostrClient = {
  id: string;
  name: string;
  platform: "native" | "web" | "ios" | "android";
  url: string;
  /** Defaults to `url`. Use when the profile path differs (e.g. Primal `/p/` vs `/e/`). */
  profileUrl?: string;
};

/** Keep nevents shareable; extra relays mostly bloat the bech32 string. */
export const MAX_RELAY_HINTS = 3;

/**
 * Kind-1 clients, ordered like njump: default handler, then native apps,
 * then web. Platform filtering happens in `clientsForPlatform`.
 * The `nostr:` default handler is omitted on desktop — browsers there
 * almost never have a registered scheme handler.
 *
 * Address (`naddr`) pickers use `ADDRESS_CLIENT_IDS` instead of this full
 * list — many kind-1 apps do not handle long-form/parameterized events.
 */
export const NOSTR_CLIENTS: NostrClient[] = [
  {
    id: "native",
    name: "Your default app",
    platform: "native",
    url: "nostr:{code}",
  },
  { id: "damus", name: "Damus", platform: "ios", url: "damus:{code}" },
  { id: "nos", name: "Nos", platform: "ios", url: "nos:{code}" },
  { id: "nostur", name: "Nostur", platform: "ios", url: "nostur:{code}" },
  { id: "primal-ios", name: "Primal", platform: "ios", url: "primal:{code}" },
  {
    id: "amethyst",
    name: "Amethyst",
    platform: "android",
    url: "intent:{code}#Intent;scheme=nostr;package=com.vitorpamplona.amethyst;end;",
  },
  {
    id: "primal-android",
    name: "Primal",
    platform: "android",
    url: "intent:{code}#Intent;scheme=nostr;package=net.primal.android;end;",
  },
  {
    id: "voyage",
    name: "Voyage",
    platform: "android",
    url: "intent:{code}#Intent;scheme=nostr;package=com.dluvian.voyage;end;",
  },
  {
    id: "jumble",
    name: "Jumble",
    platform: "web",
    url: "https://jumble.social/{code}",
  },
  {
    id: "primal-web",
    name: "Primal",
    platform: "web",
    url: "https://primal.net/e/{code}",
    profileUrl: "https://primal.net/p/{code}",
  },
  {
    id: "coracle",
    name: "Coracle",
    platform: "web",
    url: "https://coracle.social/{code}",
  },
  {
    id: "fevela",
    name: "Fevela",
    platform: "web",
    url: "https://fevela.me/{code}",
  },
  {
    id: "yakihonne",
    name: "YakiHonne",
    platform: "web",
    url: "https://yakihonne.com/{code}",
  },
  {
    id: "njump",
    name: "njump",
    platform: "web",
    url: "https://njump.me/{code}",
  },
];

/**
 * Known clients that actually open `naddr` well. Do not discover extra
 * apps via NIP-89 here: this app has no follow graph, so kind 31990 is an
 * untrusted redirect surface.
 */
export const ADDRESS_CLIENT_IDS = new Set([
  "native",
  "primal-ios",
  "amethyst",
  "primal-android",
  "primal-web",
  "yakihonne",
  "njump",
]);

export function detectClientPlatform(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent
): ClientPlatform {
  if (/android/i.test(userAgent)) return "android";
  if (/iPad|iPhone|iPod/i.test(userAgent)) return "ios";
  return "web";
}

export function encodeNevent(note: LocatedEvent): string {
  return nip19.neventEncode({
    id: note.id,
    author: note.pubkey,
    kind: note.kind,
    relays: note.seenOn.slice(0, MAX_RELAY_HINTS),
  });
}

export function clientHref(
  client: NostrClient,
  code: string,
  kind: OpenInKind = "note"
): string {
  const template = kind === "profile" ? (client.profileUrl ?? client.url) : client.url;
  return template.replaceAll("{code}", code);
}

export function clientsForPlatform(
  platform: ClientPlatform,
  kind: OpenInKind = "note"
): NostrClient[] {
  const eligible = NOSTR_CLIENTS.filter((client) => {
    if (client.platform === "native" && platform === "web") {
      return false;
    }
    if (
      client.platform !== "native" &&
      client.platform !== "web" &&
      client.platform !== platform
    ) {
      return false;
    }
    if (kind === "address" && !ADDRESS_CLIENT_IDS.has(client.id)) {
      return false;
    }
    return true;
  });

  const seen = new Set<string>();
  const clients: NostrClient[] = [];
  for (const client of eligible) {
    if (seen.has(client.name)) continue;
    seen.add(client.name);
    clients.push(client);
  }
  return clients;
}

export function isWebClientHref(href: string): boolean {
  return href.startsWith("https://") || href.startsWith("http://");
}

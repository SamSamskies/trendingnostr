import { nip19, type Event } from "nostr-tools";

export type Kind0Profile = {
  picture?: string;
  displayName?: string;
  nip05?: string;
};

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "local" || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (host.includes(":")) {
    if (
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    ) {
      return true;
    }
    const mapped = /:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
    if (mapped) return isPrivateOrLocalHostname(mapped[1]);
  }

  return false;
}

export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return !isPrivateOrLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function parseProfileContent(content: string): Kind0Profile {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    const picture =
      typeof data.picture === "string" ? data.picture.trim() : "";
    const displayName =
      (typeof data.display_name === "string" && data.display_name.trim()) ||
      (typeof data.name === "string" && data.name.trim()) ||
      "";
    const nip05 = typeof data.nip05 === "string" ? data.nip05.trim() : "";

    return {
      picture: isSafeHttpUrl(picture) ? picture : undefined,
      displayName: displayName || undefined,
      nip05: nip05 || undefined,
    };
  } catch {
    return {};
  }
}

export function parseKind0Profile(event: Event): Kind0Profile {
  return parseProfileContent(event.content);
}

/** Nip-05 hosts whose authors are hidden from the trending feed. */
const BLOCKED_NIP05_HOSTS = new Set(["nostrmag.com"]);

/** Hostname from `name@domain` (lowercased), or null if missing/malformed. */
export function nip05Hostname(nip05: string | undefined): string | null {
  if (!nip05) return null;
  const at = nip05.lastIndexOf("@");
  if (at < 0 || at === nip05.length - 1) return null;
  const host = nip05
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return host || null;
}

/** True when nip-05 is on a blocked host (including subdomains). */
export function isBlockedNip05(nip05: string | undefined): boolean {
  const host = nip05Hostname(nip05);
  if (!host) return false;
  for (const blocked of BLOCKED_NIP05_HOSTS) {
    if (host === blocked || host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

export function isBlockedAuthorProfile(
  profile: Kind0Profile | undefined
): boolean {
  return isBlockedNip05(profile?.nip05);
}

export function encodeNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return "";
  }
}

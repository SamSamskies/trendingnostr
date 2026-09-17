import { nip19, type Event } from "nostr-tools";
import { isNip05, queryProfile, type Nip05 } from "nostr-tools/nip05";

export type Kind0Profile = {
  picture?: string;
  displayName?: string;
  nip05?: string;
  /** NIP-57 lightning address (`name@domain`), lowercased when present. */
  lud16?: string;
  /** BIP-352 silent payment address (`sp1…` / `tsp1…`). */
  sp?: string;
};

/** True for loopback, link-local, RFC1918, and .local hostnames. */
export function isPrivateOrLocalHostname(hostname: string): boolean {
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
    const lud16Raw = typeof data.lud16 === "string" ? data.lud16.trim() : "";
    const lud16 = normalizeLud16(lud16Raw) ?? "";
    const spRaw = typeof data.sp === "string" ? data.sp.trim() : "";
    const sp = normalizeSilentPayment(spRaw) ?? "";

    return {
      picture: isSafeHttpUrl(picture) ? picture : undefined,
      displayName: displayName || undefined,
      nip05: nip05 || undefined,
      lud16: lud16 || undefined,
      sp: sp || undefined,
    };
  } catch {
    return {};
  }
}

export function parseKind0Profile(event: Event): Kind0Profile {
  return parseProfileContent(event.content);
}

/** Nip-05 hosts whose authors are hidden from the trending feed. */
const BLOCKED_NIP05_HOSTS = new Set(["nostrmag.com", "cdnsoft.net"]);

/**
 * Display names (kind 0 `display_name` / `name`) whose authors are hidden.
 * Compared case-insensitively after trim + whitespace collapse.
 */
const BLOCKED_DISPLAY_NAMES = new Set([
  "craig andrew",
  "imad from gaza🍉",
  "rwatimes",
]);

/**
 * Lightning addresses (kind 0 `lud16`) whose authors are hidden.
 * Compared after trim + lowercase (`name@domain`).
 */
const BLOCKED_LUD16_ADDRESSES = new Set([
  "solemngreece21@walletofsatoshi.com",
  "blindray60@walletofsatoshi.com",
]);

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

/** Normalize for blocked-display-name matching. */
function normalizeDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const SILENT_PAYMENT_RE =
  /^(sp|tsp)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{40,130}$/;

/** Normalize BIP-352 silent payment address; null if missing/malformed. */
function normalizeSilentPayment(sp: string | undefined): string | null {
  if (!sp) return null;
  const trimmed = sp.trim().toLowerCase();
  return SILENT_PAYMENT_RE.test(trimmed) ? trimmed : null;
}

/** Normalize lud16 for matching; null if missing/malformed. */
function normalizeLud16(lud16: string | undefined): string | null {
  if (!lud16) return null;
  const trimmed = lud16.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at).trim();
  const host = trimmed
    .slice(at + 1)
    .trim()
    .replace(/\.$/, "");
  if (!local || !host || host.includes("@")) return null;
  return `${local}@${host}`;
}

/** True when the profile display name is on the block list. */
export function isBlockedDisplayName(displayName: string | undefined): boolean {
  if (!displayName) return false;
  return BLOCKED_DISPLAY_NAMES.has(normalizeDisplayName(displayName));
}

/** True when the profile lightning address is on the block list. */
export function isBlockedLud16(lud16: string | undefined): boolean {
  const normalized = normalizeLud16(lud16);
  if (!normalized) return false;
  return BLOCKED_LUD16_ADDRESSES.has(normalized);
}

export function isBlockedAuthorProfile(
  profile: Kind0Profile | undefined
): boolean {
  return (
    isBlockedNip05(profile?.nip05) ||
    isBlockedDisplayName(profile?.displayName) ||
    isBlockedLud16(profile?.lud16)
  );
}

export function encodeNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return "";
  }
}

const NIP05_VERIFY_TTL_MS = 6 * 60 * 60 * 1000;
const NIP05_VERIFY_NEGATIVE_TTL_MS = 5 * 60 * 1000;

type Nip05VerifyEntry = { verified: boolean; checkedAt: number };

const nip05VerifyCache = new Map<string, Nip05VerifyEntry>();
const nip05VerifyInflight = new Map<string, Promise<boolean>>();

function nip05VerifyCacheKey(pubkey: string, nip05: string): string {
  return `${pubkey}|${nip05.trim().toLowerCase()}`;
}

function readNip05VerifyEntry(
  pubkey: string,
  nip05: string
): Nip05VerifyEntry | null {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author) || !nip05.trim()) return null;
  const entry = nip05VerifyCache.get(nip05VerifyCacheKey(author, nip05));
  if (!entry) return null;
  const ttl = entry.verified
    ? NIP05_VERIFY_TTL_MS
    : NIP05_VERIFY_NEGATIVE_TTL_MS;
  if (Date.now() - entry.checkedAt > ttl) return null;
  return entry;
}

/** Sync cache hit for tip-drawer NIP-05 state; null if missing/stale. */
export function readCachedNip05Verified(
  pubkey: string,
  nip05: string
): boolean | null {
  return readNip05VerifyEntry(pubkey, nip05)?.verified ?? null;
}

/**
 * Confirm kind 0 `nip05` maps to `pubkey` via `/.well-known/nostr.json`.
 * Client-side only — CORS/network failures resolve to false (no checkmark).
 */
export async function verifyNip05(
  pubkey: string,
  nip05: string
): Promise<boolean> {
  const author = pubkey.trim().toLowerCase();
  const address = nip05.trim();
  if (!/^[0-9a-f]{64}$/.test(author) || !isNip05(address)) return false;

  const host = nip05Hostname(address);
  if (!host || isPrivateOrLocalHostname(host)) return false;

  const cached = readNip05VerifyEntry(author, address);
  if (cached) return cached.verified;

  const key = nip05VerifyCacheKey(author, address);
  const pending = nip05VerifyInflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    let verified = false;
    try {
      const pointer = await queryProfile(address as Nip05);
      verified =
        !!pointer?.pubkey && pointer.pubkey.toLowerCase() === author;
    } catch {
      verified = false;
    }
    nip05VerifyCache.set(key, { verified, checkedAt: Date.now() });
    return verified;
  })();

  nip05VerifyInflight.set(key, request);
  try {
    return await request;
  } finally {
    nip05VerifyInflight.delete(key);
  }
}

/** True when `value` is a plausible NIP-05 identifier. */
export { isNip05 };

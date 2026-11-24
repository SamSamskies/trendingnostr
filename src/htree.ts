import {
  BlossomStore,
  FallbackStore,
  HashTree,
  LinkType,
  MemoryStore,
  cid,
  fromHex,
  nhashDecode,
  objectKeyFromHex,
  toHex,
  visibilityHex,
  type CID,
  type Hash,
  type Store,
} from "@hashtree/core";
import { nip19, type Event } from "nostr-tools";

/**
 * Default read-only Blossom servers for resolving Hashtree chunks.
 * `cdn.iris.to` and `upload.iris.to` are the canonical Iris/Hashtree endpoints
 * and both serve `Access-Control-Allow-Origin: *` for browser fetches.
 */
export const DEFAULT_HTREE_BLOSSOM_SERVERS = [
  { url: "https://cdn.iris.to", read: true, write: false },
  { url: "https://upload.iris.to", read: true, write: false },
] as const;

/** Cap media downloads at 50 MB so a huge file cannot exhaust tab memory. */
export const MAX_HTREE_MEDIA_BYTES = 50 * 1024 * 1024;

/**
 * Cap in-memory Blossom chunk cache across the tab session. Chunks remain
 * recoverable via FallbackStore → Blossom after LRU eviction.
 */
export const MAX_HTREE_CHUNK_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * MemoryStore wrapper that evicts least-recently-used chunks when the byte
 * budget is exceeded, so long feeds with many `htree://` attachments cannot
 * retain unbounded ciphertext for the whole tab lifetime.
 */
class BoundedMemoryStore implements Store {
  private readonly inner = new MemoryStore();
  /** LRU order: oldest at the front. */
  private readonly order: string[] = [];
  private readonly sizes = new Map<string, number>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  async put(hash: Hash, data: Uint8Array): Promise<boolean> {
    const key = toHex(hash);
    if (this.sizes.has(key)) {
      this.touch(key);
      return false;
    }
    const added = await this.inner.put(hash, data);
    if (!added) {
      this.touch(key);
      return false;
    }
    this.sizes.set(key, data.byteLength);
    this.order.push(key);
    this.bytes += data.byteLength;
    await this.evictIfNeeded(key);
    return true;
  }

  async get(hash: Hash): Promise<Uint8Array | null> {
    const data = await this.inner.get(hash);
    if (data) this.touch(toHex(hash));
    return data;
  }

  async has(hash: Hash): Promise<boolean> {
    return this.inner.has(hash);
  }

  async delete(hash: Hash): Promise<boolean> {
    const key = toHex(hash);
    const size = this.sizes.get(key);
    const deleted = await this.inner.delete(hash);
    if (deleted) {
      if (size !== undefined) this.bytes -= size;
      this.sizes.delete(key);
      const idx = this.order.indexOf(key);
      if (idx >= 0) this.order.splice(idx, 1);
    }
    return deleted;
  }

  private touch(key: string): void {
    const idx = this.order.indexOf(key);
    if (idx < 0) return;
    this.order.splice(idx, 1);
    this.order.push(key);
  }

  private async evictIfNeeded(retainKey: string): Promise<void> {
    while (this.bytes > this.maxBytes && this.order.length > 0) {
      const oldest = this.order[0]!;
      if (oldest === retainKey && this.order.length === 1) break;
      if (oldest === retainKey) {
        this.touch(retainKey);
        continue;
      }
      await this.delete(fromHex(oldest));
    }
  }
}

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_64_OR_66 = /^[0-9a-f]{64}(?:[0-9a-f]{2})?$/i;

export type ParsedHtreeUrl =
  | {
      type: "nhash";
      cid: CID;
      pathSegments: string[];
      normalizedUrl: string;
    }
  | {
      type: "npub";
      pubkey: string;
      treeName: string;
      pathSegments: string[];
      linkKey?: string;
      normalizedUrl: string;
    };

export function isHtreeUrl(raw: string): boolean {
  return /^htree:\/\//i.test(raw.trim());
}

/** Strip trailing prose punctuation just like `normalizeHttpUrl`. */
export function normalizeHtreeUrl(raw: string): string {
  return raw.trim().replace(/[),.;:!?]+$/g, "");
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function extractLinkKeyFromFragment(fragment: string): string | undefined {
  if (!fragment) return undefined;
  const params = new URLSearchParams(fragment);
  const key = params.get("k")?.trim();
  if (key && HEX_64_OR_66.test(key)) {
    return key.toLowerCase();
  }
  return undefined;
}

/**
 * Parse an `htree://` URI according to the Hashtree references spec:
 * - `htree://<nhash>[/<path>]` (immutable)
 * - `htree://<npub>/<tree-name>[/<path>][#k=<hex>]` (mutable)
 *
 * Splits path segments before percent-decoding each segment individually, and
 * strips query strings and fragments before path splitting.
 */
export function parseHtreeUrl(raw: string): ParsedHtreeUrl | null {
  const normalizedUrl = normalizeHtreeUrl(raw);
  if (!/^htree:\/\//i.test(normalizedUrl)) return null;

  let rest = normalizedUrl.slice("htree://".length);
  let fragment = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }

  const queryIdx = rest.indexOf("?");
  if (queryIdx >= 0) {
    rest = rest.slice(0, queryIdx);
  }

  // Drop a single trailing slash (e.g. `htree://nhash1.../`).
  if (rest.endsWith("/")) {
    rest = rest.slice(0, -1);
  }

  const rawSegments = rest.split("/");
  const host = rawSegments[0]?.trim();
  if (!host) return null;

  // Reject empty interior segments (e.g. `htree://nhash1...//file.jpg`).
  const rawPathSegments = rawSegments.slice(1);
  if (rawPathSegments.some((seg) => seg.length === 0)) return null;

  const hostLower = host.toLowerCase();

  if (hostLower.startsWith("nhash1")) {
    let decodedCid: CID;
    try {
      decodedCid = nhashDecode(hostLower);
    } catch {
      return null;
    }

    const pathSegments: string[] = [];
    for (const seg of rawPathSegments) {
      const decoded = decodeSegment(seg);
      if (decoded === null) return null;
      pathSegments.push(decoded);
    }

    return {
      type: "nhash",
      cid: decodedCid,
      pathSegments,
      normalizedUrl,
    };
  }

  if (hostLower.startsWith("npub1")) {
    if (rawPathSegments.length < 1) return null;

    let pubkey: string;
    try {
      const decoded = nip19.decode(hostLower);
      if (decoded.type !== "npub" || typeof decoded.data !== "string") {
        return null;
      }
      pubkey = decoded.data.toLowerCase();
    } catch {
      return null;
    }

    const treeName = decodeSegment(rawPathSegments[0]);
    if (!treeName) return null;

    const pathSegments: string[] = [];
    for (const seg of rawPathSegments.slice(1)) {
      const decoded = decodeSegment(seg);
      if (decoded === null) return null;
      pathSegments.push(decoded);
    }

    const linkKey = extractLinkKeyFromFragment(fragment);

    return {
      type: "npub",
      pubkey,
      treeName,
      pathSegments,
      ...(linkKey ? { linkKey } : {}),
      normalizedUrl,
    };
  }

  return null;
}

/**
 * Extract the root CID (hash + optional decryption key) from a Hashtree
 * mutable root Nostr event (kind 30064 or legacy 30078).
 */
export async function extractRootCidFromEvent(
  event: Pick<Event, "tags">,
  linkKeyHex?: string
): Promise<CID | null> {
  let hashHex: string | undefined;
  let keyHex: string | undefined;
  let encryptedKeyHex: string | undefined;
  let keyIdHex: string | undefined;
  let hasSelfEncryptedKey = false;

  for (const tag of event.tags) {
    const [name, value] = tag;
    if (!value) continue;
    if (name === "hash" && HEX_64.test(value)) {
      hashHex = value.toLowerCase();
    } else if (name === "key" && HEX_64_OR_66.test(value)) {
      keyHex = value.toLowerCase();
    } else if (name === "encryptedKey" && /^[0-9a-f]+$/i.test(value)) {
      encryptedKeyHex = value.toLowerCase();
    } else if (name === "keyId" && /^[0-9a-f]{16}$/i.test(value)) {
      keyIdHex = value.toLowerCase();
    } else if (name === "selfEncryptedKey") {
      hasSelfEncryptedKey = true;
    }
  }

  if (!hashHex) return null;
  const hash = fromHex(hashHex);

  if (keyHex) {
    try {
      return cid(hash, objectKeyFromHex(keyHex));
    } catch {
      return null;
    }
  }

  if (encryptedKeyHex) {
    if (!linkKeyHex) return null;
    if (keyIdHex) {
      const computed = await visibilityHex.computeKeyId(linkKeyHex);
      if (computed.toLowerCase() !== keyIdHex) return null;
    }
    const decryptedHex = await visibilityHex.decryptKeyFromLink(
      encryptedKeyHex,
      linkKeyHex
    );
    if (!decryptedHex) return null;
    try {
      return cid(hash, objectKeyFromHex(decryptedHex));
    } catch {
      return null;
    }
  }

  // Owner-private root cannot be decrypted without the author's Nostr key.
  if (hasSelfEncryptedKey) return null;

  return cid(hash);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogg: "video/ogg",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

function mimeFromMagicBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  return null;
}

export function detectMediaMimeType(
  filename: string | undefined,
  bytes: Uint8Array
): string {
  // Prefer magic bytes: advisory htree:// filenames can disagree with content.
  const fromMagic = mimeFromMagicBytes(bytes);
  if (fromMagic) return fromMagic;

  if (filename) {
    const dot = filename.lastIndexOf(".");
    if (dot > 0) {
      const ext = filename.slice(dot + 1).toLowerCase();
      if (ext in MIME_BY_EXTENSION) {
        return MIME_BY_EXTENSION[ext];
      }
    }
  }
  return "application/octet-stream";
}

let sharedTree: HashTree | null = null;

function getSharedHashTree(): HashTree {
  if (!sharedTree) {
    const store = new FallbackStore({
      primary: new BoundedMemoryStore(MAX_HTREE_CHUNK_CACHE_BYTES),
      fallbacks: [
        new BlossomStore({
          servers: DEFAULT_HTREE_BLOSSOM_SERVERS.map((server) => ({ ...server })),
          getTimeoutMs: 15_000,
        }),
      ],
    });
    sharedTree = new HashTree({ store });
  }
  return sharedTree;
}

export interface ReadHtreeMediaDeps {
  tree?: HashTree;
  fetchRootEvent?: (pubkey: string, treeName: string) => Promise<Event | null>;
  maxBytes?: number;
}

/**
 * Fetch, verify, and decrypt the media bytes referenced by an `htree://` URL.
 * Supports both directory roots (`htree://<root>/<path>`) and single-file
 * `nhash` roots with an optional advisory filename (`htree://<nhash>/file.jpg`).
 */
export async function readHtreeMediaBytes(
  rawUrl: string,
  deps: ReadHtreeMediaDeps = {}
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const parsed = parseHtreeUrl(rawUrl);
  if (!parsed) return null;

  const tree = deps.tree ?? getSharedHashTree();
  const maxBytes = deps.maxBytes ?? MAX_HTREE_MEDIA_BYTES;

  let rootCid: CID;
  if (parsed.type === "nhash") {
    rootCid = parsed.cid;
  } else {
    const fetchRoot =
      deps.fetchRootEvent ??
      (async (pubkey: string, treeName: string) => {
        const { fetchHashtreeRootEvent } = await import("./nostr");
        return fetchHashtreeRootEvent(pubkey, treeName);
      });
    const event = await fetchRoot(parsed.pubkey, parsed.treeName);
    if (!event) return null;
    const extracted = await extractRootCidFromEvent(event, parsed.linkKey);
    if (!extracted) return null;
    rootCid = extracted;
  }

  let targetCid: CID;
  const isDir = await tree.isDirectory(rootCid);

  if (isDir) {
    if (parsed.pathSegments.length === 0) return null;
    const resolved = await tree.resolvePath(
      rootCid,
      parsed.pathSegments.join("/")
    );
    if (!resolved || resolved.type === LinkType.Dir) return null;
    targetCid = resolved.cid;
  } else {
    // Non-directory root: allow either an empty path or a single advisory
    // filename segment (e.g. `htree://<nhash>/1692-01.jpg` emitted by Iris).
    if (parsed.pathSegments.length > 1) return null;
    targetCid = rootCid;
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await tree.readFile(targetCid, { maxBytes });
  } catch {
    return null;
  }
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    return null;
  }

  const filename = parsed.pathSegments[parsed.pathSegments.length - 1];
  const mimeType = detectMediaMimeType(filename, bytes);
  return { bytes, mimeType };
}

/**
 * Match HASHTREE_ROOT_CACHE_TTL_MS in nostr.ts so mutable npub media refreshes
 * when replaceable roots are allowed to update.
 */
const HASHTREE_MUTABLE_BLOB_TTL_MS = 5 * 60 * 1000;

/**
 * Cap decrypted `blob:` object-URL cache across the session. Evicted entries
 * revoke their object URLs; media can be re-resolved from Blossom/chunks.
 */
export const MAX_HTREE_BLOB_CACHE_BYTES = 96 * 1024 * 1024;

type ResolvedBlobCacheEntry = {
  blobUrl: string;
  /** `null` for immutable nhash; set for replaceable npub trees. */
  expiresAt: number | null;
  byteLength: number;
};

const resolvedBlobUrlCache = new Map<string, ResolvedBlobCacheEntry>();
/** LRU order: oldest at the front. */
const resolvedBlobLruOrder: string[] = [];
let resolvedBlobCacheBytes = 0;
/** Refcounts for blob keys currently shown in the feed / lightbox. */
const retainedBlobKeys = new Map<string, number>();
const inFlightResolutionCache = new Map<string, Promise<string | null>>();

function touchResolvedBlobKey(key: string): void {
  const idx = resolvedBlobLruOrder.indexOf(key);
  if (idx < 0) return;
  resolvedBlobLruOrder.splice(idx, 1);
  resolvedBlobLruOrder.push(key);
}

function isRetainedBlobKey(key: string): boolean {
  return (retainedBlobKeys.get(key) ?? 0) > 0;
}

function removeResolvedBlobEntry(key: string): void {
  const entry = resolvedBlobUrlCache.get(key);
  if (!entry) return;
  URL.revokeObjectURL(entry.blobUrl);
  resolvedBlobCacheBytes -= entry.byteLength;
  resolvedBlobUrlCache.delete(key);
  const idx = resolvedBlobLruOrder.indexOf(key);
  if (idx >= 0) resolvedBlobLruOrder.splice(idx, 1);
}

function putResolvedBlobEntry(
  key: string,
  entry: ResolvedBlobCacheEntry
): void {
  sweepExpiredBlobEntries();
  if (resolvedBlobUrlCache.has(key)) {
    removeResolvedBlobEntry(key);
  }
  resolvedBlobUrlCache.set(key, entry);
  resolvedBlobLruOrder.push(key);
  resolvedBlobCacheBytes += entry.byteLength;

  let scanned = 0;
  while (
    resolvedBlobCacheBytes > MAX_HTREE_BLOB_CACHE_BYTES &&
    resolvedBlobLruOrder.length > 0 &&
    scanned < resolvedBlobLruOrder.length
  ) {
    const oldest = resolvedBlobLruOrder[0]!;
    scanned += 1;
    if (oldest === key && resolvedBlobLruOrder.length === 1) break;
    // Keep blobs that are still on screen; rotate them to the MRU end.
    if (oldest === key || isRetainedBlobKey(oldest)) {
      touchResolvedBlobKey(oldest);
      continue;
    }
    removeResolvedBlobEntry(oldest);
    scanned = 0;
  }
}

/**
 * Pure cache read: no LRU touch and no `revokeObjectURL`. Safe during React
 * render (e.g. `useState` initializers).
 */
function peekResolvedBlobEntry(
  rawUrl: string
): ResolvedBlobCacheEntry | undefined {
  const key = normalizeHtreeUrl(rawUrl);
  const entry = resolvedBlobUrlCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
    // Still painted: leave bytes until the media hook refreshes / releases.
    if (isRetainedBlobKey(key)) return entry;
    return undefined;
  }
  return entry;
}

/** Drop expired, unretained entries. Call from effects / resolve / put only. */
function sweepExpiredBlobEntries(): void {
  for (const key of [...resolvedBlobUrlCache.keys()]) {
    const entry = resolvedBlobUrlCache.get(key);
    if (!entry || entry.expiresAt === null) continue;
    if (Date.now() < entry.expiresAt) continue;
    if (isRetainedBlobKey(key)) continue;
    removeResolvedBlobEntry(key);
  }
}

/**
 * Mutating cache take for resolve / effect paths: touches LRU and sweeps
 * expired unretained entries.
 */
function takeResolvedBlobEntry(
  rawUrl: string
): ResolvedBlobCacheEntry | undefined {
  sweepExpiredBlobEntries();
  const key = normalizeHtreeUrl(rawUrl);
  const entry = resolvedBlobUrlCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
    if (isRetainedBlobKey(key)) {
      touchResolvedBlobKey(key);
      return entry;
    }
    removeResolvedBlobEntry(key);
    return undefined;
  }
  touchResolvedBlobKey(key);
  return entry;
}

/**
 * Pin a resolved blob so LRU eviction (and TTL cleanup) cannot revoke it while
 * an `<img>` / `<video>` is still showing it. Returns a release function.
 */
export function retainHtreeMediaUrl(rawUrl: string): () => void {
  const key = normalizeHtreeUrl(rawUrl);
  retainedBlobKeys.set(key, (retainedBlobKeys.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (retainedBlobKeys.get(key) ?? 1) - 1;
    if (next <= 0) retainedBlobKeys.delete(key);
    else retainedBlobKeys.set(key, next);
  };
}

/** Pure peek of a cached blob URL (no revoke). Safe during React render. */
export function getCachedHtreeMediaUrl(rawUrl: string): string | undefined {
  return peekResolvedBlobEntry(rawUrl)?.blobUrl;
}

/**
 * Remaining TTL for a cached mutable blob, or `null` if missing / immortal.
 * Pure peek — used by media hooks to schedule refresh after the root TTL.
 */
export function getCachedHtreeMediaTtlMs(rawUrl: string): number | null {
  const entry = peekResolvedBlobEntry(rawUrl);
  if (!entry || entry.expiresAt === null) return null;
  return Math.max(0, entry.expiresAt - Date.now());
}

type HashtreeRootCacheInvalidator = (
  pubkey: string,
  treeName: string
) => void;

/**
 * Wired from the app (MediaGrid) so invalidating media can also drop the
 * nostr root-event cache without a static htree→nostr import (keeps unit
 * tests extensionless-import friendly).
 */
let invalidateRootEventCache: HashtreeRootCacheInvalidator | undefined;

export function bindHashtreeRootCacheInvalidator(
  fn: HashtreeRootCacheInvalidator
): void {
  invalidateRootEventCache = fn;
}

/**
 * Drop a cached blob URL (revokes the object URL) and any in-flight resolve.
 * For mutable `npub` trees, also clears the kind 30064 root-event cache so
 * retries / refreshes re-query relays instead of reusing a stale root.
 */
export function invalidateHtreeMediaUrl(rawUrl: string): void {
  const key = normalizeHtreeUrl(rawUrl);
  removeResolvedBlobEntry(key);
  inFlightResolutionCache.delete(key);
  const parsed = parseHtreeUrl(key);
  if (parsed?.type === "npub") {
    invalidateRootEventCache?.(parsed.pubkey, parsed.treeName);
  }
}

/**
 * Resolve an `htree://` media URL to a local `blob:` URL, deduplicating
 * concurrent requests. Immutable `nhash` hits stay until LRU eviction; mutable
 * `npub` hits also expire with the root-event TTL so tree updates can appear.
 */
export function resolveHtreeMediaUrl(rawUrl: string): Promise<string | null> {
  const key = normalizeHtreeUrl(rawUrl);
  const cached = takeResolvedBlobEntry(key)?.blobUrl;
  if (cached) return Promise.resolve(cached);

  const inFlight = inFlightResolutionCache.get(key);
  if (inFlight) return inFlight;

  const pending = readHtreeMediaBytes(key)
    .then((result) => {
      // Invalidate / a newer resolve may have replaced this in-flight entry.
      if (inFlightResolutionCache.get(key) !== pending) {
        return takeResolvedBlobEntry(key)?.blobUrl ?? null;
      }
      if (!result) return null;
      const copy = new Uint8Array(result.bytes.byteLength);
      copy.set(result.bytes);
      const blob = new Blob([copy], { type: result.mimeType });
      const blobUrl = URL.createObjectURL(blob);
      if (inFlightResolutionCache.get(key) !== pending) {
        URL.revokeObjectURL(blobUrl);
        return takeResolvedBlobEntry(key)?.blobUrl ?? null;
      }
      const parsed = parseHtreeUrl(key);
      putResolvedBlobEntry(key, {
        blobUrl,
        byteLength: result.bytes.byteLength,
        expiresAt:
          parsed?.type === "npub"
            ? Date.now() + HASHTREE_MUTABLE_BLOB_TTL_MS
            : null,
      });
      return blobUrl;
    })
    .catch(() => null)
    .finally(() => {
      if (inFlightResolutionCache.get(key) === pending) {
        inFlightResolutionCache.delete(key);
      }
    });

  inFlightResolutionCache.set(key, pending);
  return pending;
}

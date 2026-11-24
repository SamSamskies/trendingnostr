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
  visibilityHex,
  type CID,
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
      primary: new MemoryStore(),
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

const resolvedBlobUrlCache = new Map<string, string>();
const inFlightResolutionCache = new Map<string, Promise<string | null>>();

export function getCachedHtreeMediaUrl(rawUrl: string): string | undefined {
  return resolvedBlobUrlCache.get(normalizeHtreeUrl(rawUrl));
}

/**
 * Resolve an `htree://` media URL to a local `blob:` URL, deduplicating
 * concurrent requests and caching successful resolutions for the session.
 */
export function resolveHtreeMediaUrl(rawUrl: string): Promise<string | null> {
  const key = normalizeHtreeUrl(rawUrl);
  const cached = resolvedBlobUrlCache.get(key);
  if (cached) return Promise.resolve(cached);

  const inFlight = inFlightResolutionCache.get(key);
  if (inFlight) return inFlight;

  const pending = readHtreeMediaBytes(key)
    .then((result) => {
      if (!result) return null;
      const copy = new Uint8Array(result.bytes.byteLength);
      copy.set(result.bytes);
      const blob = new Blob([copy], { type: result.mimeType });
      const blobUrl = URL.createObjectURL(blob);
      resolvedBlobUrlCache.set(key, blobUrl);
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

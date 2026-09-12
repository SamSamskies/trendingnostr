export type MediaKind = "image" | "video";

export const newlineRegex = /(\r?\n)/gi;
export const hyperlinkRegex = /(https?:\/\/[^\s]+)/gi;

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "gif",
  "bmp",
  "svg",
  "webp",
  "avif",
  "heic",
  "heif",
]);

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "ogg",
  "webm",
  "mkv",
  "avi",
  "m4v",
]);

const BLOSSOM_SEGMENT_RE = /^([a-fA-F0-9]{64})(?:\.([a-zA-Z0-9]+))?$/;

type Imeta = { url?: string; mime?: string };

/** Strip punctuation that `https?:\/\/[^\s]+` often captures from surrounding prose. */
export function normalizeHttpUrl(raw: string): string {
  return raw.replace(/[),.;:!?]+$/g, "");
}

export function parseImeta(tags: string[][] = []): Imeta[] {
  const entries: Imeta[] = [];

  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    const entry: Imeta = {};
    for (let i = 1; i < tag.length; i++) {
      const space = tag[i].indexOf(" ");
      if (space <= 0) continue;
      const key = tag[i].slice(0, space);
      const value = tag[i].slice(space + 1);
      if (key === "url") entry.url = value;
      if (key === "m") entry.mime = value;
    }
    if (entry.url || entry.mime) entries.push(entry);
  }

  return entries;
}

function extensionFromFilename(name: string): string | undefined {
  const last = name.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return last.slice(dot + 1).toLowerCase();
}

/** Path first, then query values/keys like `?file=clip.mp4`. */
function urlMediaKind(url: string): MediaKind | null {
  try {
    const parsed = new URL(url);
    const fromPath = extensionKind(extensionFromFilename(parsed.pathname));
    if (fromPath) return fromPath;

    for (const [key, value] of parsed.searchParams) {
      const fromValue = extensionKind(extensionFromFilename(value));
      if (fromValue) return fromValue;
      const fromKey = extensionKind(extensionFromFilename(key));
      if (fromKey) return fromKey;
    }

    return null;
  } catch {
    return null;
  }
}

/** BUD-01 / NIP-B7: last path segment is a SHA-256, with an optional advisory extension. */
export function blossomHashFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const match = last.match(BLOSSOM_SEGMENT_RE);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Accept full MIME types and bare types some clients send (`jpeg`, `png`, `mp4`). */
function mimeKind(mime: string): MediaKind | null {
  const normalized = mime.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("image/") || IMAGE_EXTENSIONS.has(normalized)) {
    return "image";
  }
  if (normalized.startsWith("video/") || VIDEO_EXTENSIONS.has(normalized)) {
    return "video";
  }
  return null;
}

function extensionKind(ext: string | undefined): MediaKind | null {
  if (!ext) return null;
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

function urlsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const hashA = blossomHashFromUrl(a);
  const hashB = blossomHashFromUrl(b);
  return Boolean(hashA && hashB && hashA === hashB);
}

const YOUTUBE_VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

function youtubeStartSeconds(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);

  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;

  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

const NOSTR_BUILD_AUDIO_EXT = new Set([
  "mp3",
  "m4a",
  "ogg",
  "opus",
  "wav",
  "flac",
  "aac",
]);

export type NostrBuildEmbed = {
  src: string;
  /** Audio players are short (oEmbed ~120px); video uses the default embed height. */
  variant: "audio" | "video";
};

/** Fill the iframe; their player treats unit-bearing h/w as CSS frame size. */
function withNostrBuildFrameParams(embed: URL): URL {
  if (!embed.searchParams.has("h")) embed.searchParams.set("h", "100%");
  if (!embed.searchParams.has("w")) embed.searchParams.set("w", "100%");
  return embed;
}

/**
 * Branded nostr.build media player (`e.nostr.build`), including converting
 * direct `a.nostr.build` audio files into the player URL.
 */
export function nostrBuildEmbedUrl(raw: string): NostrBuildEmbed | null {
  const url = normalizeHttpUrl(raw);

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (host === "e.nostr.build") {
      if (segments.length !== 1) return null;
      const mediaId = segments[0];
      // Player ids look like `a_…_mp3` / `v_…_mp4`.
      if (!/^[a-z]_/i.test(mediaId)) return null;
      const variant = mediaId.toLowerCase().startsWith("a_") ? "audio" : "video";
      return { src: withNostrBuildFrameParams(parsed).href, variant };
    }

    if (host === "a.nostr.build") {
      if (segments.length !== 1) return null;
      const file = segments[0];
      const dot = file.lastIndexOf(".");
      if (dot <= 0) return null;
      const id = file.slice(0, dot);
      const ext = file.slice(dot + 1).toLowerCase();
      if (!id || !NOSTR_BUILD_AUDIO_EXT.has(ext)) return null;

      const embed = new URL(`https://e.nostr.build/a_${id}_${ext}`);
      for (const key of ["t", "by", "viz", "bg"]) {
        const value = parsed.searchParams.get(key);
        if (value) embed.searchParams.set(key, value);
      }
      return { src: withNostrBuildFrameParams(embed).href, variant: "audio" };
    }

    return null;
  } catch {
    return null;
  }
}

/** Build a youtube.com/embed URL for watch, youtu.be, shorts, and live links. */
export function youtubeEmbedUrl(raw: string): string | null {
  const url = normalizeHttpUrl(raw);

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    let videoId: string | undefined;

    if (host === "youtu.be") {
      videoId = parsed.pathname.split("/").filter(Boolean)[0];
    } else if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      videoId = parsed.searchParams.get("v") ?? undefined;
      if (!videoId) {
        const pathMatch = parsed.pathname.match(
          /^\/(?:embed|shorts|live|v)\/([^/?#]+)/
        );
        videoId = pathMatch?.[1];
      }
    }

    if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) return null;

    const embed = new URL(`https://www.youtube.com/embed/${videoId}`);
    let start =
      parsed.searchParams.get("t") ?? parsed.searchParams.get("start");
    if (!start && parsed.hash.startsWith("#")) {
      const hashParams = new URLSearchParams(parsed.hash.slice(1));
      start = hashParams.get("t") ?? hashParams.get("start");
    }
    if (start) {
      const seconds = youtubeStartSeconds(start);
      if (seconds !== null && seconds >= 0) {
        embed.searchParams.set("start", String(seconds));
      }
    }
    return embed.href;
  } catch {
    return null;
  }
}

export function classifyUrl(url: string, tags: string[][] = []): MediaKind | null {
  const normalized = normalizeHttpUrl(url);
  const imeta = parseImeta(tags);

  for (const entry of imeta) {
    if (!entry.url || !urlsMatch(normalized, entry.url)) continue;
    if (entry.mime) {
      const fromMime = mimeKind(entry.mime);
      // Known media mime wins; unknown/non-media mime falls through to URL heuristics
      // (Primal iOS has sent bare `jpeg` / `png` instead of `image/jpeg`).
      if (fromMime) return fromMime;
    }
  }

  const fromExt = urlMediaKind(normalized);
  if (fromExt) return fromExt;

  if (blossomHashFromUrl(normalized)) return "image";

  return null;
}

const MAX_NOTE_IMAGES = 8;

/**
 * Image URLs on a note: inline http(s) links classified as images, plus `imeta`
 * urls that are images (even when not repeated in the body). Videos skipped.
 */
export function noteImageUrls(
  content: string,
  tags: string[][] = []
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string | undefined) => {
    if (!raw || urls.length >= MAX_NOTE_IMAGES) return;
    const url = normalizeHttpUrl(raw);
    if (!url || seen.has(url)) return;
    if (classifyUrl(url, tags) !== "image") return;
    seen.add(url);
    urls.push(url);
  };

  for (const match of content.matchAll(new RegExp(hyperlinkRegex.source, "gi"))) {
    add(match[0]);
  }
  for (const entry of parseImeta(tags)) {
    add(entry.url);
  }

  return urls;
}

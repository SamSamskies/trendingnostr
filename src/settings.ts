import { useSyncExternalStore } from "react";

const SETTINGS_KEY = "trendingnostr.settings";

/** Wine trending windows offered in the UI (API allows 1–48). */
export const TRENDING_HOURS_OPTIONS = [4, 12, 24, 48] as const;
export type TrendingHours = (typeof TRENDING_HOURS_OPTIONS)[number];

export type AppSettings = {
  /** When false, Ask AI skips web search (IPA tools and hosted grounding). */
  webSearch: boolean;
  /** Last selected trending window; restored on next visit. */
  trendingHours: TrendingHours;
  /** Lowercase hex pubkeys hidden from the feed. */
  mutedAuthors: string[];
  /**
   * When true, hide authors missing from Fayan or below its percentile floor.
   * Failures fall open (feed stays unfiltered).
   */
  fayanFilter: boolean;
  /**
   * When true, hide notes with 4 or more distinct `t` (hashtag) tags.
   * Spammers often bury hashtags in tags without putting them in content.
   */
  hashtagFilter: boolean;
};

const DEFAULT_SETTINGS: AppSettings = {
  webSearch: true,
  trendingHours: 48,
  mutedAuthors: [],
  fayanFilter: true,
  hashtagFilter: true,
};

function normalizeMutedAuthors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const pubkey = item.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(pubkey);
  }
  return out;
}

function normalizePubkey(pubkey: string): string | null {
  const normalized = pubkey.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

let cache: AppSettings | null = null;
const listeners = new Set<() => void>();

function isTrendingHours(value: unknown): value is TrendingHours {
  return (
    typeof value === "number" &&
    (TRENDING_HOURS_OPTIONS as readonly number[]).includes(value)
  );
}

function normalize(raw: unknown): AppSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  const record = raw as Record<string, unknown>;
  return {
    webSearch:
      typeof record.webSearch === "boolean"
        ? record.webSearch
        : DEFAULT_SETTINGS.webSearch,
    trendingHours: isTrendingHours(record.trendingHours)
      ? record.trendingHours
      : DEFAULT_SETTINGS.trendingHours,
    mutedAuthors: normalizeMutedAuthors(record.mutedAuthors),
    fayanFilter:
      typeof record.fayanFilter === "boolean"
        ? record.fayanFilter
        : DEFAULT_SETTINGS.fayanFilter,
    hashtagFilter:
      typeof record.hashtagFilter === "boolean"
        ? record.hashtagFilter
        : DEFAULT_SETTINGS.hashtagFilter,
  };
}

function readSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    cache = raw ? normalize(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

function writeSettings(next: AppSettings): void {
  cache = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode
  }
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SETTINGS_KEY && event.key != null) return;
    cache = null;
    onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getSettings(): AppSettings {
  return readSettings();
}

export function isWebSearchEnabled(): boolean {
  return readSettings().webSearch;
}

export function setWebSearchEnabled(enabled: boolean): void {
  const current = readSettings();
  if (current.webSearch === enabled) return;
  writeSettings({ ...current, webSearch: enabled });
}

export function useWebSearchEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    isWebSearchEnabled,
    () => DEFAULT_SETTINGS.webSearch
  );
}

export function getTrendingHours(): TrendingHours {
  return readSettings().trendingHours;
}

export function setTrendingHours(hours: TrendingHours): void {
  const current = readSettings();
  if (current.trendingHours === hours) return;
  writeSettings({ ...current, trendingHours: hours });
}

export function useTrendingHours(): TrendingHours {
  return useSyncExternalStore(
    subscribe,
    getTrendingHours,
    () => DEFAULT_SETTINGS.trendingHours
  );
}

export function getMutedAuthors(): string[] {
  return readSettings().mutedAuthors;
}

export function isAuthorMuted(pubkey: string): boolean {
  const normalized = normalizePubkey(pubkey);
  if (!normalized) return false;
  return readSettings().mutedAuthors.includes(normalized);
}

export function muteAuthor(pubkey: string): void {
  const normalized = normalizePubkey(pubkey);
  if (!normalized || isAuthorMuted(normalized)) return;
  const current = readSettings();
  writeSettings({
    ...current,
    mutedAuthors: [...current.mutedAuthors, normalized],
  });
}

export function unmuteAuthor(pubkey: string): void {
  const normalized = normalizePubkey(pubkey);
  if (!normalized) return;
  const current = readSettings();
  const mutedAuthors = current.mutedAuthors.filter((pk) => pk !== normalized);
  if (mutedAuthors.length === current.mutedAuthors.length) return;
  writeSettings({ ...current, mutedAuthors });
}

export function useMutedAuthors(): string[] {
  return useSyncExternalStore(
    subscribe,
    getMutedAuthors,
    () => DEFAULT_SETTINGS.mutedAuthors
  );
}

export function isFayanFilterEnabled(): boolean {
  return readSettings().fayanFilter;
}

export function setFayanFilterEnabled(enabled: boolean): void {
  const current = readSettings();
  if (current.fayanFilter === enabled) return;
  writeSettings({ ...current, fayanFilter: enabled });
}

export function useFayanFilterEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    isFayanFilterEnabled,
    () => DEFAULT_SETTINGS.fayanFilter
  );
}

export function isHashtagFilterEnabled(): boolean {
  return readSettings().hashtagFilter;
}

export function setHashtagFilterEnabled(enabled: boolean): void {
  const current = readSettings();
  if (current.hashtagFilter === enabled) return;
  writeSettings({ ...current, hashtagFilter: enabled });
}

export function useHashtagFilterEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    isHashtagFilterEnabled,
    () => DEFAULT_SETTINGS.hashtagFilter
  );
}

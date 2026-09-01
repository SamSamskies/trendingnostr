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
};

const DEFAULT_SETTINGS: AppSettings = {
  webSearch: true,
  trendingHours: 48,
};

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

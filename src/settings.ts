import { useSyncExternalStore } from "react";

const SETTINGS_KEY = "trendingnostr.settings";

export type AppSettings = {
  /** When false, Ask AI skips web search (IPA tools and hosted grounding). */
  webSearch: boolean;
};

const DEFAULT_SETTINGS: AppSettings = {
  webSearch: true,
};

let cache: AppSettings | null = null;
const listeners = new Set<() => void>();

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

// Platform abstraction layer. All web-only globals (localStorage, window,
// navigator) are accessed through here so the app logic stays portable — a
// future React Native / Expo build can swap this module for an AsyncStorage
// implementation without touching hooks, services, or components.

export const isClient = typeof window !== 'undefined';

/** SSR-/RN-safe key-value storage. No-ops gracefully when unavailable. */
export const storage = {
  get(key: string): string | null {
    if (!isClient) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    if (!isClient) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* quota / private-mode — ignore */
    }
  },
  remove(key: string): void {
    if (!isClient) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  getJSON<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJSON(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  },
};

/** Cross-platform event bus (web: window events; RN: swap for an emitter). */
export const appEvents = {
  emit(name: string): void {
    if (!isClient) return;
    window.dispatchEvent(new Event(name));
  },
  on(name: string, handler: () => void): () => void {
    if (!isClient) return () => {};
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
  },
};

/** Current online status (web). RN would use NetInfo. */
export function isOnline(): boolean {
  if (!isClient) return true;
  return navigator.onLine;
}

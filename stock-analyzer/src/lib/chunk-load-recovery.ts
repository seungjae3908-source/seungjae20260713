// Recovery for stale code-split chunks after a deploy.
//
// Root cause of the white page at /stock-info/analysis (and any lazily loaded
// route): the PWA service worker auto-updates and cleans its old precache, and
// the API server answers a request for a removed /assets/<old-hash>.js with the
// SPA index.html. The still-running old page then fails its dynamic import
// (MIME / "Failed to fetch dynamically imported module"), React.lazy throws, and
// without an error boundary React unmounts the whole tree.
//
// Fix: reload the document once so it picks up the new index.html and chunk
// graph. A sessionStorage timestamp guarantees we never loop: if a reload was
// already attempted recently, the error boundary shows a Korean fallback with a
// manual "다시 시도" button instead.
import { isChunkLoadError } from './error-reason';

export const CHUNK_RELOAD_STORAGE_KEY = 'sa-chunk-reload-at';
export const CHUNK_RELOAD_WINDOW_MS = 30_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Returns true (and records the attempt) when an automatic reload is allowed now. */
export function claimChunkReload(storage: StorageLike | null | undefined, now = Date.now()): boolean {
  if (!storage) return false;
  try {
    const previous = Number(storage.getItem(CHUNK_RELOAD_STORAGE_KEY));
    if (Number.isFinite(previous) && previous > 0 && now - previous < CHUNK_RELOAD_WINDOW_MS) return false;
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));
    return true;
  } catch {
    // Storage blocked (private mode): never auto-reload, the boundary handles it.
    return false;
  }
}

function sessionStorageOrNull(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reload once for a stale chunk; returns false when the one reload was already spent. */
export function reloadOnceForChunkError(): boolean {
  if (typeof window === 'undefined') return false;
  if (!claimChunkReload(sessionStorageOrNull())) return false;
  window.location.reload();
  return true;
}

let installed = false;

/** Global listeners: Vite preload failures and unhandled dynamic-import rejections. */
export function installChunkLoadRecovery(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForChunkError()) event.preventDefault();
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadError(event.reason) && reloadOnceForChunkError()) event.preventDefault();
  });
}

import path from 'node:path';

export const FRONTEND_REVALIDATE_CACHE_CONTROL = 'no-cache, no-store, must-revalidate';
export const FRONTEND_IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const FRONTEND_DEFAULT_CACHE_CONTROL = 'public, max-age=3600';

const MUST_REVALIDATE_FILES = new Set([
  'index.html',
  'sw.js',
  'registerSW.js',
  'push-sw.js',
  'manifest.webmanifest',
]);

export function frontendStaticCacheControl(frontendDist: string, filePath: string): string {
  const relative = path.relative(frontendDist, filePath).split(path.sep).join('/');

  if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
    return FRONTEND_REVALIDATE_CACHE_CONTROL;
  }

  if (MUST_REVALIDATE_FILES.has(relative)) {
    return FRONTEND_REVALIDATE_CACHE_CONTROL;
  }

  if (relative.startsWith('assets/') || /^workbox-[A-Za-z0-9_-]+\.js$/.test(relative)) {
    return FRONTEND_IMMUTABLE_CACHE_CONTROL;
  }

  return FRONTEND_DEFAULT_CACHE_CONTROL;
}

export function setFrontendStaticCacheHeaders(
  response: { setHeader(name: string, value: string): unknown },
  frontendDist: string,
  filePath: string,
) {
  response.setHeader('Cache-Control', frontendStaticCacheControl(frontendDist, filePath));
}

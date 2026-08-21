type DeploymentHealth = {
  deploySha?: unknown;
};

export type SafeErrorDiagnosticsInput = {
  pathname: string;
  appSha?: string | null;
  provider?: string | null;
  errorCode?: string | null;
  occurredAt: string;
};

const MAX_PATH_LENGTH = 240;
const MAX_TOKEN_LENGTH = 80;

function safeToken(value: string | null | undefined, fallback = 'NOT_AVAILABLE') {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return fallback;
  return trimmed
    .slice(0, MAX_TOKEN_LENGTH)
    .replace(/[^A-Za-z0-9가-힣._:+/ -]/g, '?');
}

export function safeErrorPath(pathname: string) {
  const pathOnly = String(pathname || '/')
    .split('?')[0]
    .split('#')[0]
    .trim();
  if (!pathOnly.startsWith('/')) return '/';
  return pathOnly.slice(0, MAX_PATH_LENGTH) || '/';
}

export async function readPublicDeploySha() {
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return 'NOT_AVAILABLE';
    const payload = await response.json() as DeploymentHealth;
    const sha = String(payload.deploySha ?? '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : 'NOT_AVAILABLE';
  } catch {
    return 'NOT_AVAILABLE';
  }
}

export function formatSafeErrorDiagnostics(input: SafeErrorDiagnosticsInput) {
  const occurredAt = Number.isFinite(Date.parse(input.occurredAt))
    ? new Date(input.occurredAt).toISOString()
    : 'NOT_AVAILABLE';
  return [
    '[APP_ERROR_DIAGNOSTICS]',
    `path: ${safeErrorPath(input.pathname)}`,
    `app_sha: ${safeToken(input.appSha)}`,
    `provider: ${safeToken(input.provider)}`,
    `error_code: ${safeToken(input.errorCode, 'UNKNOWN')}`,
    `occurred_at: ${occurredAt}`,
  ].join('\n');
}

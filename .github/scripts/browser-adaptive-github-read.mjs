/** Bounded read-only retry for GitHub Action metadata 502/503/504.
 * Never dispatch another workflow, mutate state, retry actual tests or
 * silently substitute fabricated/recent-proof artifacts.
 */
const RETRYABLE = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));

export function isRetryableGitHubReadFailure(error) {
  const status = Number(error?.status ?? error?.response?.status);
  const code = String(error?.code ?? '');
  return RETRYABLE.has(status) || ['ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(code);
}
export async function readGitHubMetadataWithRetry(read, {
  snooze = wait,
  onRetry = () => {},
} = {}) {
  if (typeof read !== 'function' || typeof snooze !== 'function'
    || typeof onRetry !== 'function') throw new Error('GITHUB_READ_RETRY_INVALID_INPUT');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await read();
      if (!result || typeof result !== 'object' || !result.data)
        throw new Error('GITHUB_READ_RESPONSE_INVALID');
      return result;
    } catch (error) {
      if (!isRetryableGitHubReadFailure(error) || attempt === MAX_ATTEMPTS) throw error;
      // Small fixed backoff: deterministic behavior, no endless request loop.
      onRetry(attempt);
      await snooze(attempt * 500);
    }
  }
  throw new Error('GITHUB_READ_RETRY_EXHAUSTED');
}

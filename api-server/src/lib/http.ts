import { ProviderError } from './errors';
import { currentProviderSignal } from './provider-context';

interface FetchOpts {
  provider: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function requestAbort(
  timeoutMs: number,
  explicitSignal?: AbortSignal,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const parent = explicitSignal ?? currentProviderSignal();
  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new Error('PROVIDER_TIMEOUT'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchOpts,
): Promise<T> {
  const abort = requestAbort(opts.timeoutMs ?? 10000, opts.signal);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: abort.signal,
    });
    if (res.status === 429) {
      throw new ProviderError('RATE_LIMITED', opts.provider);
    }
    if (!res.ok) {
      throw new ProviderError(
        'UPSTREAM_ERROR',
        opts.provider,
        `HTTP ${res.status}`,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (
      abort.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      throw new ProviderError(
        'UPSTREAM_ERROR',
        opts.provider,
        abort.timedOut() ? 'timeout' : 'aborted',
      );
    }
    throw new ProviderError(
      'UPSTREAM_ERROR',
      opts.provider,
      err instanceof Error ? err.message : 'network error',
    );
  } finally {
    abort.cleanup();
  }
}

export async function fetchText(
  url: string,
  opts: FetchOpts,
): Promise<string> {
  const abort = requestAbort(opts.timeoutMs ?? 10000, opts.signal);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: abort.signal,
    });
    if (res.status === 429) {
      throw new ProviderError('RATE_LIMITED', opts.provider);
    }
    if (!res.ok) {
      throw new ProviderError(
        'UPSTREAM_ERROR',
        opts.provider,
        `HTTP ${res.status}`,
      );
    }
    return await res.text();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (
      abort.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      throw new ProviderError(
        'UPSTREAM_ERROR',
        opts.provider,
        abort.timedOut() ? 'timeout' : 'aborted',
      );
    }
    throw new ProviderError(
      'UPSTREAM_ERROR',
      opts.provider,
      err instanceof Error ? err.message : 'network error',
    );
  } finally {
    abort.cleanup();
  }
}

export async function fetchBuffer(
  url: string,
  opts: FetchOpts,
): Promise<Buffer> {
  const abort = requestAbort(opts.timeoutMs ?? 20000, opts.signal);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: abort.signal,
    });
    if (!res.ok) {
      throw new ProviderError(
        'UPSTREAM_ERROR',
        opts.provider,
        `HTTP ${res.status}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (
      abort.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      throw new ProviderError(
        'UPSTREAM_ERROR',
        opts.provider,
        abort.timedOut() ? 'timeout' : 'aborted',
      );
    }
    throw new ProviderError(
      'UPSTREAM_ERROR',
      opts.provider,
      err instanceof Error ? err.message : 'network error',
    );
  } finally {
    abort.cleanup();
  }
}

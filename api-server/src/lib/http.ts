import { ProviderError } from './errors';

interface FetchOpts {
  provider: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchOpts,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal,
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
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError('UPSTREAM_ERROR', opts.provider, 'timeout');
    }
    throw new ProviderError(
      'UPSTREAM_ERROR',
      opts.provider,
      err instanceof Error ? err.message : 'network error',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(
  url: string,
  opts: FetchOpts,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal,
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
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError('UPSTREAM_ERROR', opts.provider, 'timeout');
    }
    throw new ProviderError(
      'UPSTREAM_ERROR',
      opts.provider,
      err instanceof Error ? err.message : 'network error',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchBuffer(
  url: string,
  opts: FetchOpts,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal,
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
    throw new ProviderError(
      'UPSTREAM_ERROR',
      opts.provider,
      err instanceof Error ? err.message : 'network error',
    );
  } finally {
    clearTimeout(timeout);
  }
}

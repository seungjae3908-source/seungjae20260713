import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';

const AI_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
]);

function requestHost(args: unknown[]) {
  const first = args[0];
  try {
    if (first instanceof URL) return first.hostname.toLowerCase();
    if (typeof first === 'string') return new URL(first).hostname.toLowerCase();
    if (first && typeof first === 'object') {
      const options = first as Record<string, unknown>;
      const raw = options.hostname ?? options.host;
      if (typeof raw === 'string') return raw.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
    }
  } catch {
    return '';
  }
  return '';
}

export function installExternalAiNetworkGuard() {
  const expectedProbe = new AsyncLocalStorage<boolean>();
  let unexpectedAttempts = 0;
  let blockedProbes = 0;
  const nativeFetch = globalThis.fetch;
  const nativeHttpRequest = http.request;
  const nativeHttpsRequest = https.request;

  const block = (host: string) => {
    if (!AI_HOSTS.has(host)) return;
    if (expectedProbe.getStore()) blockedProbes += 1;
    else unexpectedAttempts += 1;
    throw new Error(`External AI network request blocked: host=${host}`);
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = requestHost([input]);
    block(host);
    return nativeFetch(input, init);
  }) as typeof fetch;

  http.request = ((...args: unknown[]) => {
    block(requestHost(args));
    return (nativeHttpRequest as (...values: unknown[]) => http.ClientRequest)(...args);
  }) as typeof http.request;

  https.request = ((...args: unknown[]) => {
    block(requestHost(args));
    return (nativeHttpsRequest as (...values: unknown[]) => http.ClientRequest)(...args);
  }) as typeof https.request;

  return {
    expectedBlock<T>(operation: () => T): T {
      return expectedProbe.run(true, operation);
    },
    stats() { return { unexpectedAttempts, blockedProbes }; },
    restore() {
      globalThis.fetch = nativeFetch;
      http.request = nativeHttpRequest;
      https.request = nativeHttpsRequest;
    },
  };
}

import http from 'node:http';
import https from 'node:https';

export const PUBLIC_PROVIDER_ENDPOINTS = Object.freeze([
  Object.freeze({ provider: 'YAHOO_QUERY1', market: 'KR_STOCK_US_STOCK',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d' }),
  Object.freeze({ provider: 'YAHOO_QUERY2', market: 'KR_STOCK_US_STOCK',
    url: 'https://query2.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d' }),
  Object.freeze({ provider: 'NASDAQ_TRADER_NASDAQ', market: 'US_STOCK',
    url: 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt' }),
  Object.freeze({ provider: 'NASDAQ_TRADER_OTHER', market: 'US_STOCK',
    url: 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt' }),
  Object.freeze({ provider: 'UPBIT', market: 'CRYPTO_SPOT',
    url: 'https://api.upbit.com/v1/market/all?is_details=true' }),
  Object.freeze({ provider: 'BITGET', market: 'CRYPTO_FUTURES',
    url: 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES' }),
]);

function errorText(error) {
  const values = [];
  let current = error;
  const seen = new Set();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    for (const key of ['name', 'message', 'code']) {
      const value = current[key];
      if (typeof value === 'string') values.push(value);
      else if (typeof value === 'number') values.push(String(value));
    }
    current = current.cause;
  }
  return values.join(' ').slice(0, 1_000);
}

export function classifyPublicProviderResult({ response = null, error = null } = {}) {
  if (response?.ok) return 'PROVIDER_REACHED';
  const text = errorText(error).toUpperCase();
  if (/(CONNECT|TUNNEL|PROXY).*(403|FORBIDDEN)|(403|FORBIDDEN).*(CONNECT|TUNNEL|PROXY)/u.test(text)) {
    return 'MANAGED_PROXY_CONNECT_403';
  }
  if (error) {
    if (/EAI_AGAIN|ENOTFOUND/u.test(text)) return 'NETWORK_DNS_UNAVAILABLE';
    return /TIMEOUT|ABORT/u.test(text) ? 'NETWORK_TIMEOUT' : 'NETWORK_TRANSPORT_ERROR';
  }
  if (response?.status === 403) return 'PROVIDER_HTTP_403';
  if (response?.status === 429) return 'PROVIDER_RATE_LIMITED';
  if (Number.isInteger(response?.status)) return `PROVIDER_HTTP_${response.status}`;
  return 'UNKNOWN_FAILURE';
}

export async function probeProxyConnect(targetUrl, proxyUrl, timeoutMs = 8_000) {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const transport = proxy.protocol === 'https:' ? https : http;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const headers = { host: `${target.hostname}:443`, 'user-agent': 'signal-intelligence-v3-provider-diagnostic/1.0' };
    if (proxy.username || proxy.password) {
      headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    }
    const request = transport.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers,
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('PUBLIC_PROVIDER_PROXY_CONNECT_TIMEOUT')));
    request.once('connect', (response, socket) => {
      socket.destroy();
      finish(() => resolve(response.statusCode ?? null));
    });
    request.once('response', (response) => {
      response.resume();
      finish(() => resolve(response.statusCode ?? null));
    });
    request.once('error', (error) => finish(() => reject(error)));
    request.end();
  });
}

export async function probePublicProvider(endpoint, {
  fetchImpl = fetch,
  timeoutMs = 8_000,
  proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
  proxyConnectProbe = probeProxyConnect,
} = {}) {
  if (proxyUrl) {
    try {
      const status = await proxyConnectProbe(endpoint.url, proxyUrl, timeoutMs);
      if (status !== 200) {
        const classification = status === 403 ? 'MANAGED_PROXY_CONNECT_403' : `NETWORK_PROXY_CONNECT_${status ?? 'FAILED'}`;
        return Object.freeze({
          provider: endpoint.provider, market: endpoint.market, hostname: new URL(endpoint.url).hostname,
          path: new URL(endpoint.url).pathname, status: null, proxyConnectStatus: status,
          classification, reachedProviderHttp: false, errorCode: classification,
        });
      }
    } catch (error) {
      const classification = classifyPublicProviderResult({ error });
      return Object.freeze({
        provider: endpoint.provider, market: endpoint.market, hostname: new URL(endpoint.url).hostname,
        path: new URL(endpoint.url).pathname, status: null, proxyConnectStatus: null,
        classification, reachedProviderHttp: false, errorCode: classification,
      });
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('PUBLIC_PROVIDER_PROBE_TIMEOUT')), timeoutMs);
  try {
    const response = await fetchImpl(endpoint.url, {
      method: 'GET',
      headers: { accept: '*/*', 'user-agent': 'signal-intelligence-v3-provider-diagnostic/1.0' },
      redirect: 'follow',
      signal: controller.signal,
    });
    return Object.freeze({
      provider: endpoint.provider,
      market: endpoint.market,
      hostname: new URL(endpoint.url).hostname,
      path: new URL(endpoint.url).pathname,
      status: response.status,
      classification: classifyPublicProviderResult({ response }),
      reachedProviderHttp: true,
    });
  } catch (error) {
    const classification = classifyPublicProviderResult({ error });
    return Object.freeze({
      provider: endpoint.provider,
      market: endpoint.market,
      hostname: new URL(endpoint.url).hostname,
      path: new URL(endpoint.url).pathname,
      status: null,
      classification,
      reachedProviderHttp: false,
      errorCode: classification,
    });
  } finally {
    clearTimeout(timer);
  }
}

const LISTS = Object.freeze(['krBuy', 'usBuy', 'spotBuy', 'futuresLong', 'futuresShort']);
const CRYPTO_MARKETS = new Set(['CRYPTO_SPOT', 'CRYPTO_FUTURES']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || fallback).trim();
  const parsed = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error('SIGNAL_OVERLAY_LOOPBACK_ONLY');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('SIGNAL_OVERLAY_PROTOCOL_INVALID');
  return parsed.origin;
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('SIGNAL_OVERLAY_TIMEOUT')), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`SIGNAL_OVERLAY_HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function endpointFor(candidate, intelligenceBaseUrl) {
  const market = String(candidate?.market ?? '').toUpperCase();
  const symbol = String(candidate?.symbol ?? '').trim().toUpperCase();
  if (!symbol) return null;
  if (market === 'CRYPTO_SPOT') {
    return `${intelligenceBaseUrl}/v1/public/crypto/spot/${encodeURIComponent(symbol)}`;
  }
  if (market === 'CRYPTO_FUTURES') {
    return `${intelligenceBaseUrl}/v1/public/crypto/futures/${encodeURIComponent(symbol)}`;
  }
  return null;
}

function unavailable(candidate, reason) {
  return {
    candidate,
    intelligence: {
      status: 'NOT_AVAILABLE',
      reason,
      scanner: { mode: 'SOFT_INTELLIGENCE_LAYER', action: 'PRESERVE_CANDIDATE' },
      autoTrading: { status: 'PAPER_ONLY', orderAllowed: false, executionAuthority: 'NONE' },
    },
  };
}

async function enrichCandidate(candidate, { intelligenceBaseUrl, fetchImpl, timeoutMs }) {
  const market = String(candidate?.market ?? '').toUpperCase();
  if (!CRYPTO_MARKETS.has(market)) {
    return unavailable(candidate, 'PUBLIC_STOCK_INTELLIGENCE_EVIDENCE_NOT_CONNECTED');
  }

  const endpoint = endpointFor(candidate, intelligenceBaseUrl);
  if (!endpoint) return unavailable(candidate, 'INVALID_CANDIDATE_IDENTITY');

  try {
    const payload = asObject(await fetchJson(endpoint, fetchImpl, timeoutMs));
    const result = asObject(payload.result);
    if (payload.ok !== true) throw new Error('INTELLIGENCE_RESPONSE_NOT_OK');
    if (result?.scanner?.mode !== 'SOFT_INTELLIGENCE_LAYER') throw new Error('UNSAFE_SCANNER_MODE');
    if (result?.autoTrading?.orderAllowed !== false) throw new Error('UNSAFE_ORDER_AUTHORITY');
    return {
      candidate,
      intelligence: {
        status: 'READY',
        serviceSha: payload.serviceSha ?? null,
        provenance: payload.provenance ?? null,
        result,
      },
    };
  } catch (error) {
    return unavailable(candidate, error instanceof Error ? error.message : 'INTELLIGENCE_UNAVAILABLE');
  }
}

async function mapBounded(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function buildSignalIntelligenceOverlay(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const signalBaseUrl = normalizeBaseUrl(options.signalBaseUrl, 'http://127.0.0.1:8790');
  const intelligenceBaseUrl = normalizeBaseUrl(options.intelligenceBaseUrl, 'http://127.0.0.1:8791');
  const timeoutMs = Math.max(250, Math.min(10_000, Number(options.timeoutMs ?? 4_000)));
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency ?? 4)));

  const signalPayload = asObject(await fetchJson(`${signalBaseUrl}/v1/signals`, fetchImpl, timeoutMs));
  if (signalPayload.ok !== true || !signalPayload.snapshot) throw new Error('SIGNAL_SNAPSHOT_NOT_READY');
  const snapshot = asObject(signalPayload.snapshot);
  const lists = asObject(snapshot.lists);

  const flattened = [];
  for (const listName of LISTS) {
    for (const candidate of array(lists[listName])) flattened.push({ listName, candidate });
  }

  const enriched = await mapBounded(flattened, concurrency, ({ listName, candidate }) =>
    enrichCandidate(candidate, { intelligenceBaseUrl, fetchImpl, timeoutMs }).then((row) => ({ listName, ...row }))
  );

  const overlayLists = Object.fromEntries(LISTS.map((name) => [name, []]));
  let ready = 0;
  let unavailableCount = 0;
  for (const row of enriched) {
    overlayLists[row.listName].push({ ...row.candidate, marketIntelligence: row.intelligence });
    if (row.intelligence.status === 'READY') ready += 1;
    else unavailableCount += 1;
  }

  return {
    ok: true,
    contract: 'market-intelligence-signal-overlay/v1',
    signalServiceSha: signalPayload.serviceSha ?? null,
    signalGeneratedAt: snapshot.generatedAt ?? null,
    lists: overlayLists,
    stats: {
      totalCandidates: enriched.length,
      intelligenceReady: ready,
      intelligenceUnavailable: unavailableCount,
    },
    safety: {
      scannerMode: 'SOFT_INTELLIGENCE_LAYER',
      candidateDeletionAllowed: false,
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
      orderSubmissionAllowed: false,
    },
  };
}

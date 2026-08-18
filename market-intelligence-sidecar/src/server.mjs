import http from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateMarketIntelligence, DEFAULT_POLICY } from './engine.mjs';
import { DEFAULT_ADVANCED_GATE_POLICY } from './advanced-gates.mjs';
import { DEFAULT_EXECUTION_QUALITY_POLICY } from './execution-quality.mjs';
import { DEFAULT_PORTFOLIO_SAFETY_POLICY } from './portfolio-safety.mjs';
import { normalizeMissingEvidence } from './evidence-normalize.mjs';
import { fetchBitgetFuturesEvidence, fetchUpbitSpotEvidence } from './public-data.mjs';
import { buildSignalIntelligenceOverlay } from './signal-overlay.mjs';
import { evaluateSpoofCandidate, SPOOF_CANDIDATE_CONTRACT } from './spoof-candidate.mjs';

const HOST = process.env.MARKET_INTELLIGENCE_HOST || '127.0.0.1';
const PORT = Number(process.env.MARKET_INTELLIGENCE_PORT || 8791);
const SERVICE_SHA = process.env.MARKET_INTELLIGENCE_SERVICE_SHA || 'development';
const SIGNAL_INTELLIGENCE_BASE_URL = process.env.SIGNAL_INTELLIGENCE_BASE_URL || 'http://127.0.0.1:8790';
const MAX_BODY_BYTES = 1_000_000;
const MAX_HISTORY_PER_SYMBOL = 8;
const historyByKey = new Map();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function safety() {
  return {
    executionAuthority: 'NONE',
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
    orderSubmissionAllowed: false,
  };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function keyOf(input) {
  return `${String(input.market ?? '').toUpperCase()}:${String(input.symbol ?? '').toUpperCase()}`;
}

function snapshotOf(input) {
  return {
    orderBook: input.orderBook,
    derivatives: input.derivatives ? { openInterest: input.derivatives.openInterest } : undefined,
    asOf: input.asOf ?? input.orderBook?.ts ?? input.orderBook?.timestamp,
  };
}

function snapshotTimestamp(snapshot) {
  const value = Number(snapshot?.asOf ?? snapshot?.orderBook?.ts ?? snapshot?.orderBook?.timestamp);
  return Number.isFinite(value) ? value : null;
}

function comparablePrevious(current, previous) {
  if (!previous) return false;
  const currentTs = snapshotTimestamp(current);
  const previousTs = snapshotTimestamp(previous);
  if (currentTs == null || previousTs == null || currentTs <= previousTs) return false;
  const configured = Number(current?.policy?.maxDataAgeMs ?? DEFAULT_POLICY.maxDataAgeMs);
  const maxGapMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLICY.maxDataAgeMs;
  return currentTs - previousTs <= maxGapMs;
}

function withPrevious(input) {
  const key = keyOf(input);
  const rememberedHistory = historyByKey.get(key) ?? [];
  const explicitHistory = Array.isArray(input.history) ? input.history : null;
  const history = explicitHistory ?? rememberedHistory;
  const candidatePrevious = input.previous ?? history.at(-1);
  const previous = comparablePrevious(input, candidatePrevious) ? candidatePrevious : null;
  const { previous: _discardedPrevious, ...rest } = input;
  return {
    ...rest,
    ...(previous ? { previous } : {}),
    history,
    previousSnapshotRejected: Boolean(candidatePrevious && !previous),
  };
}

function remember(input) {
  const key = keyOf(input);
  if (!key.includes(':') || key.startsWith(':') || key.endsWith(':')) return;
  const snapshot = snapshotOf(input);
  const timestamp = Number(snapshot.asOf);
  const history = historyByKey.get(key) ?? [];
  const lastTimestamp = Number(history.at(-1)?.asOf);
  if (Number.isFinite(timestamp) && Number.isFinite(lastTimestamp) && timestamp <= lastTimestamp) return;
  historyByKey.set(key, [...history, snapshot].slice(-MAX_HISTORY_PER_SYMBOL));
  if (historyByKey.size > 2_000) {
    const oldest = historyByKey.keys().next().value;
    historyByKey.delete(oldest);
  }
}

async function evaluateAndRemember(input) {
  const normalized = normalizeMissingEvidence(input);
  const enriched = withPrevious(normalized);
  const result = evaluateMarketIntelligence(enriched);
  const hasTradeExecutionEvidence = Array.isArray(enriched.trades) && enriched.trades.length > 0;
  const withdrawal = {
    ...result.microstructure.liquidityWithdrawal,
    executedRatio: hasTradeExecutionEvidence
      ? result.microstructure.liquidityWithdrawal?.executedRatio
      : null,
  };
  const spoofCandidate = evaluateSpoofCandidate({
    currentBook: enriched.orderBook,
    previousBook: enriched.previous?.orderBook,
    history: enriched.history,
    withdrawal,
    maxDataAgeMs: result.policy.maxDataAgeMs,
    ofi: result.microstructure.ofi,
    cvdNormalized: result.microstructure.cvdNormalized,
    micropriceBiasBps: result.microstructure.micropriceBiasBps,
  });
  result.microstructure.spoofCandidate = spoofCandidate;
  if (enriched.previousSnapshotRejected) {
    result.warnings = [...new Set([...result.warnings, 'PREVIOUS_MICROSTRUCTURE_SNAPSHOT_REJECTED'])];
  }
  if (spoofCandidate.state === 'INSUFFICIENT_EVIDENCE') {
    result.warnings = [...new Set([...result.warnings, 'SPOOF_CANDIDATE_INSUFFICIENT_EVIDENCE'])];
  }
  remember(normalized);
  return result;
}

async function handler(req, res) {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'market-intelligence-sidecar',
        contract: 'market-intelligence-sidecar/v1',
        serviceSha: SERVICE_SHA,
        bindHost: HOST,
        port: PORT,
        safety: safety(),
        liveTrading: false,
        privateApi: false,
        orderAuthority: false,
        cachedSymbols: historyByKey.size,
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/contracts') {
      return json(res, 200, {
        contract: 'market-intelligence-sidecar/v1',
        policy: DEFAULT_POLICY,
        scannerMode: 'SOFT_INTELLIGENCE_LAYER',
        autoTradingModes: ['PAPER_ONLY', 'BLOCKED_RISK', 'ELIGIBLE_FOR_PARENT_GATE'],
        spoofCandidate: {
          contract: SPOOF_CANDIDATE_CONTRACT,
          mode: 'OBSERVE_ONLY',
          scannerHardBlockAllowed: false,
          parentGateImpact: 'NONE',
          orderAllowed: false,
        },
        safetySuite: {
          defaultEnforcement: 'OBSERVE_ONLY',
          advancedGates: {
            contract: 'market-intelligence-advanced-gates/v1',
            policy: DEFAULT_ADVANCED_GATE_POLICY,
          },
          executionQuality: {
            contract: 'market-intelligence-execution-quality/v1',
            policy: DEFAULT_EXECUTION_QUALITY_POLICY,
          },
          portfolioSafety: {
            contract: 'market-intelligence-portfolio-safety/v1',
            policy: DEFAULT_PORTFOLIO_SAFETY_POLICY,
            killSwitchAuthority: 'BLOCK_NEW_ENTRIES_ONLY',
          },
        },
        signalOverlay: {
          endpoint: '/v1/overlay/signal-intelligence',
          contract: 'market-intelligence-signal-overlay/v1',
          stockEvidenceMode: 'NOT_AVAILABLE_UNTIL_PUBLIC_COLLECTOR_CONNECTED',
        },
        safety: safety(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/overlay/signal-intelligence') {
      const overlay = await buildSignalIntelligenceOverlay({
        signalBaseUrl: SIGNAL_INTELLIGENCE_BASE_URL,
        intelligenceBaseUrl: `http://${HOST}:${PORT}`,
      });
      return json(res, 200, { serviceSha: SERVICE_SHA, ...overlay });
    }

    if (req.method === 'POST' && url.pathname === '/v1/evaluate') {
      const body = await readJson(req);
      const result = await evaluateAndRemember(body);
      return json(res, 200, { ok: true, serviceSha: SERVICE_SHA, result });
    }

    const futuresMatch = req.method === 'GET' && url.pathname.match(/^\/v1\/public\/crypto\/futures\/([A-Za-z0-9]+)$/u);
    if (futuresMatch) {
      const input = await fetchBitgetFuturesEvidence(futuresMatch[1]);
      const result = await evaluateAndRemember(input);
      return json(res, 200, { ok: true, serviceSha: SERVICE_SHA, provenance: input.provenance, result });
    }

    const spotMatch = req.method === 'GET' && url.pathname.match(/^\/v1\/public\/crypto\/spot\/([A-Za-z0-9-]+)$/u);
    if (spotMatch) {
      const input = await fetchUpbitSpotEvidence(spotMatch[1]);
      const result = await evaluateAndRemember(input);
      return json(res, 200, { ok: true, serviceSha: SERVICE_SHA, provenance: input.provenance, result });
    }

    return json(res, 404, { ok: false, error: 'NOT_FOUND', safety: safety() });
  } catch (error) {
    return json(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      safety: safety(),
    });
  }
}

export const server = http.createServer(handler);

function isDirectEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  if (HOST !== '127.0.0.1') {
    console.error('MARKET_INTELLIGENCE_BIND_MUST_BE_LOOPBACK');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({
      event: 'market_intelligence_started',
      host: HOST,
      port: PORT,
      serviceSha: SERVICE_SHA,
      ...safety(),
    }));
  });
}

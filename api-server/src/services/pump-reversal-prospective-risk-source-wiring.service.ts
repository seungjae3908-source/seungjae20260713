import {
  buildAuthoritativeSizedContractRules,
  type AuthoritativePaperRiskPolicyEvidence,
} from './authoritative-paper-callback-owners.service';
import {
  buildBitgetFuturesPublicEvidence,
  buildBitgetFuturesPublicRequests,
  normalizeBitgetFuturesSymbol,
  type BitgetFuturesPublicEvidence,
  type BitgetPublicRequest,
} from './bitget-futures-public-evidence.service';
import { fetchPublicMarketJson } from './public-market-http';
import type { SupplementalExecutionCostEvidence } from './scanner-profit-cost-evidence-adapter.service';
import {
  createPumpReversalProspectiveRiskOwner,
  type PumpReversalProspectiveRiskOwnerSources,
  type PumpReversalProspectiveRiskSourceContext,
} from './pump-reversal-prospective-risk-owner.service';
import type {
  PumpPaperAccountRiskSnapshot,
  PumpPublicDepthSnapshot,
} from './pump-reversal-paper-risk-sizing.service';

export const PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_VERSION =
  'pump-reversal-public-risk-source-wiring-v1' as const;

const BITGET_BASE_URL = 'https://api.bitget.com';
const MAXIMUM_AGE_MS = 30_000;
const RISK_PERCENT = 0.25;
const LEVERAGE = 2;
const MAX_NOMINAL_ACCOUNT_PERCENT = 1;

type FetchPublicJson = (
  value: string | URL,
  options: Readonly<{ provider: string; signal?: AbortSignal }>,
) => Promise<unknown>;

type PublicEvidenceSource = (
  context: PumpReversalProspectiveRiskSourceContext,
) => Promise<BitgetFuturesPublicEvidence>;

type PumpSourceWiringInput = Readonly<{
  researchCodeSha: string;
  paperStateSnapshotForRecord:
    PumpReversalProspectiveRiskOwnerSources['paperStateSnapshotForRecord'];
  supplementalCostEvidenceForRecord:
    PumpReversalProspectiveRiskOwnerSources['supplementalCostEvidenceForRecord'];
  publicEvidenceForRecord?: PublicEvidenceSource;
  fetchPublicJson?: FetchPublicJson;
  now?: () => number;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}
function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}
function publicUrl(request: BitgetPublicRequest): URL {
  if (request.method !== 'GET') throw new Error('PUMP_PUBLIC_GET_REQUIRED');
  const url = new URL(request.path, BITGET_BASE_URL);
  url.search = request.query;
  return url;
}
function abortSignal(value: unknown): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}
function quantityPrecision(step: number): number | null {
  if (!positive(step)) return null;
  const text = step.toString().toLowerCase();
  const exponentMatch = /e-(\d+)$/u.exec(text);
  if (exponentMatch) {
    const exponent = Number(exponentMatch[1]);
    return Number.isInteger(exponent) && exponent >= 0 && exponent <= 12 ? exponent : null;
  }
  const dot = text.indexOf('.');
  if (dot < 0) return 0;
  const digits = text.length - dot - 1;
  return Number.isInteger(digits) && digits >= 0 && digits <= 12 ? digits : null;
}
function tierRows(payload: unknown): readonly Readonly<{
  startUnit: number;
  keepMarginRate: number;
}>[] {
  const envelope = record(payload);
  if (!envelope || envelope.code !== '00000'
    || !Array.isArray(envelope.data) || envelope.data.length === 0) {
    throw new Error('PUMP_POSITION_TIER_EVIDENCE_REQUIRED');
  }
  const rows = envelope.data.map((raw) => {
    const row = record(raw);
    const startUnit = Number(row?.startUnit);
    const keepMarginRate = Number(row?.keepMarginRate);
    if (!Number.isFinite(startUnit) || startUnit < 0
      || !Number.isFinite(keepMarginRate) || keepMarginRate < 0 || keepMarginRate >= 1) {
      throw new Error('PUMP_POSITION_TIER_ROW_INVALID');
    }
    return Object.freeze({ startUnit, keepMarginRate });
  }).sort((left, right) => left.startUnit - right.startUnit);
  if (rows[0]?.startUnit !== 0) throw new Error('PUMP_POSITION_TIER_FIRST_FLOOR_INVALID');
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].startUnit <= rows[index - 1].startUnit) {
      throw new Error('PUMP_POSITION_TIER_START_NOT_STRICT');
    }
    if (rows[index].keepMarginRate < rows[index - 1].keepMarginRate) {
      throw new Error('PUMP_POSITION_TIER_MMR_NOT_MONOTONIC');
    }
  }
  return Object.freeze(rows);
}
function depthLevels(value: unknown): readonly (readonly [number | string, number | string])[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const rows = value
    .filter((row) => Array.isArray(row)
      && row.length >= 2
      && positive(Number(row[0]))
      && positive(Number(row[1])))
    .map((row) => Object.freeze([row[0], row[1]] as const));
  return Object.freeze(rows);
}
function cardFor(context: PumpReversalProspectiveRiskSourceContext) {
  return Object.freeze({
    signalId: context.record.signal.signalId,
    symbol: context.record.signal.symbol,
  });
}
function riskPolicy(
  evidence: BitgetFuturesPublicEvidence,
): AuthoritativePaperRiskPolicyEvidence {
  return Object.freeze({
    schemaVersion: 'authoritative-paper-risk-policy-evidence-v1',
    leverage: LEVERAGE,
    riskPercent: RISK_PERCENT,
    marginMode: 'isolated',
    source: 'CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1_FIXED_RISK_POLICY',
    observedAtMs: evidence.observedAtMs,
    maximumAgeMs: MAXIMUM_AGE_MS,
  });
}

function defaultPublicEvidenceSource(
  fetchPublicJson: FetchPublicJson,
  now: () => number,
): PublicEvidenceSource {
  return async (context) => {
    const symbol = normalizeBitgetFuturesSymbol(context.record.signal.symbol);
    const requests = buildBitgetFuturesPublicRequests(symbol);
    const payloads = Object.fromEntries(await Promise.all(
      Object.entries(requests).map(async ([key, request]) => [
        key,
        await fetchPublicJson(publicUrl(request), { provider: 'bitget' }),
      ] as const),
    ));
    const observedAtMs = now();
    if (!positive(observedAtMs)) throw new Error('PUMP_PUBLIC_EVIDENCE_CLOCK_INVALID');
    return buildBitgetFuturesPublicEvidence({
      symbol,
      nowMs: observedAtMs,
      ticker: payloads.ticker,
      funding: payloads.funding,
      openInterest: payloads.openInterest,
      contract: payloads.contract,
      candles5m: payloads.symbol5m,
      candles1h: payloads.symbol1h,
      benchmarkBtc1h: payloads.benchmarkBtc1h,
      benchmarkBtc1d: payloads.benchmarkBtc1d,
    });
  };
}

export function createPumpReversalPublicRiskSourceWiring(
  input: PumpSourceWiringInput,
): Readonly<{
  sources: PumpReversalProspectiveRiskOwnerSources;
  createOwner(): ReturnType<typeof createPumpReversalProspectiveRiskOwner>;
  executionAuthority: 'NONE';
  liveTrading: false;
  privateTradingApiAllowed: false;
}> {
  const researchCodeSha = String(input?.researchCodeSha ?? '').trim().toLowerCase();
  if (!exactSha(researchCodeSha)) throw new TypeError('Pump risk wiring requires exact research SHA');
  if (typeof input?.paperStateSnapshotForRecord !== 'function'
    || typeof input?.supplementalCostEvidenceForRecord !== 'function') {
    throw new TypeError('Pump Paper snapshot and supplemental-cost owners are required');
  }
  const fetchPublicJson = input.fetchPublicJson ?? ((value, options) => fetchPublicMarketJson(value, options));
  const now = input.now ?? Date.now;
  if (typeof fetchPublicJson !== 'function' || typeof now !== 'function') {
    throw new TypeError('Pump public source dependencies are required');
  }
  const publicSource = input.publicEvidenceForRecord ?? defaultPublicEvidenceSource(fetchPublicJson, now);
  const publicCache = new WeakMap<object, Promise<BitgetFuturesPublicEvidence>>();

  function publicEvidence(context: PumpReversalProspectiveRiskSourceContext) {
    const key = context as object;
    const cached = publicCache.get(key);
    if (cached) return cached;
    const pending = Promise.resolve(publicSource(context));
    publicCache.set(key, pending);
    return pending;
  }

  const sources: PumpReversalProspectiveRiskOwnerSources = Object.freeze({
    paperStateSnapshotForRecord: input.paperStateSnapshotForRecord,

    async publicEvidenceForRecord(context) {
      return publicEvidence(context);
    },

    async contractRulesForRecord(context) {
      const account = context.account as PumpPaperAccountRiskSnapshot | undefined;
      if (!account || !positive(account.equity)) {
        throw new Error('PUMP_ACCOUNT_REQUIRED_BEFORE_CONTRACT_TIER');
      }
      const evidence = await publicEvidence(context);
      const symbol = normalizeBitgetFuturesSymbol(context.record.signal.symbol);
      const tierUrl = new URL('/api/v2/mix/market/query-position-lever', BITGET_BASE_URL);
      tierUrl.search = new URLSearchParams({
        productType: 'usdt-futures',
        symbol,
      }).toString();
      const tiers = tierRows(await fetchPublicJson(tierUrl, { provider: 'bitget' }));
      const precision = quantityPrecision(evidence.sizeMultiplier);
      if (precision == null) throw new Error('PUMP_QUANTITY_PRECISION_REQUIRED');
      const maximumProbeNotional = account.equity * (MAX_NOMINAL_ACCOUNT_PERCENT / 100);
      if (!positive(maximumProbeNotional)) throw new Error('PUMP_MAXIMUM_PROBE_NOTIONAL_INVALID');
      return buildAuthoritativeSizedContractRules({
        publicEvidence: evidence,
        positionTiers: tiers,
        sizedNotional: maximumProbeNotional,
        quantityPrecision: precision,
        riskPolicy: riskPolicy(evidence),
        observedAtMs: evidence.observedAtMs,
        nowMs: now(),
        maximumAgeMs: MAXIMUM_AGE_MS,
      }).contractRules;
    },

    async depthForRecord(context): Promise<PumpPublicDepthSnapshot> {
      const symbol = normalizeBitgetFuturesSymbol(context.record.signal.symbol);
      const url = new URL('/api/v3/market/orderbook', BITGET_BASE_URL);
      url.search = new URLSearchParams({
        category: 'USDT-FUTURES',
        symbol,
        limit: '50',
      }).toString();
      const requestStartedAtMs = now();
      const payload = record(await fetchPublicJson(url, { provider: 'bitget' }));
      const requestCompletedAtMs = now();
      const data = record(payload?.data);
      const observedAtMs = Number(data?.ts);
      const bids = depthLevels(data?.b);
      const asks = depthLevels(data?.a);
      if (payload?.code !== '00000'
        || !positive(requestStartedAtMs)
        || !positive(requestCompletedAtMs)
        || requestCompletedAtMs < requestStartedAtMs
        || !positive(observedAtMs)
        || observedAtMs > requestCompletedAtMs
        || requestCompletedAtMs - observedAtMs > MAXIMUM_AGE_MS
        || bids.length === 0
        || asks.length === 0) {
        throw new Error('PUMP_PUBLIC_L2_EVIDENCE_REQUIRED');
      }
      return Object.freeze({
        bids,
        asks,
        observedAtMs,
        requestStartedAtMs,
        requestCompletedAtMs,
        provenance: Object.freeze([
          'SIMULATED',
          'public-L2',
          'bitget-public-uta-v3-orderbook',
        ]),
      });
    },

    supplementalCostEvidenceForRecord: input.supplementalCostEvidenceForRecord,
  });

  return Object.freeze({
    sources,
    createOwner: () => createPumpReversalProspectiveRiskOwner({ sources, now }),
    executionAuthority: 'NONE',
    liveTrading: false,
    privateTradingApiAllowed: false,
  });
}

export const PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY = Object.freeze({
  schemaVersion: PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_VERSION,
  paperStateOwnerRequired: true,
  supplementalCostOwnerRequired: true,
  bitgetPublicMarketEvidence: true,
  bitgetPublicPositionTierEvidence: true,
  bitgetPublicL2Evidence: true,
  maximumProbeNotionalAccountPercent: MAX_NOMINAL_ACCOUNT_PERCENT,
  riskPercent: RISK_PERCENT,
  leverage: LEVERAGE,
  marginMode: 'isolated',
  executionAuthority: 'NONE',
  liveTrading: false,
  privateTradingApiAllowed: false,
  financialMutationAllowed: false,
});

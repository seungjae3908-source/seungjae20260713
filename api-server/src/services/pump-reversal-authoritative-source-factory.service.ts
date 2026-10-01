import {
  AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION,
  collectAuthoritativePaperExecutionObservationInput,
  type AuthoritativePaperExecutionObservationInput,
} from './authoritative-paper-execution-cost-sources.service';
import {
  buildAuthoritativeSizedContractRules,
  type AuthoritativePaperRiskPolicyEvidence,
} from './authoritative-paper-callback-owners.service';
import {
  buildBitgetFuturesPublicEvidence,
  buildBitgetFuturesPublicRequests,
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
import {
  sizePumpReversalPaperRisk,
  type PumpPublicDepthSnapshot,
} from './pump-reversal-paper-risk-sizing.service';

export const PUMP_REVERSAL_AUTHORITATIVE_SOURCE_FACTORY_VERSION =
  'pump-reversal-authoritative-source-factory-v1' as const;

const BITGET_BASE_URL = 'https://api.bitget.com';
const MAX_EVIDENCE_AGE_MS = 30_000;
const MAX_NOMINAL_ACCOUNT_PERCENT = 1;
const RISK_PERCENT = 0.25;
const LEVERAGE = 2;

type FetchPublicJson = (
  url: URL,
  input: Readonly<{ provider: string; signal?: AbortSignal }>,
) => Promise<unknown>;

type FactorySources = Readonly<{
  paperStateSnapshotForRecord:
    PumpReversalProspectiveRiskOwnerSources['paperStateSnapshotForRecord'];
  supplementalCostEvidenceForRecord:
    PumpReversalProspectiveRiskOwnerSources['supplementalCostEvidenceForRecord'];
}>;

type FactoryDependencies = Readonly<{
  fetchPublicJson: FetchPublicJson;
  buildPublicRequests: typeof buildBitgetFuturesPublicRequests;
  buildPublicEvidence: typeof buildBitgetFuturesPublicEvidence;
  collectExecutionInput: typeof collectAuthoritativePaperExecutionObservationInput;
  buildSizedContractRules: typeof buildAuthoritativeSizedContractRules;
  sizeRisk: typeof sizePumpReversalPaperRisk;
  now: () => number;
}>;

type MarketBundle = Readonly<{
  publicEvidence: BitgetFuturesPublicEvidence;
  contractRules: ReturnType<typeof buildAuthoritativeSizedContractRules>['contractRules'];
  depth: PumpPublicDepthSnapshot;
}>;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function numberish(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function publicUrl(request: BitgetPublicRequest): URL {
  if (request.method !== 'GET') throw new Error('PUMP_PUBLIC_GET_REQUIRED');
  const url = new URL(request.path, BITGET_BASE_URL);
  url.search = request.query;
  return url;
}
function positionTierUrl(symbol: string): URL {
  const url = new URL('/api/v2/mix/market/query-position-lever', BITGET_BASE_URL);
  url.search = new URLSearchParams({
    productType: 'usdt-futures',
    symbol,
  }).toString();
  return url;
}
function normalizeTierRows(payload: unknown): readonly Readonly<{
  startUnit: number;
  keepMarginRate: number;
}>[] {
  const envelope = record(payload);
  if (!envelope || String(envelope.code ?? '') !== '00000' || !Array.isArray(envelope.data) || envelope.data.length === 0) {
    throw new Error('PUMP_POSITION_TIER_EVIDENCE_REQUIRED');
  }
  const rows = envelope.data.map((raw) => {
    const row = record(raw);
    const startUnit = numberish(row?.startUnit);
    const keepMarginRate = numberish(row?.keepMarginRate);
    if (startUnit == null || startUnit < 0 || keepMarginRate == null || keepMarginRate < 0 || keepMarginRate >= 1) {
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
function quantityPrecision(step: number): number {
  if (!positive(step)) throw new Error('PUMP_QUANTITY_STEP_INVALID');
  for (let precision = 0; precision <= 12; precision += 1) {
    const scaled = step * 10 ** precision;
    if (Math.abs(scaled - Math.round(scaled))
      <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8) {
      return precision;
    }
  }
  throw new Error('PUMP_QUANTITY_PRECISION_UNRESOLVED');
}
function fixedRiskPolicy(observedAtMs: number): AuthoritativePaperRiskPolicyEvidence {
  return Object.freeze({
    schemaVersion: 'authoritative-paper-risk-policy-evidence-v1',
    leverage: LEVERAGE,
    riskPercent: RISK_PERCENT,
    marginMode: 'isolated',
    source: 'CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1_FROZEN_RISK_POLICY',
    observedAtMs,
    maximumAgeMs: MAX_EVIDENCE_AGE_MS,
  });
}
function defaultDependencies(): FactoryDependencies {
  return Object.freeze({
    fetchPublicJson: (url, input) => fetchPublicMarketJson(url, input),
    buildPublicRequests: buildBitgetFuturesPublicRequests,
    buildPublicEvidence: buildBitgetFuturesPublicEvidence,
    collectExecutionInput: collectAuthoritativePaperExecutionObservationInput,
    buildSizedContractRules: buildAuthoritativeSizedContractRules,
    sizeRisk: sizePumpReversalPaperRisk,
    now: Date.now,
  });
}

export function createPumpReversalProspectiveRiskOwnerFromAuthoritativeSources(input: Readonly<{
  researchCodeSha: string;
  sources: FactorySources;
  dependencies?: Partial<FactoryDependencies>;
}>) {
  const researchCodeSha = String(input?.researchCodeSha ?? '').trim().toLowerCase();
  if (!exactSha(researchCodeSha)) throw new TypeError('PUMP_AUTHORITATIVE_FACTORY_RESEARCH_SHA_REQUIRED');
  if (typeof input?.sources?.paperStateSnapshotForRecord !== 'function'
    || typeof input?.sources?.supplementalCostEvidenceForRecord !== 'function') {
    throw new TypeError('PUMP_AUTHORITATIVE_FACTORY_CALLBACKS_REQUIRED');
  }
  const dependencies = Object.freeze({
    ...defaultDependencies(),
    ...(input.dependencies ?? {}),
  }) as FactoryDependencies;
  if (typeof dependencies.fetchPublicJson !== 'function'
    || typeof dependencies.buildPublicRequests !== 'function'
    || typeof dependencies.buildPublicEvidence !== 'function'
    || typeof dependencies.collectExecutionInput !== 'function'
    || typeof dependencies.buildSizedContractRules !== 'function'
    || typeof dependencies.sizeRisk !== 'function'
    || typeof dependencies.now !== 'function') {
    throw new TypeError('PUMP_AUTHORITATIVE_FACTORY_DEPENDENCY_INVALID');
  }

  const marketBundleCache = new Map<string, Promise<MarketBundle>>();

  function resolveMarketBundle(context: PumpReversalProspectiveRiskSourceContext): Promise<MarketBundle> {
    const account = context.account;
    const recordValue = context.record;
    const signalId = recordValue?.signal?.signalId;
    const symbol = recordValue?.signal?.symbol;
    const entryPrice = recordValue?.position?.entryPrice;
    if (!account || !positive(account.equity) || !positive(entryPrice)
      || typeof signalId !== 'string' || !signalId || typeof symbol !== 'string' || !symbol) {
      return Promise.reject(new Error('PUMP_AUTHORITATIVE_FACTORY_CONTEXT_INVALID'));
    }
    const key = `${signalId}:${context.observedAtMs}`;
    const existing = marketBundleCache.get(key);
    if (existing) return existing;

    const pending = (async (): Promise<MarketBundle> => {
      const riskPolicy = fixedRiskPolicy(context.observedAtMs);
      const maximumProbeNotional = account.equity * (MAX_NOMINAL_ACCOUNT_PERCENT / 100);
      const maximumProbeQuantity = maximumProbeNotional / entryPrice;
      if (!positive(maximumProbeNotional) || !positive(maximumProbeQuantity)) {
        throw new Error('PUMP_AUTHORITATIVE_FACTORY_PROBE_INVALID');
      }

      const requests = dependencies.buildPublicRequests(symbol);
      const publicPayloadPromise = Promise.all(
        Object.entries(requests).map(async ([name, request]) => [
          name,
          await dependencies.fetchPublicJson(publicUrl(request), { provider: 'bitget' }),
        ] as const),
      );
      const tierPayloadPromise = dependencies.fetchPublicJson(positionTierUrl(symbol), { provider: 'bitget' });
      const executionInputPromise = dependencies.collectExecutionInput({
        context: {
          market: 'CRYPTO_FUTURES',
          card: { signalId, symbol, action: 'SHORT' },
        },
        sizingEvidence: Object.freeze({
          schemaVersion: AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION,
          signalId,
          symbol,
          direction: 'SHORT' as const,
          targetQuantity: maximumProbeQuantity,
          riskPolicy,
          source: 'PUMP_REVERSAL_MAX_1PCT_PUBLIC_L2_PROBE',
          observedAtMs: context.observedAtMs,
          maximumAgeMs: MAX_EVIDENCE_AGE_MS,
        }),
        fetchPublicJson: dependencies.fetchPublicJson,
        now: dependencies.now,
      });

      const [publicEntries, tierPayload, executionInput] = await Promise.all([
        publicPayloadPromise,
        tierPayloadPromise,
        executionInputPromise,
      ]);
      const completedAtMs = dependencies.now();
      if (!safeTime(completedAtMs) || completedAtMs < context.observedAtMs) {
        throw new Error('PUMP_AUTHORITATIVE_FACTORY_CLOCK_INVALID');
      }
      if (!executionInput) throw new Error('PUMP_PUBLIC_L2_EVIDENCE_REQUIRED');

      const payloads = Object.fromEntries(publicEntries);
      const publicEvidence = dependencies.buildPublicEvidence({
        symbol,
        nowMs: completedAtMs,
        ticker: payloads.ticker,
        funding: payloads.funding,
        openInterest: payloads.openInterest,
        contract: payloads.contract,
        candles5m: payloads.symbol5m,
        candles1h: payloads.symbol1h,
        benchmarkBtc1h: payloads.benchmarkBtc1h,
        benchmarkBtc1d: payloads.benchmarkBtc1d,
      });
      const tiers = normalizeTierRows(tierPayload);
      const contractRules = dependencies.buildSizedContractRules({
        publicEvidence,
        positionTiers: tiers,
        sizedNotional: maximumProbeNotional,
        quantityPrecision: quantityPrecision(publicEvidence.sizeMultiplier),
        riskPolicy,
        observedAtMs: publicEvidence.observedAtMs,
        nowMs: completedAtMs,
        maximumAgeMs: MAX_EVIDENCE_AGE_MS,
      }).contractRules;

      const executionEvidenceInput = executionInput.executionEvidenceInput;
      const depth: PumpPublicDepthSnapshot = Object.freeze({
        bids: executionEvidenceInput.bids,
        asks: executionEvidenceInput.asks,
        observedAtMs: executionEvidenceInput.observedAtMs,
        requestStartedAtMs: executionEvidenceInput.requestStartedAtMs ?? null,
        requestCompletedAtMs: executionEvidenceInput.requestCompletedAtMs ?? null,
        provenance: Object.freeze([...executionEvidenceInput.provenance]),
      });

      return Object.freeze({ publicEvidence, contractRules, depth });
    })();

    marketBundleCache.set(key, pending);
    void pending.finally(() => marketBundleCache.delete(key));
    return pending;
  }

  return createPumpReversalProspectiveRiskOwner({
    now: dependencies.now,
    sizeRisk: dependencies.sizeRisk,
    sources: {
      paperStateSnapshotForRecord: input.sources.paperStateSnapshotForRecord,
      supplementalCostEvidenceForRecord: input.sources.supplementalCostEvidenceForRecord,
      contractRulesForRecord: async (context) => (await resolveMarketBundle(context)).contractRules,
      publicEvidenceForRecord: async (context) => (await resolveMarketBundle(context)).publicEvidence,
      depthForRecord: async (context) => (await resolveMarketBundle(context)).depth,
    },
  });
}

export const PUMP_REVERSAL_AUTHORITATIVE_SOURCE_FACTORY_SAFETY = Object.freeze({
  schemaVersion: PUMP_REVERSAL_AUTHORITATIVE_SOURCE_FACTORY_VERSION,
  requiredInjectedCallbacks: Object.freeze([
    'paperStateSnapshotForRecord',
    'supplementalCostEvidenceForRecord',
  ]),
  bitgetPublicEvidenceOwnerReused: true,
  bitgetPublicL2OwnerReused: true,
  bitgetPositionTierOwnerReused: true,
  positionTierSizedAtMaximumOnePercentProbe: true,
  riskPolicy: Object.freeze({
    riskPercent: RISK_PERCENT,
    leverage: LEVERAGE,
    marginMode: 'isolated',
  }),
  privateApiAllowed: false,
  liveOrderAllowed: false,
  financialMutationAllowed: false,
  executionAuthority: 'NONE',
  profitabilityClaimAllowed: false,
});

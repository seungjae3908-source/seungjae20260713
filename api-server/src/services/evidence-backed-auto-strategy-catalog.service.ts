export type EvidenceBackedAutoStrategyMarket =
  | 'US_STOCK'
  | 'KR_STOCK'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_FUTURES'
  | 'CROSS_VENUE_CRYPTO';

export type EvidenceBackedAutoStrategyId =
  | 'CEX_DEX_ARBITRAGE_V1'
  | 'US_STOCKS_IN_PLAY_ORB_V1'
  | 'CRYPTO_WORLD_ORDER_FLOW_ML_V1'
  | 'KR_ML_CHARTING_V1';

type StrategyReadinessKey =
  | 'publicDataReady'
  | 'sourceFaithfulReplicationReady'
  | 'oosPassed'
  | 'walkForwardPassed'
  | 'fullCostPassed'
  | 'strategyHealthPassed'
  | 'pitUniverseReady'
  | 'intraday5mReady'
  | 'first5mRvolReady'
  | 'openingRangeReady'
  | 'multiExchangeOrderFlowReady'
  | 'modelFrozen'
  | 'dexExecutionProviderReady'
  | 'atomicHedgeReady'
  | 'crossVenueCostReady'
  | 'multiLegExecutionAdapterReady';

export type EvidenceBackedAutoStrategyDefinition = Readonly<{
  strategyId: EvidenceBackedAutoStrategyId;
  label: string;
  market: EvidenceBackedAutoStrategyMarket;
  researchRole: string;
  defaultState: 'NO_TRADE';
  paperRequirements: readonly StrategyReadinessKey[];
  livePromotionAlwaysServerAttested: true;
  automaticLivePromotionAllowed: false;
}>;

export const EVIDENCE_BACKED_AUTO_STRATEGIES: readonly EvidenceBackedAutoStrategyDefinition[] =
  Object.freeze([
    Object.freeze({
      strategyId: 'CEX_DEX_ARBITRAGE_V1',
      label: 'CEX↔DEX Arbitrage',
      market: 'CROSS_VENUE_CRYPTO',
      researchRole: 'market-neutral cross-venue arbitrage',
      defaultState: 'NO_TRADE',
      paperRequirements: Object.freeze([
        'publicDataReady',
        'sourceFaithfulReplicationReady',
        'oosPassed',
        'walkForwardPassed',
        'fullCostPassed',
        'strategyHealthPassed',
        'dexExecutionProviderReady',
        'atomicHedgeReady',
        'crossVenueCostReady',
        'multiLegExecutionAdapterReady',
      ]),
      livePromotionAlwaysServerAttested: true,
      automaticLivePromotionAllowed: false,
    }),
    Object.freeze({
      strategyId: 'US_STOCKS_IN_PLAY_ORB_V1',
      label: 'US Stocks-in-Play ORB',
      market: 'US_STOCK',
      researchRole: 'intraday candidate selection + opening-range continuation',
      defaultState: 'NO_TRADE',
      paperRequirements: Object.freeze([
        'publicDataReady',
        'sourceFaithfulReplicationReady',
        'oosPassed',
        'walkForwardPassed',
        'fullCostPassed',
        'strategyHealthPassed',
        'pitUniverseReady',
        'intraday5mReady',
        'first5mRvolReady',
        'openingRangeReady',
      ]),
      livePromotionAlwaysServerAttested: true,
      automaticLivePromotionAllowed: false,
    }),
    Object.freeze({
      strategyId: 'CRYPTO_WORLD_ORDER_FLOW_ML_V1',
      label: 'Crypto World Order Flow ML',
      market: 'CRYPTO_SPOT',
      researchRole: 'multi-exchange order-flow candidate ranker + selective long',
      defaultState: 'NO_TRADE',
      paperRequirements: Object.freeze([
        'publicDataReady',
        'sourceFaithfulReplicationReady',
        'oosPassed',
        'walkForwardPassed',
        'fullCostPassed',
        'strategyHealthPassed',
        'multiExchangeOrderFlowReady',
        'modelFrozen',
      ]),
      livePromotionAlwaysServerAttested: true,
      automaticLivePromotionAllowed: false,
    }),
    Object.freeze({
      strategyId: 'KR_ML_CHARTING_V1',
      label: 'KR ML Charting',
      market: 'KR_STOCK',
      researchRole: 'Korea nonlinear chart ranker + selective long',
      defaultState: 'NO_TRADE',
      paperRequirements: Object.freeze([
        'publicDataReady',
        'sourceFaithfulReplicationReady',
        'oosPassed',
        'walkForwardPassed',
        'fullCostPassed',
        'strategyHealthPassed',
        'pitUniverseReady',
        'modelFrozen',
      ]),
      livePromotionAlwaysServerAttested: true,
      automaticLivePromotionAllowed: false,
    }),
  ]);

const BY_ID = new Map(EVIDENCE_BACKED_AUTO_STRATEGIES.map((item) => [item.strategyId, item]));

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readinessSnapshot(learningSnapshot: unknown) {
  const learning = record(learningSnapshot);
  return record(learning?.evidenceBackedStrategyReadiness);
}

function marketCompatible(
  definition: EvidenceBackedAutoStrategyDefinition,
  market: string,
) {
  if (definition.market === 'CROSS_VENUE_CRYPTO') {
    return market === 'CRYPTO_SPOT' || market === 'CRYPTO_FUTURES';
  }
  return definition.market === market;
}

export type EvidenceBackedAutoStrategyGate = Readonly<{
  recognized: boolean;
  strategyId: string;
  state: 'PASS_THROUGH' | 'NO_TRADE' | 'PAPER_CANDIDATE';
  paperAllowed: boolean;
  liveAllowed: false;
  blockers: readonly string[];
  definition: EvidenceBackedAutoStrategyDefinition | null;
}>;

export function evaluateEvidenceBackedAutoStrategyGate(input: {
  strategyId: string;
  market: string;
  learningSnapshot?: unknown;
}): EvidenceBackedAutoStrategyGate {
  const definition = BY_ID.get(input.strategyId as EvidenceBackedAutoStrategyId) ?? null;
  if (!definition) {
    return Object.freeze({
      recognized: false,
      strategyId: input.strategyId,
      state: 'PASS_THROUGH',
      paperAllowed: true,
      liveAllowed: false,
      blockers: Object.freeze([]),
      definition: null,
    });
  }

  const blockers: string[] = [];
  if (!marketCompatible(definition, input.market)) {
    blockers.push('EVIDENCE_STRATEGY_MARKET_MISMATCH');
  }

  const readiness = readinessSnapshot(input.learningSnapshot);
  if (!readiness) {
    blockers.push('EVIDENCE_STRATEGY_READINESS_REQUIRED');
  } else {
    if (readiness.strategyId !== definition.strategyId) {
      blockers.push('EVIDENCE_STRATEGY_READINESS_ID_MISMATCH');
    }
    for (const key of definition.paperRequirements) {
      if (readiness[key] !== true) blockers.push(`EVIDENCE_STRATEGY_${key.replace(/[A-Z]/g, (value) => `_${value}`).toUpperCase()}_REQUIRED`);
    }
  }

  // The current canonical trade engine is single-plan/single-provider. A true
  // CEX↔DEX hedge is intentionally blocked until a multi-leg execution adapter
  // and DEX provider are bound; this prevents accidental one-legged exposure.
  if (definition.strategyId === 'CEX_DEX_ARBITRAGE_V1') {
    blockers.push('EVIDENCE_STRATEGY_CROSS_VENUE_ATOMIC_EXECUTION_REQUIRED');
  }

  const unique = [...new Set(blockers)].sort();
  return Object.freeze({
    recognized: true,
    strategyId: definition.strategyId,
    state: unique.length === 0 ? 'PAPER_CANDIDATE' : 'NO_TRADE',
    paperAllowed: unique.length === 0,
    liveAllowed: false,
    blockers: Object.freeze(unique),
    definition,
  });
}

export function evidenceBackedAutoStrategyCatalog() {
  return EVIDENCE_BACKED_AUTO_STRATEGIES;
}

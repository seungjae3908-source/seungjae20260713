import { applyPaperTradingAction, createPaperTradingState } from './paper-trading-engine.service';
import {
  isEvidenceBackedAutoStrategyId,
  evidenceBackedAutoStrategyCatalog,
} from './evidence-backed-auto-strategy-catalog.service';
import {
  PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW,
  PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW,
} from './trade-automation.types';

export const FORMULA_AI_REHEARSAL_POLICY_VERSION = 'formula-ai-rehearsal-v1' as const;

export type FormulaAiRehearsalInput = Readonly<{
  strategyId: string;
  market: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
  direction: 'BUY' | 'LONG' | 'SHORT';
  deterministicRuleReady: boolean;
  aiDecision: 'PASS' | 'ABSTAIN' | 'VETO' | 'UNAVAILABLE';
  providersReady: boolean;
  credentialReuseReady: boolean;
  paperAutoReady: boolean;
  paperFillReady: boolean;
  journalReady: boolean;
  telegramReady: boolean;
  futuresMarginMode?: 'isolated' | 'crossed' | null;
  futuresLeverage?: number | null;
}>;

export type FormulaAiPaperRehearsalProbe = Readonly<{
  initialCapitalKrw: number;
  paperAutoReady: boolean;
  paperFillReady: boolean;
  journalReady: boolean;
  riskReady: boolean;
  orderState: string | null;
  fillCount: number;
  journalEntryCount: number;
  executionAuthority: 'NONE';
  realOrderSubmitted: false;
  exchangeRequestSent: false;
  providerMutationRequests: 0;
  productionMutationAllowed: false;
}>;

export function runFormulaAiPaperRehearsalProbe(
  now = new Date(),
  requestedInitialCapitalKrw: number = PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW,
): FormulaAiPaperRehearsalProbe {
  const initialCapitalKrw = requestedInitialCapitalKrw === PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW
    ? PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW
    : PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW;
  const at = new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('FORMULA_AI_REHEARSAL_INVALID_TIME');
  const observedAt = at.toISOString();
  const state = createPaperTradingState(initialCapitalKrw, at);
  const entryResult = applyPaperTradingAction(state, {
    type: 'place_order',
    eventId: `formula-ai-rehearsal-${at.getTime()}`,
    request: {
      symbol: 'BTCUSDT',
      side: 'long',
      orderType: 'market',
      leverage: 2,
      stopLossPrice: 98,
      takeProfitPrice1: 105,
      takeProfitPrice2: 108,
      targetClosePercent1: 50,
      targetClosePercent2: 50,
      strategyName: 'FORMULA_AI_REHEARSAL_PROBE',
      marketRegime: 'rehearsal',
    },
    market: {
      symbol: 'BTCUSDT',
      price: 100,
      lastPrice: 100,
      markPrice: 100,
      bidPrice: 99.9,
      askPrice: 100.1,
      fundingRate: 0.0001,
      status: 'live',
      updatedAt: observedAt,
      warnings: [],
    },
    contractRules: {
      symbol: 'BTCUSDT',
      quantityStep: 0.001,
      quantityPrecision: 3,
      minimumQuantity: 0.001,
      minimumNotional: 5,
      maximumLeverage: 7,
      maintenanceMarginRate: 0.005,
      status: 'live',
      updatedAt: observedAt,
      warnings: [],
    },
    riskInput: {
      market: 'crypto-futures',
      symbol: 'BTCUSDT',
      side: 'long',
      accountBalance: initialCapitalKrw,
      entryPrice: 100,
      stopLossPrice: 98,
      targetPrice1: 105,
      targetPrice2: 108,
      leverage: 2,
      riskPercent: 0.5,
      entryFeeRate: 0.0006,
      exitFeeRate: 0.0006,
      slippageRate: 0.0005,
      estimatedFundingRate: 0.0001,
      quantityStep: 0.001,
      quantityPrecision: 3,
      minimumQuantity: 0.001,
      minimumNotional: 5,
      maintenanceMarginRate: 0.005,
      maximumLeverage: 7,
      appMaximumLeverage: 7,
      contractRulesStatus: 'live',
      dataStatus: 'live',
    },
  }, at);

  const paperAutoReady = entryResult.order?.status === 'filled' && entryResult.position?.status === 'open';
  const riskReady = entryResult.order?.riskResult?.allowed === true;
  const closeAt = new Date(at.getTime() + 1_000);
  const closeResult = entryResult.position
    ? applyPaperTradingAction(entryResult.state, {
        type: 'close_position',
        eventId: `formula-ai-rehearsal-${at.getTime()}-close`,
        positionId: entryResult.position.id,
        percentage: 100,
        reason: 'manual_close',
        market: {
          symbol: 'BTCUSDT',
          price: 103,
          lastPrice: 103,
          markPrice: 103,
          bidPrice: 102.9,
          askPrice: 103.1,
          fundingRate: 0.0001,
          status: 'live',
          updatedAt: closeAt.toISOString(),
          warnings: [],
        },
      }, closeAt)
    : null;
  const paperFillReady = entryResult.fills.length > 0
    && Boolean(closeResult?.fills.length);
  const journalReady = Boolean(closeResult?.state.journal.length);
  const fillCount = entryResult.fills.length + (closeResult?.fills.length ?? 0);
  const journalEntryCount = closeResult?.state.journal.length ?? entryResult.state.journal.length;

  return Object.freeze({
    initialCapitalKrw,
    paperAutoReady,
    paperFillReady,
    journalReady,
    riskReady,
    orderState: entryResult.order?.status ?? null,
    fillCount,
    journalEntryCount,
    executionAuthority: 'NONE',
    realOrderSubmitted: false,
    exchangeRequestSent: false,
    providerMutationRequests: 0,
    productionMutationAllowed: false,
  });
}

export type FormulaAiRehearsalResult = Readonly<{
  status: 'ACTIVE_REHEARSAL' | 'BLOCKED_REHEARSAL';
  strategyId: string;
  exceptionPolicyApplied: boolean;
  oosRequiredForRehearsal: false;
  profitabilityPromotionRequiredForRehearsal: false;
  wouldActivateLiveAuto: boolean;
  executionAuthority: 'NONE';
  realOrderSubmitted: false;
  productionMutationAllowed: false;
  blockers: readonly string[];
}>;

function add(values: string[], code: string) {
  if (!values.includes(code)) values.push(code);
}

function directionAllowed(market: FormulaAiRehearsalInput['market'], direction: FormulaAiRehearsalInput['direction']) {
  if (market === 'CRYPTO_FUTURES') return direction === 'LONG' || direction === 'SHORT';
  return direction === 'BUY';
}

export function evaluateFormulaAiAutoRehearsal(input: FormulaAiRehearsalInput): FormulaAiRehearsalResult {
  const blockers: string[] = [];
  const recognized = isEvidenceBackedAutoStrategyId(input.strategyId);
  if (!recognized) add(blockers, 'FORMULA_AI_STRATEGY_NOT_ALLOWLISTED');

  const definition = recognized
    ? evidenceBackedAutoStrategyCatalog().find((row) => row.strategyId === input.strategyId) ?? null
    : null;
  if (!definition || !definition.markets.includes(input.market)) add(blockers, 'FORMULA_AI_MARKET_MISMATCH');
  if (!directionAllowed(input.market, input.direction)
    || (definition && !definition.directions.includes(input.direction))) {
    add(blockers, 'FORMULA_AI_DIRECTION_FORBIDDEN');
  }

  if (!input.deterministicRuleReady) add(blockers, 'FORMULA_AI_DETERMINISTIC_RULE_NOT_READY');
  if (input.aiDecision !== 'PASS') add(blockers, 'FORMULA_AI_AI_PASS_REQUIRED');
  if (!input.providersReady) add(blockers, 'FORMULA_AI_PROVIDERS_NOT_READY');
  if (!input.credentialReuseReady) add(blockers, 'FORMULA_AI_CREDENTIAL_REUSE_NOT_READY');
  if (!input.paperAutoReady) add(blockers, 'FORMULA_AI_PAPER_AUTO_NOT_READY');
  if (!input.paperFillReady) add(blockers, 'FORMULA_AI_PAPER_FILL_NOT_READY');
  if (!input.journalReady) add(blockers, 'FORMULA_AI_JOURNAL_NOT_READY');
  if (!input.telegramReady) add(blockers, 'FORMULA_AI_TELEGRAM_NOT_READY');

  if (input.market === 'CRYPTO_FUTURES') {
    if (input.futuresMarginMode !== 'isolated') add(blockers, 'FORMULA_AI_FUTURES_ISOLATED_REQUIRED');
    const leverage = Number(input.futuresLeverage);
    if (!Number.isInteger(leverage) || leverage < 2 || leverage > 7) {
      add(blockers, 'FORMULA_AI_FUTURES_LEVERAGE_LIMIT');
    }
  }

  const active = blockers.length === 0;
  return Object.freeze({
    status: active ? 'ACTIVE_REHEARSAL' : 'BLOCKED_REHEARSAL',
    strategyId: input.strategyId,
    exceptionPolicyApplied: recognized,
    oosRequiredForRehearsal: false,
    profitabilityPromotionRequiredForRehearsal: false,
    wouldActivateLiveAuto: active,
    executionAuthority: 'NONE',
    realOrderSubmitted: false,
    productionMutationAllowed: false,
    blockers: Object.freeze(blockers.sort()),
  });
}

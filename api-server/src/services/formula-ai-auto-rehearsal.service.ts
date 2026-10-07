import {
  isEvidenceBackedAutoStrategyId,
  evidenceBackedAutoStrategyCatalog,
} from './evidence-backed-auto-strategy-catalog.service';

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

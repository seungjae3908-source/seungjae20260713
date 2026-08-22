export type PaperResearchMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type PaperResearchQuoteCurrency = 'KRW' | 'USD' | 'USDT';

export type PaperResearchFxEvidence = Readonly<{
  market: PaperResearchMarket;
  quoteCurrency: PaperResearchQuoteCurrency;
  krwPerUnit: number;
  observedAtMs: number;
  source: string;
  provenance: string;
  version: string;
}>;

export type PaperResearchPortfolioBlocker =
  | 'INITIAL_CAPITAL_NOT_CANONICAL'
  | 'MARKET_COVERAGE_INCOMPLETE'
  | 'FX_EVIDENCE_MISSING'
  | 'FX_QUOTE_CURRENCY_MISMATCH'
  | 'FX_RATE_INVALID'
  | 'FX_TIMESTAMP_INVALID'
  | 'FX_FROM_FUTURE'
  | 'FX_STALE'
  | 'FX_SOURCE_REQUIRED'
  | 'FX_PROVENANCE_REQUIRED'
  | 'FX_VERSION_REQUIRED'
  | 'CURRENCY_AWARE_LEDGER_NOT_INTEGRATED';

export type PaperResearchPortfolioReadiness = Readonly<{
  status: 'BLOCKED';
  blockers: readonly PaperResearchPortfolioBlocker[];
  canonicalInitialCapitalKrw: 1_000_000;
  baseCurrency: 'KRW';
  requiredMarkets: readonly PaperResearchMarket[];
  requiredQuoteCurrencies: Readonly<Record<PaperResearchMarket, PaperResearchQuoteCurrency>>;
  fxEvidenceReady: boolean;
  currencyAwareLedgerIntegrated: false;
  autoPaperAllowed: false;
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  profitabilityClaimAllowed: false;
}>;

export const CANONICAL_PAPER_INITIAL_CAPITAL_KRW = 1_000_000 as const;
export const PAPER_RESEARCH_BASE_CURRENCY = 'KRW' as const;
export const PAPER_RESEARCH_MARKETS = Object.freeze([
  'KR_STOCK',
  'US_STOCK',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
] as const);
export const PAPER_RESEARCH_QUOTE_CURRENCY: Readonly<Record<PaperResearchMarket, PaperResearchQuoteCurrency>> = Object.freeze({
  KR_STOCK: 'KRW',
  US_STOCK: 'USD',
  CRYPTO_SPOT: 'KRW',
  CRYPTO_FUTURES: 'USDT',
});

const DEFAULT_MAX_FX_AGE_MS = 5 * 60_000;

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function add(blockers: PaperResearchPortfolioBlocker[], blocker: PaperResearchPortfolioBlocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

export function validatePaperResearchPortfolioReadiness(
  input: Readonly<{
    initialCapitalKrw: number;
    markets: readonly PaperResearchMarket[];
    fxEvidence: readonly PaperResearchFxEvidence[];
  }>,
  nowMs = Date.now(),
  maxFxAgeMs = DEFAULT_MAX_FX_AGE_MS,
): PaperResearchPortfolioReadiness {
  const blockers: PaperResearchPortfolioBlocker[] = [];

  if (input.initialCapitalKrw !== CANONICAL_PAPER_INITIAL_CAPITAL_KRW) {
    add(blockers, 'INITIAL_CAPITAL_NOT_CANONICAL');
  }

  const markets = new Set(input.markets);
  if (PAPER_RESEARCH_MARKETS.some((market) => !markets.has(market)) || markets.size !== PAPER_RESEARCH_MARKETS.length) {
    add(blockers, 'MARKET_COVERAGE_INCOMPLETE');
  }

  if (!finitePositive(nowMs) || !finitePositive(maxFxAgeMs)) {
    add(blockers, 'FX_TIMESTAMP_INVALID');
  }

  for (const market of PAPER_RESEARCH_MARKETS) {
    const expectedCurrency = PAPER_RESEARCH_QUOTE_CURRENCY[market];
    const evidence = input.fxEvidence.find((row) => row.market === market);
    if (!evidence) {
      add(blockers, 'FX_EVIDENCE_MISSING');
      continue;
    }
    if (evidence.quoteCurrency !== expectedCurrency) add(blockers, 'FX_QUOTE_CURRENCY_MISMATCH');
    if (!finitePositive(evidence.krwPerUnit)) add(blockers, 'FX_RATE_INVALID');
    if (!finitePositive(evidence.observedAtMs)) {
      add(blockers, 'FX_TIMESTAMP_INVALID');
    } else if (finitePositive(nowMs) && evidence.observedAtMs > nowMs) {
      add(blockers, 'FX_FROM_FUTURE');
    } else if (finitePositive(nowMs) && finitePositive(maxFxAgeMs) && nowMs - evidence.observedAtMs > maxFxAgeMs) {
      add(blockers, 'FX_STALE');
    }
    if (!nonEmpty(evidence.source)) add(blockers, 'FX_SOURCE_REQUIRED');
    if (!nonEmpty(evidence.provenance)) add(blockers, 'FX_PROVENANCE_REQUIRED');
    if (!nonEmpty(evidence.version)) add(blockers, 'FX_VERSION_REQUIRED');

    // KRW-settled venues need no conversion, but the contract requires an explicit identity rate
    // so all four markets carry the same timestamped provenance shape.
    if (expectedCurrency === 'KRW' && evidence.krwPerUnit !== 1) add(blockers, 'FX_RATE_INVALID');
  }

  const fxOnlyBlockers = blockers.filter((blocker) => blocker !== 'INITIAL_CAPITAL_NOT_CANONICAL'
    && blocker !== 'MARKET_COVERAGE_INCOMPLETE'
    && blocker !== 'CURRENCY_AWARE_LEDGER_NOT_INTEGRATED');
  const fxEvidenceReady = fxOnlyBlockers.length === 0;

  // Current PaperTradingState has one untyped numeric balance and no market/quote/base-currency
  // fields. Never combine KRW, USD and USDT PnL until a currency-aware ledger/adapter exists.
  add(blockers, 'CURRENCY_AWARE_LEDGER_NOT_INTEGRATED');

  return Object.freeze({
    status: 'BLOCKED',
    blockers: Object.freeze([...blockers]),
    canonicalInitialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    baseCurrency: PAPER_RESEARCH_BASE_CURRENCY,
    requiredMarkets: PAPER_RESEARCH_MARKETS,
    requiredQuoteCurrencies: PAPER_RESEARCH_QUOTE_CURRENCY,
    fxEvidenceReady,
    currencyAwareLedgerIntegrated: false,
    autoPaperAllowed: false,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    profitabilityClaimAllowed: false,
  });
}

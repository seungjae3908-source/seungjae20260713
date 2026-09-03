import {
  buildPortfolioAssetSummary,
  type FxQuote,
  type PortfolioAssetBucket,
  type PortfolioDataQuality,
} from '../modules/portfolio/intelligence-v2.ts';
import {
  CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
  PAPER_RESEARCH_MARKETS,
  PAPER_RESEARCH_QUOTE_CURRENCY,
  validatePaperResearchPortfolioReadiness,
  type PaperResearchFxEvidence,
  type PaperResearchMarket,
  type PaperResearchPortfolioBlocker,
  type PaperResearchQuoteCurrency,
} from './paper-research-portfolio-contract.service.ts';

export type PaperResearchLedgerBucket = 'CASH' | PaperResearchMarket;

export type PaperResearchLedgerEntry = Readonly<{
  id: string;
  bucket: PaperResearchLedgerBucket;
  nativeAmount: number;
  quoteCurrency: PaperResearchQuoteCurrency;
  observedAtMs: number;
  source: string;
  provenance: string;
  version: string;
  quality: PortfolioDataQuality;
}>;

export type PaperResearchLedgerBlocker =
  | PaperResearchPortfolioBlocker
  | 'FX_EVIDENCE_DUPLICATE'
  | 'LEDGER_EMPTY'
  | 'LEDGER_ENTRY_ID_REQUIRED'
  | 'LEDGER_ENTRY_ID_DUPLICATE'
  | 'LEDGER_BUCKET_INVALID'
  | 'LEDGER_QUOTE_CURRENCY_MISMATCH'
  | 'LEDGER_NATIVE_AMOUNT_INVALID'
  | 'LEDGER_TIMESTAMP_INVALID'
  | 'LEDGER_FROM_FUTURE'
  | 'LEDGER_SOURCE_REQUIRED'
  | 'LEDGER_PROVENANCE_REQUIRED'
  | 'LEDGER_VERSION_REQUIRED'
  | 'LEDGER_QUALITY_INVALID';

export type PaperResearchCurrencyLedgerComponent = Readonly<{
  id: string;
  bucket: PaperResearchLedgerBucket;
  nativeAmount: number;
  quoteCurrency: PaperResearchQuoteCurrency;
  observedAtMs: number;
  source: string;
  provenance: string;
  version: string;
  quality: PortfolioDataQuality;
  normalizedKrwAmount: number | null;
  fxRate: number | null;
  fxSource: string | null;
  fxObservedAtMs: number | null;
  fxProvenance: string | null;
  fxVersion: string | null;
  normalizationStatus: 'READY' | 'FX_UNAVAILABLE';
}>;

export type PaperResearchCurrencyLedger = Readonly<{
  schemaVersion: 'paper-research-currency-ledger-v1';
  status: 'READY' | 'PARTIAL' | 'BLOCKED';
  blockers: readonly PaperResearchLedgerBlocker[];
  initialCapitalKrw: 1_000_000;
  baseCurrency: 'KRW';
  components: readonly PaperResearchCurrencyLedgerComponent[];
  knownEquityKrw: number;
  totalEquityKrw: number | null;
  currencyAwareLedgerIntegrated: true;
  persistentLedgerIntegrated: false;
  signalToPaperIntegrated: false;
  schedulerIntegrated: false;
  autoPaperAllowed: false;
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  profitabilityClaimAllowed: false;
}>;

const DEFAULT_MAX_EVIDENCE_AGE_MS = 5 * 60_000;
const ALLOWED_QUALITY = new Set<PortfolioDataQuality>(['LIVE', 'DELAYED', 'STALE', 'PARTIAL', 'UNAVAILABLE']);

export const PAPER_RESEARCH_LEDGER_CURRENCY: Readonly<Record<PaperResearchLedgerBucket, PaperResearchQuoteCurrency>> = Object.freeze({
  CASH: 'KRW',
  ...PAPER_RESEARCH_QUOTE_CURRENCY,
});

const PORTFOLIO_BUCKET: Readonly<Record<PaperResearchLedgerBucket, PortfolioAssetBucket>> = Object.freeze({
  CASH: 'CASH',
  KR_STOCK: 'KR_STOCKS',
  US_STOCK: 'US_STOCKS',
  CRYPTO_SPOT: 'CRYPTO_SPOT',
  CRYPTO_FUTURES: 'CRYPTO_FUTURES_EQUITY',
});

const FATAL_READINESS_BLOCKERS = new Set<PaperResearchPortfolioBlocker>([
  'INITIAL_CAPITAL_NOT_CANONICAL',
  'MARKET_COVERAGE_INCOMPLETE',
  'FX_QUOTE_CURRENCY_MISMATCH',
  'FX_RATE_INVALID',
  'FX_TIMESTAMP_INVALID',
  'FX_FROM_FUTURE',
  'FX_SOURCE_REQUIRED',
  'FX_PROVENANCE_REQUIRED',
  'FX_VERSION_REQUIRED',
]);

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function add(blockers: PaperResearchLedgerBlocker[], blocker: PaperResearchLedgerBlocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function expectedCurrency(bucket: unknown): PaperResearchQuoteCurrency | null {
  return typeof bucket === 'string' && Object.prototype.hasOwnProperty.call(PAPER_RESEARCH_LEDGER_CURRENCY, bucket)
    ? PAPER_RESEARCH_LEDGER_CURRENCY[bucket as PaperResearchLedgerBucket]
    : null;
}

function usableFxEvidence(
  evidence: PaperResearchFxEvidence | undefined,
  currency: 'USD' | 'USDT',
  nowMs: number,
  maxEvidenceAgeMs: number,
): evidence is PaperResearchFxEvidence {
  return Boolean(
    evidence
    && evidence.quoteCurrency === currency
    && finitePositive(evidence.krwPerUnit)
    && finitePositive(evidence.observedAtMs)
    && evidence.observedAtMs <= nowMs
    && nowMs - evidence.observedAtMs <= maxEvidenceAgeMs
    && nonEmpty(evidence.source)
    && nonEmpty(evidence.provenance)
    && nonEmpty(evidence.version),
  );
}

function toFxQuotes(
  evidence: readonly PaperResearchFxEvidence[],
  nowMs: number,
  maxEvidenceAgeMs: number,
): FxQuote[] {
  const quotes: FxQuote[] = [];
  const usd = evidence.find((row) => row.market === 'US_STOCK');
  const usdt = evidence.find((row) => row.market === 'CRYPTO_FUTURES');
  if (usableFxEvidence(usd, 'USD', nowMs, maxEvidenceAgeMs)) {
    quotes.push({
      currency: 'USD',
      krwRate: usd.krwPerUnit,
      source: usd.source,
      asOf: new Date(usd.observedAtMs).toISOString(),
      quality: 'DELAYED',
    });
  }
  if (usableFxEvidence(usdt, 'USDT', nowMs, maxEvidenceAgeMs)) {
    quotes.push({
      currency: 'USDT',
      krwRate: usdt.krwPerUnit,
      source: usdt.source,
      asOf: new Date(usdt.observedAtMs).toISOString(),
      quality: 'DELAYED',
    });
  }
  return quotes;
}

function fxMetadataFor(
  entry: PaperResearchLedgerEntry,
  evidence: readonly PaperResearchFxEvidence[],
): Pick<PaperResearchCurrencyLedgerComponent, 'fxProvenance' | 'fxVersion'> {
  if (entry.quoteCurrency === 'KRW') {
    const marketEvidence = entry.bucket === 'CASH'
      ? undefined
      : evidence.find((row) => row.market === entry.bucket);
    return {
      fxProvenance: marketEvidence?.provenance ?? 'native-krw',
      fxVersion: marketEvidence?.version ?? 'identity-v1',
    };
  }
  const marketEvidence = evidence.find((row) => row.market === entry.bucket);
  return {
    fxProvenance: marketEvidence?.provenance ?? null,
    fxVersion: marketEvidence?.version ?? null,
  };
}

export function buildPaperResearchCurrencyLedger(
  input: Readonly<{
    initialCapitalKrw: number;
    markets: readonly PaperResearchMarket[];
    fxEvidence: readonly PaperResearchFxEvidence[];
    entries: readonly PaperResearchLedgerEntry[];
  }>,
  nowMs = Date.now(),
  maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
): PaperResearchCurrencyLedger {
  const blockers: PaperResearchLedgerBlocker[] = [];
  const safeNowMs = finitePositive(nowMs) ? nowMs : 0;
  const safeMaxAgeMs = finitePositive(maxEvidenceAgeMs) ? maxEvidenceAgeMs : DEFAULT_MAX_EVIDENCE_AGE_MS;

  const readiness = validatePaperResearchPortfolioReadiness(
    {
      initialCapitalKrw: input.initialCapitalKrw,
      markets: input.markets,
      fxEvidence: input.fxEvidence,
    },
    nowMs,
    maxEvidenceAgeMs,
  );
  for (const blocker of readiness.blockers) {
    if (blocker !== 'CURRENCY_AWARE_LEDGER_NOT_INTEGRATED') add(blockers, blocker);
  }

  const fxMarkets = new Set<PaperResearchMarket>();
  for (const row of input.fxEvidence) {
    if (fxMarkets.has(row.market)) add(blockers, 'FX_EVIDENCE_DUPLICATE');
    fxMarkets.add(row.market);
  }

  if (input.entries.length === 0) add(blockers, 'LEDGER_EMPTY');
  const ids = new Set<string>();
  const structurallyValidEntries: PaperResearchLedgerEntry[] = [];
  const unavailableEntryIds = new Set<string>();

  for (const entry of input.entries) {
    let structurallyValid = true;
    if (!nonEmpty(entry.id)) {
      add(blockers, 'LEDGER_ENTRY_ID_REQUIRED');
      structurallyValid = false;
    } else if (ids.has(entry.id)) {
      add(blockers, 'LEDGER_ENTRY_ID_DUPLICATE');
      structurallyValid = false;
    } else {
      ids.add(entry.id);
    }

    const currency = expectedCurrency(entry.bucket);
    if (currency == null) {
      add(blockers, 'LEDGER_BUCKET_INVALID');
      structurallyValid = false;
    } else if (entry.quoteCurrency !== currency) {
      add(blockers, 'LEDGER_QUOTE_CURRENCY_MISMATCH');
      structurallyValid = false;
    }
    if (!finiteNonNegative(entry.nativeAmount)) {
      add(blockers, 'LEDGER_NATIVE_AMOUNT_INVALID');
      structurallyValid = false;
    }
    if (!finitePositive(entry.observedAtMs)) {
      add(blockers, 'LEDGER_TIMESTAMP_INVALID');
      structurallyValid = false;
    } else if (safeNowMs > 0 && entry.observedAtMs > safeNowMs) {
      add(blockers, 'LEDGER_FROM_FUTURE');
      structurallyValid = false;
    } else if (safeNowMs > 0 && safeNowMs - entry.observedAtMs > safeMaxAgeMs) {
      unavailableEntryIds.add(entry.id);
    }
    if (!nonEmpty(entry.source)) {
      add(blockers, 'LEDGER_SOURCE_REQUIRED');
      structurallyValid = false;
    }
    if (!nonEmpty(entry.provenance)) {
      add(blockers, 'LEDGER_PROVENANCE_REQUIRED');
      structurallyValid = false;
    }
    if (!nonEmpty(entry.version)) {
      add(blockers, 'LEDGER_VERSION_REQUIRED');
      structurallyValid = false;
    }
    if (!ALLOWED_QUALITY.has(entry.quality)) {
      add(blockers, 'LEDGER_QUALITY_INVALID');
      structurallyValid = false;
    } else if (entry.quality === 'STALE' || entry.quality === 'UNAVAILABLE') {
      unavailableEntryIds.add(entry.id);
    }
    if (structurallyValid) structurallyValidEntries.push(entry);
  }

  const fxQuotes = toFxQuotes(input.fxEvidence, safeNowMs, safeMaxAgeMs);
  const summary = buildPortfolioAssetSummary(
    structurallyValidEntries.map((entry) => ({
      bucket: PORTFOLIO_BUCKET[entry.bucket],
      amount: entry.nativeAmount,
      currency: entry.quoteCurrency,
      source: entry.source,
      asOf: new Date(entry.observedAtMs).toISOString(),
      quality: unavailableEntryIds.has(entry.id) ? 'UNAVAILABLE' : entry.quality,
    })),
    fxQuotes,
    { now: new Date(safeNowMs), maxFxAgeMs: safeMaxAgeMs },
  );

  const components: PaperResearchCurrencyLedgerComponent[] = summary.components.map((component, index) => {
    const entry = structurallyValidEntries[index];
    const metadata = fxMetadataFor(entry, input.fxEvidence);
    return Object.freeze({
      id: entry.id,
      bucket: entry.bucket,
      nativeAmount: entry.nativeAmount,
      quoteCurrency: entry.quoteCurrency,
      observedAtMs: entry.observedAtMs,
      source: entry.source,
      provenance: entry.provenance,
      version: entry.version,
      quality: entry.quality,
      normalizedKrwAmount: component.normalizedKRWAmount,
      fxRate: component.fxRate,
      fxSource: component.fxSource,
      fxObservedAtMs: component.fxAsOf == null ? null : Date.parse(component.fxAsOf),
      fxProvenance: metadata.fxProvenance,
      fxVersion: metadata.fxVersion,
      normalizationStatus: component.status,
    });
  });

  const structuralBlocker = blockers.some((blocker) =>
    blocker === 'FX_EVIDENCE_DUPLICATE'
    || blocker === 'LEDGER_EMPTY'
    || blocker.startsWith('LEDGER_') && blocker !== 'LEDGER_TIMESTAMP_INVALID'
    || blocker === 'LEDGER_TIMESTAMP_INVALID'
    || FATAL_READINESS_BLOCKERS.has(blocker as PaperResearchPortfolioBlocker));
  const partial = !structuralBlocker && (
    summary.status === 'PARTIAL'
    || blockers.includes('FX_EVIDENCE_MISSING')
    || blockers.includes('FX_STALE')
    || unavailableEntryIds.size > 0
  );
  const status: PaperResearchCurrencyLedger['status'] = structuralBlocker ? 'BLOCKED' : partial ? 'PARTIAL' : 'READY';

  return Object.freeze({
    schemaVersion: 'paper-research-currency-ledger-v1',
    status,
    blockers: Object.freeze([...blockers]),
    initialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    baseCurrency: 'KRW',
    components: Object.freeze(components),
    knownEquityKrw: summary.knownNormalizedKRWAmount,
    totalEquityKrw: status === 'READY' ? summary.totalNormalizedKRWAmount : null,
    currencyAwareLedgerIntegrated: true,
    persistentLedgerIntegrated: false,
    signalToPaperIntegrated: false,
    schedulerIntegrated: false,
    autoPaperAllowed: false,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    profitabilityClaimAllowed: false,
  });
}

export const PAPER_RESEARCH_LEDGER_MARKETS = PAPER_RESEARCH_MARKETS;

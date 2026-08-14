import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
  PAPER_RESEARCH_MARKETS,
  validatePaperResearchPortfolioReadiness,
  type PaperResearchFxEvidence,
} from './paper-research-portfolio-contract.service';

const NOW = 1_800_000_000_000;

function fxEvidence(overrides: Partial<Record<'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES', Partial<PaperResearchFxEvidence>>> = {}) {
  const base: PaperResearchFxEvidence[] = [
    {
      market: 'KR_STOCK',
      quoteCurrency: 'KRW',
      krwPerUnit: 1,
      observedAtMs: NOW - 1_000,
      source: 'identity-krw',
      provenance: 'canonical-krw-settlement',
      version: 'fx-v1',
    },
    {
      market: 'US_STOCK',
      quoteCurrency: 'USD',
      krwPerUnit: 1_350,
      observedAtMs: NOW - 1_000,
      source: 'public-fx-fixture',
      provenance: 'usdkrw-test-provenance',
      version: 'fx-v1',
    },
    {
      market: 'CRYPTO_SPOT',
      quoteCurrency: 'KRW',
      krwPerUnit: 1,
      observedAtMs: NOW - 1_000,
      source: 'identity-krw',
      provenance: 'upbit-krw-settlement',
      version: 'fx-v1',
    },
    {
      market: 'CRYPTO_FUTURES',
      quoteCurrency: 'USDT',
      krwPerUnit: 1_360,
      observedAtMs: NOW - 1_000,
      source: 'public-fx-fixture',
      provenance: 'usdtkrw-test-provenance',
      version: 'fx-v1',
    },
  ];
  return base.map((row) => Object.freeze({ ...row, ...(overrides[row.market] ?? {}) }));
}

test('canonical one-million-won four-market research remains blocked until ledger is currency-aware', () => {
  const result = validatePaperResearchPortfolioReadiness({
    initialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    markets: PAPER_RESEARCH_MARKETS,
    fxEvidence: fxEvidence(),
  }, NOW);

  assert.equal(result.fxEvidenceReady, true);
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['CURRENCY_AWARE_LEDGER_NOT_INTEGRATED']);
  assert.equal(result.currencyAwareLedgerIntegrated, false);
  assert.equal(result.autoPaperAllowed, false);
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.profitabilityClaimAllowed, false);
});

test('non-canonical capital and incomplete market coverage fail closed', () => {
  const result = validatePaperResearchPortfolioReadiness({
    initialCapitalKrw: 10_000,
    markets: ['KR_STOCK', 'CRYPTO_SPOT'],
    fxEvidence: fxEvidence(),
  }, NOW);

  assert.ok(result.blockers.includes('INITIAL_CAPITAL_NOT_CANONICAL'));
  assert.ok(result.blockers.includes('MARKET_COVERAGE_INCOMPLETE'));
  assert.equal(result.autoPaperAllowed, false);
});

test('USD and USDT require fresh positive KRW conversion provenance', () => {
  const result = validatePaperResearchPortfolioReadiness({
    initialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    markets: PAPER_RESEARCH_MARKETS,
    fxEvidence: fxEvidence({
      US_STOCK: { krwPerUnit: 0, provenance: '', observedAtMs: NOW - 600_000 },
      CRYPTO_FUTURES: { quoteCurrency: 'USD', observedAtMs: NOW + 1 },
    }),
  }, NOW);

  assert.equal(result.fxEvidenceReady, false);
  assert.ok(result.blockers.includes('FX_RATE_INVALID'));
  assert.ok(result.blockers.includes('FX_PROVENANCE_REQUIRED'));
  assert.ok(result.blockers.includes('FX_STALE'));
  assert.ok(result.blockers.includes('FX_QUOTE_CURRENCY_MISMATCH'));
  assert.ok(result.blockers.includes('FX_FROM_FUTURE'));
  assert.equal(result.autoPaperAllowed, false);
});

test('KRW-settled markets require explicit identity conversion rate', () => {
  const result = validatePaperResearchPortfolioReadiness({
    initialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    markets: PAPER_RESEARCH_MARKETS,
    fxEvidence: fxEvidence({
      KR_STOCK: { krwPerUnit: 1.01 },
    }),
  }, NOW);

  assert.equal(result.fxEvidenceReady, false);
  assert.ok(result.blockers.includes('FX_RATE_INVALID'));
  assert.equal(result.autoPaperAllowed, false);
});

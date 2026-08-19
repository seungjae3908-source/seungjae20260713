import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'paper-research-portfolio-contract-'));
const output = path.join(temporaryDirectory, 'contract.mjs');
const NOW = 1_800_000_000_000;

try {
  await build({
    entryPoints: [path.join(root, 'src/services/paper-research-portfolio-contract.service.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });

  const contract = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
  const {
    CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    PAPER_RESEARCH_MARKETS,
    validatePaperResearchPortfolioReadiness,
  } = contract;

  const fxEvidence = (overrides = {}) => [
    {
      market: 'KR_STOCK', quoteCurrency: 'KRW', krwPerUnit: 1,
      observedAtMs: NOW - 1_000, source: 'identity-krw', provenance: 'canonical-krw-settlement', version: 'fx-v1',
      ...(overrides.KR_STOCK ?? {}),
    },
    {
      market: 'US_STOCK', quoteCurrency: 'USD', krwPerUnit: 1_350,
      observedAtMs: NOW - 1_000, source: 'public-fx-fixture', provenance: 'usdkrw-test-provenance', version: 'fx-v1',
      ...(overrides.US_STOCK ?? {}),
    },
    {
      market: 'CRYPTO_SPOT', quoteCurrency: 'KRW', krwPerUnit: 1,
      observedAtMs: NOW - 1_000, source: 'identity-krw', provenance: 'upbit-krw-settlement', version: 'fx-v1',
      ...(overrides.CRYPTO_SPOT ?? {}),
    },
    {
      market: 'CRYPTO_FUTURES', quoteCurrency: 'USDT', krwPerUnit: 1_360,
      observedAtMs: NOW - 1_000, source: 'public-fx-fixture', provenance: 'usdtkrw-test-provenance', version: 'fx-v1',
      ...(overrides.CRYPTO_FUTURES ?? {}),
    },
  ];

  const canonical = validatePaperResearchPortfolioReadiness({
    initialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    markets: PAPER_RESEARCH_MARKETS,
    fxEvidence: fxEvidence(),
  }, NOW);
  assert.equal(canonical.fxEvidenceReady, true);
  assert.equal(canonical.status, 'BLOCKED');
  assert.deepEqual(canonical.blockers, ['CURRENCY_AWARE_LEDGER_NOT_INTEGRATED']);
  assert.equal(canonical.currencyAwareLedgerIntegrated, false);
  assert.equal(canonical.autoPaperAllowed, false);
  assert.equal(canonical.liveOrderAllowed, false);
  assert.equal(canonical.privateTradingApiAllowed, false);
  assert.equal(canonical.orderSubmitted, false);
  assert.equal(canonical.profitabilityClaimAllowed, false);

  const incomplete = validatePaperResearchPortfolioReadiness({
    initialCapitalKrw: 10_000,
    markets: ['KR_STOCK', 'CRYPTO_SPOT'],
    fxEvidence: fxEvidence(),
  }, NOW);
  assert.ok(incomplete.blockers.includes('INITIAL_CAPITAL_NOT_CANONICAL'));
  assert.ok(incomplete.blockers.includes('MARKET_COVERAGE_INCOMPLETE'));
  assert.equal(incomplete.autoPaperAllowed, false);

  const invalidFx = validatePaperResearchPortfolioReadiness({
    initialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    markets: PAPER_RESEARCH_MARKETS,
    fxEvidence: fxEvidence({
      US_STOCK: { krwPerUnit: 0, provenance: '', observedAtMs: NOW - 600_000 },
      CRYPTO_FUTURES: { quoteCurrency: 'USD', observedAtMs: NOW + 1 },
    }),
  }, NOW);
  assert.equal(invalidFx.fxEvidenceReady, false);
  for (const blocker of ['FX_RATE_INVALID', 'FX_PROVENANCE_REQUIRED', 'FX_STALE', 'FX_QUOTE_CURRENCY_MISMATCH', 'FX_FROM_FUTURE']) {
    assert.ok(invalidFx.blockers.includes(blocker), `missing blocker ${blocker}`);
  }

  const badIdentity = validatePaperResearchPortfolioReadiness({
    initialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    markets: PAPER_RESEARCH_MARKETS,
    fxEvidence: fxEvidence({ KR_STOCK: { krwPerUnit: 1.01 } }),
  }, NOW);
  assert.equal(badIdentity.fxEvidenceReady, false);
  assert.ok(badIdentity.blockers.includes('FX_RATE_INVALID'));

  console.log(JSON.stringify({
    status: 'pass',
    canonicalInitialCapitalKrw: CANONICAL_PAPER_INITIAL_CAPITAL_KRW,
    requiredMarkets: PAPER_RESEARCH_MARKETS,
    canonicalFxEvidenceReady: canonical.fxEvidenceReady,
    currencyAwareLedgerIntegrated: canonical.currencyAwareLedgerIntegrated,
    autoPaperAllowed: canonical.autoPaperAllowed,
    profitabilityClaimAllowed: canonical.profitabilityClaimAllowed,
  }));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

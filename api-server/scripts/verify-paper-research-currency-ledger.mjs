import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'paper-research-currency-ledger-'));
const output = path.join(temporaryDirectory, 'ledger.mjs');
const NOW = 1_800_000_000_000;

try {
  await build({
    entryPoints: [path.join(root, 'src/services/paper-research-currency-ledger.service.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });

  const ledgerModule = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
  const {
    PAPER_RESEARCH_LEDGER_CURRENCY,
    PAPER_RESEARCH_LEDGER_MARKETS,
    buildPaperResearchCurrencyLedger,
  } = ledgerModule;

  const fxEvidence = (overrides = {}) => [
    {
      market: 'KR_STOCK', quoteCurrency: 'KRW', krwPerUnit: 1,
      observedAtMs: NOW - 1_000, source: 'identity-krw', provenance: 'canonical-krw-settlement', version: 'fx-v1',
      ...(overrides.KR_STOCK ?? {}),
    },
    {
      market: 'US_STOCK', quoteCurrency: 'USD', krwPerUnit: 1_350,
      observedAtMs: NOW - 1_000, source: 'yahoo-public:KRW=X', provenance: 'usdkrw-public', version: 'fx-v1',
      ...(overrides.US_STOCK ?? {}),
    },
    {
      market: 'CRYPTO_SPOT', quoteCurrency: 'KRW', krwPerUnit: 1,
      observedAtMs: NOW - 1_000, source: 'identity-krw', provenance: 'upbit-krw-settlement', version: 'fx-v1',
      ...(overrides.CRYPTO_SPOT ?? {}),
    },
    {
      market: 'CRYPTO_FUTURES', quoteCurrency: 'USDT', krwPerUnit: 1_360,
      observedAtMs: NOW - 1_000, source: 'upbit-public:KRW-USDT', provenance: 'usdtkrw-public', version: 'fx-v1',
      ...(overrides.CRYPTO_FUTURES ?? {}),
    },
  ];

  const entries = (overrides = {}) => [
    {
      id: 'cash', bucket: 'CASH', nativeAmount: 400_000, quoteCurrency: 'KRW', observedAtMs: NOW - 1_000,
      source: 'paper-ledger', provenance: 'paper-cash-v1', version: 'ledger-v1', quality: 'LIVE',
      ...(overrides.CASH ?? {}),
    },
    {
      id: 'kr', bucket: 'KR_STOCK', nativeAmount: 200_000, quoteCurrency: 'KRW', observedAtMs: NOW - 1_000,
      source: 'paper-ledger', provenance: 'kr-stock-v1', version: 'ledger-v1', quality: 'LIVE',
      ...(overrides.KR_STOCK ?? {}),
    },
    {
      id: 'us', bucket: 'US_STOCK', nativeAmount: 100, quoteCurrency: 'USD', observedAtMs: NOW - 1_000,
      source: 'paper-ledger', provenance: 'us-stock-v1', version: 'ledger-v1', quality: 'LIVE',
      ...(overrides.US_STOCK ?? {}),
    },
    {
      id: 'spot', bucket: 'CRYPTO_SPOT', nativeAmount: 100_000, quoteCurrency: 'KRW', observedAtMs: NOW - 1_000,
      source: 'paper-ledger', provenance: 'upbit-spot-v1', version: 'ledger-v1', quality: 'LIVE',
      ...(overrides.CRYPTO_SPOT ?? {}),
    },
    {
      id: 'futures', bucket: 'CRYPTO_FUTURES', nativeAmount: 50, quoteCurrency: 'USDT', observedAtMs: NOW - 1_000,
      source: 'paper-ledger', provenance: 'bitget-equity-v1', version: 'ledger-v1', quality: 'LIVE',
      ...(overrides.CRYPTO_FUTURES ?? {}),
    },
  ];

  const buildCanonical = (extra = {}) => buildPaperResearchCurrencyLedger({
    initialCapitalKrw: 1_000_000,
    markets: PAPER_RESEARCH_LEDGER_MARKETS,
    fxEvidence: fxEvidence(),
    entries: entries(),
    ...extra,
  }, NOW);

  assert.deepEqual(PAPER_RESEARCH_LEDGER_CURRENCY, {
    CASH: 'KRW', KR_STOCK: 'KRW', US_STOCK: 'USD', CRYPTO_SPOT: 'KRW', CRYPTO_FUTURES: 'USDT',
  });

  const canonical = buildCanonical();
  assert.equal(canonical.status, 'READY');
  assert.equal(canonical.initialCapitalKrw, 1_000_000);
  assert.equal(canonical.currencyAwareLedgerIntegrated, true);
  assert.equal(canonical.knownEquityKrw, 903_000);
  assert.equal(canonical.totalEquityKrw, 903_000);
  assert.equal(canonical.components.find((row) => row.id === 'us').normalizedKrwAmount, 135_000);
  assert.equal(canonical.components.find((row) => row.id === 'futures').normalizedKrwAmount, 68_000);
  assert.equal(canonical.components.find((row) => row.id === 'kr').fxRate, 1);
  assert.equal(canonical.persistentLedgerIntegrated, false);
  assert.equal(canonical.signalToPaperIntegrated, false);
  assert.equal(canonical.schedulerIntegrated, false);
  assert.equal(canonical.autoPaperAllowed, false);
  assert.equal(canonical.liveOrderAllowed, false);
  assert.equal(canonical.privateTradingApiAllowed, false);
  assert.equal(canonical.orderSubmitted, false);
  assert.equal(canonical.profitabilityClaimAllowed, false);

  const missingUsd = buildCanonical({ fxEvidence: fxEvidence().filter((row) => row.market !== 'US_STOCK') });
  assert.equal(missingUsd.status, 'PARTIAL');
  assert.ok(missingUsd.blockers.includes('FX_EVIDENCE_MISSING'));
  assert.equal(missingUsd.totalEquityKrw, null);
  assert.equal(missingUsd.knownEquityKrw, 768_000);
  assert.equal(missingUsd.components.find((row) => row.id === 'us').normalizedKrwAmount, null);

  const staleUsd = buildCanonical({ fxEvidence: fxEvidence({ US_STOCK: { observedAtMs: NOW - 600_000 } }) });
  assert.equal(staleUsd.status, 'PARTIAL');
  assert.ok(staleUsd.blockers.includes('FX_STALE'));
  assert.equal(staleUsd.totalEquityKrw, null);
  assert.equal(staleUsd.components.find((row) => row.id === 'us').normalizationStatus, 'FX_UNAVAILABLE');

  const futureUsd = buildCanonical({ fxEvidence: fxEvidence({ US_STOCK: { observedAtMs: NOW + 1 } }) });
  assert.equal(futureUsd.status, 'BLOCKED');
  assert.ok(futureUsd.blockers.includes('FX_FROM_FUTURE'));
  assert.equal(futureUsd.totalEquityKrw, null);

  const mismatch = buildCanonical({ entries: entries({ US_STOCK: { quoteCurrency: 'KRW' } }) });
  assert.equal(mismatch.status, 'BLOCKED');
  assert.ok(mismatch.blockers.includes('LEDGER_QUOTE_CURRENCY_MISMATCH'));
  assert.equal(mismatch.totalEquityKrw, null);

  const invalidAmount = buildCanonical({ entries: entries({ CRYPTO_FUTURES: { nativeAmount: Number.NaN } }) });
  assert.equal(invalidAmount.status, 'BLOCKED');
  assert.ok(invalidAmount.blockers.includes('LEDGER_NATIVE_AMOUNT_INVALID'));

  const negativeAmount = buildCanonical({ entries: entries({ KR_STOCK: { nativeAmount: -1 } }) });
  assert.equal(negativeAmount.status, 'BLOCKED');
  assert.ok(negativeAmount.blockers.includes('LEDGER_NATIVE_AMOUNT_INVALID'));

  const duplicateIdRows = entries();
  duplicateIdRows[1] = { ...duplicateIdRows[1], id: duplicateIdRows[0].id };
  const duplicateId = buildCanonical({ entries: duplicateIdRows });
  assert.equal(duplicateId.status, 'BLOCKED');
  assert.ok(duplicateId.blockers.includes('LEDGER_ENTRY_ID_DUPLICATE'));

  const staleEntry = buildCanonical({ entries: entries({ US_STOCK: { observedAtMs: NOW - 600_000 } }) });
  assert.equal(staleEntry.status, 'PARTIAL');
  assert.equal(staleEntry.totalEquityKrw, null);
  assert.equal(staleEntry.components.find((row) => row.id === 'us').normalizedKrwAmount, null);

  const futureEntry = buildCanonical({ entries: entries({ US_STOCK: { observedAtMs: NOW + 1 } }) });
  assert.equal(futureEntry.status, 'BLOCKED');
  assert.ok(futureEntry.blockers.includes('LEDGER_FROM_FUTURE'));

  const repeated = buildCanonical();
  assert.deepEqual(repeated, canonical);

  const serialized = JSON.stringify(canonical);
  for (const forbidden of ['apiKey', 'secret', 'token', 'accountNumber', 'privateKey']) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field leaked: ${forbidden}`);
  }

  console.log(JSON.stringify({
    status: 'pass',
    schemaVersion: canonical.schemaVersion,
    canonicalInitialCapitalKrw: canonical.initialCapitalKrw,
    markets: PAPER_RESEARCH_LEDGER_MARKETS,
    currencyAwareLedgerIntegrated: canonical.currencyAwareLedgerIntegrated,
    persistentLedgerIntegrated: canonical.persistentLedgerIntegrated,
    signalToPaperIntegrated: canonical.signalToPaperIntegrated,
    schedulerIntegrated: canonical.schedulerIntegrated,
    canonicalKnownEquityKrw: canonical.knownEquityKrw,
    canonicalTotalEquityKrw: canonical.totalEquityKrw,
    autoPaperAllowed: canonical.autoPaperAllowed,
    profitabilityClaimAllowed: canonical.profitabilityClaimAllowed,
  }));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

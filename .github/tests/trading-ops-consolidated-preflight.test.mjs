import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (path) => fs.readFileSync(path, 'utf8');

test('account read UI refresh is bounded, visible-only, and non-overlapping', () => {
  const source = read('stock-analyzer/src/components/brokerage-account-connections.tsx');
  assert.match(source, /ACCOUNT_AUTO_REFRESH_MS = 10_000/);
  assert.match(source, /refreshInFlight/);
  assert.match(source, /document\.visibilityState === 'visible'/);
  assert.match(source, /trade-execution-completed/);
  assert.match(source, /account-last-synced/);
});

test('journal has three requested books, custom dates, persistent broker import, and Excel export', () => {
  const panel = read('stock-analyzer/src/components/unified-trade-journal-panel.tsx');
  const sync = read('stock-analyzer/src/lib/paper-journal-sync.ts');
  const page = read('stock-analyzer/src/pages/auto-trading.tsx');
  for (const marker of [
    '직접매매',
    '자동매매',
    '자동모의매매',
    'unified-journal-custom-period',
    'unified-journal-excel',
    'unified-journal-import-history',
    'application/vnd.ms-excel',
  ]) assert.ok(panel.includes(marker), marker);
  assert.ok(sync.includes("'APP_MANUAL'"));
  assert.ok(sync.includes('/api/paper-journal/import-account-history'));
  assert.ok(!page.includes("forcedSource={mode === 'auto' ? 'APP_AUTO' : 'APP_PAPER'}"));
});

test('canonical app execution ledger is projected into journal without provider-history duplication', () => {
  const adapter = read('api-server/src/services/trade-automation-unified-journal-adapter.ts');
  const route = read('api-server/src/routes/paper-journal.ts');
  const service = read('api-server/src/services/trade-automation.service.ts');
  for (const marker of [
    "'APP_MANUAL'",
    "'APP_AUTO'",
    "'APP_PAPER'",
    "'APP_SHADOW'",
    'APP_TRADE_AUTOMATION_LEDGER_PROJECTION',
  ]) assert.ok(adapter.includes(marker), marker);
  assert.ok(route.includes('readTradeAutomationJournalPayloads'));
  assert.ok(route.includes('knownBrokerOrderIds'));
  assert.ok(route.includes('BROKER_HISTORY_IMPORTED_PERSISTENTLY'));
  assert.ok(!route.includes("...payload.warnings.filter((item): item is string => typeof item === 'string'), 'BROKER_HISTORY_IMPORTED_PERSISTENTLY'"));
  assert.ok(route.includes('/paper-journal/import-account-history'));
  assert.ok(route.includes("['toss', 'kiwoom']"));
  assert.ok(service.includes("executionMode: policy.mode === 'automatic' && policy.automaticEnabled ? 'automatic' : 'manual'"));
});

test('Toss existing-order history uses CLOSED read-only endpoint', () => {
  const source = read('api-server/src/features/account-readonly/account-readonly.journal-history.ts');
  assert.ok(source.includes("provider === 'toss'"));
  assert.ok(source.includes("'status=CLOSED'"));
  assert.ok(source.includes('normalizeTossOrderContract'));
  assert.ok(source.includes('REAL_ACCOUNT_HISTORY_NOT_PERSISTED'));
});

test('four-market automatic gate couples live auto and paper worker and consumes QA v2', () => {
  const handoff = read('market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js');
  const worker = read('api-server/src/services/member-auto-trading-background-worker.service.ts');
  const aiGate = read('api-server/src/services/evidence-backed-auto-strategy-catalog.service.ts');
  const aiProducer = read('api-server/src/services/trade-rule-pack-ai-review.service.ts');
  const boundedAi = read('api-server/src/services/bounded-ai-json-provider.service.ts');
  const scannerAi = read('api-server/src/services/scanner-ai-runtime.service.ts');
  const stockScanner = read('api-server/src/services/stock-signal-scanner.service.ts');
  const cryptoScanner = read('api-server/src/routes/crypto-signal-scan.ts');
  const index = read('api-server/src/index.ts');
  const execution = read('api-server/src/services/trade-execution.service.ts');
  const gate = read('.github/workflows/production-automatic-trading-gate.yml');
  const verifier = read('api-server/scripts/verify-production-automatic-trading-gate.mjs');
  const deploy = read('ops/deploy-production.sh');
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']) {
    assert.ok(handoff.includes(market), market);
  }
  assert.ok(worker.includes("accountMode: 'paper'"));
  assert.ok(worker.includes('persistMemberAutoTradingPaperPositionBridge'));
  assert.ok(worker.includes("process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED !== 'true'"));
  assert.ok(index.includes('startMemberAutoTradingBackgroundWorker()'));
  assert.ok(execution.includes("plan.accountMode === 'paper'"));
  assert.ok(execution.includes('PAPER_BROKER_FILLED'));
  assert.ok(gate.includes('/activate-production-auto-trading '));
  assert.ok(gate.includes('all4'));
  assert.ok(gate.includes('production-account-readonly-live-qa-v2'));
  assert.ok(gate.includes("MEMBER_AUTO_TRADING_BACKGROUND_ENABLED: enabled ? 'true' : 'false'"));
  assert.ok(gate.includes("MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: enabled ? 'true' : 'false'"));
  assert.ok(gate.includes("MEMBER_AUTO_TRADING_BACKGROUND_ENABLED: 'false'"));
  assert.ok(gate.includes("MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: 'false'"));
  assert.ok(gate.includes('AUTOMATIC_TRADING_ACTIVATION_FAILED_ROLLED_BACK'));
  assert.ok(verifier.includes('AUTO_GATE_ACCOUNT_QA_SCHEMA_V2_MISSING'));
  assert.ok(deploy.includes('MEMBER_AUTO_TRADING_BACKGROUND_ENABLED=false'));
  assert.ok(deploy.includes('MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED=false'));
  assert.ok(worker.includes('buildAutomaticExitPlanInput'));
  assert.ok(worker.includes('readMarketMark'));
  assert.ok(worker.includes('paperExitOrders'));
  assert.ok(worker.includes('liveExitOrders'));
  assert.ok(worker.includes('evaluateStrategyRulePackDeterministicGate'));
  assert.ok(worker.includes('tradeRulePackAiReviewer'));
  assert.ok(worker.includes('AI_REVIEW_DECISION:'));
  assert.ok(aiGate.includes('STRATEGY_RULE_PACK_AI_REVIEW_REQUIRED'));
  assert.ok(aiGate.includes('STRATEGY_RULE_PACK_AI_EVIDENCE_DIGEST_MISMATCH'));
  assert.ok(aiGate.includes('STRATEGY_RULE_PACK_AI_REVIEW_STALE'));
  assert.ok(aiGate.includes('STRATEGY_RULE_PACK_AI_SAFETY_INVALID'));
  assert.ok(aiProducer.includes("producer: 'AI_CHAT_PROVIDER_SEAM'"));
  assert.ok(aiProducer.includes("executionAuthority: 'NONE'"));
  assert.ok(aiProducer.includes('riskOverrideAllowed: false'));
  assert.ok(aiProducer.includes('AI_REVIEW_PROVIDER_NOT_CONFIGURED'));
  assert.ok(boundedAi.includes('bounded public-evidence classifier'));
  assert.ok(boundedAi.includes("Never override deterministic risk"));
  assert.ok(boundedAi.includes("fallbackUsed: true"));
  assert.ok(scannerAi.includes("canonicalScannerWired: true"));
  assert.ok(scannerAi.includes("executionAuthority: 'NONE'"));
  assert.ok(scannerAi.includes('vetoBlocksStrongSignal: true'));
  assert.ok(scannerAi.includes('DEFAULT_MAX_CANDIDATES = 2'));
  assert.ok(scannerAi.includes('enforceScannerAiFinalPromotionPolicy'));
  assert.ok(scannerAi.includes("card.aiValidation?.status === 'PASS'"));
  assert.ok(stockScanner.includes('enrichTopScannerCandidatesWithAi'));
  assert.ok(stockScanner.includes('enforceScannerAiFinalPromotionPolicy'));
  assert.ok(cryptoScanner.includes('enrichTopScannerCandidatesWithAi'));
  const stockNewsIndex = stockScanner.indexOf('enrichStockScannerCardsWithNewsDisclosureIntelligence');
  const stockAiIndex = stockScanner.indexOf('enrichTopScannerCandidatesWithAi');
  const stockFinalRankIndex = stockScanner.lastIndexOf('rankScannerCandidates');
  assert.ok(stockNewsIndex >= 0 && stockAiIndex > stockNewsIndex && stockFinalRankIndex > stockAiIndex);
  const cryptoMarketIndex = cryptoScanner.indexOf('enrichScannerCardsWithMarketIntelligence');
  const cryptoEventIndex = cryptoScanner.indexOf('enrichCryptoScannerCardsWithPublicEventContext');
  const cryptoAiIndex = cryptoScanner.indexOf('enrichTopScannerCandidatesWithAi');
  const cryptoFinalRankIndex = cryptoScanner.lastIndexOf('rankScannerCandidates');
  assert.ok(
    cryptoMarketIndex >= 0
      && cryptoEventIndex > cryptoMarketIndex
      && cryptoAiIndex > cryptoEventIndex
      && cryptoFinalRankIndex > cryptoAiIndex,
  );
});

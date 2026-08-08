import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichScannerMarketAction } from './scanner-market-action.service';
import { applyScannerApprovalSafety } from './scanner-market-approval-safety.service';
import type { ScannerSignalCard } from './scanner-signal.types';

const OBSERVED_AT = '2026-08-05T00:00:00.000Z';
const EXPIRES_AT = '2026-08-07T00:00:00.000Z';
const NOW = Date.parse('2026-08-05T01:00:00.000Z');

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: 'signal:test', assetClass: 'stock', market: 'KR', exchange: 'KRX',
    symbol: '005930', name: '삼성전자', currency: 'KRW', assetType: 'STOCK',
    listingStatus: 'LISTED', price: 100, changePercent: 1, direction: 'LONG',
    signalState: 'DETECTED', score: 85, confidence: 82, dataCompleteness: 92,
    riskScore: 20, riskLevel: 'LOW', liquidity: 10_000_000_000, volume: 100_000,
    tradingValue: 10_000_000_000, spreadPercent: null, volatilityPercent: 2,
    matched: ['거래량 증가'], notMatched: [], unverified: [],
    evidence: [{ key: 'volume', label: '거래량', status: 'matched', source: 'test', observedAt: OBSERVED_AT, reasons: ['실데이터 확인'] }],
    pricePlan: { entryZone: { from: 99, to: 100 }, invalidation: 95, stopLoss: 95, targets: [108, 112], riskReward: 1.6 },
    dataState: 'complete', dataSources: ['test'], observedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT, strongSignalEligible: true, warnings: [], ...overrides,
  };
}

function cryptoEvidence(includeFunding: boolean): ScannerSignalCard['evidence'] {
  const rows: ScannerSignalCard['evidence'] = [
    { key: 'volume', label: '거래량', status: 'matched', source: 'test', observedAt: OBSERVED_AT, reasons: ['거래량'] },
    { key: 'liquidity', label: '유동성', status: 'matched', source: 'test', observedAt: OBSERVED_AT, reasons: ['유동성'] },
    { key: 'spread', label: '스프레드', status: 'matched', source: 'test', observedAt: OBSERVED_AT, reasons: ['스프레드'] },
    { key: 'risk', label: '위험', status: 'matched', source: 'test', observedAt: OBSERVED_AT, reasons: ['위험'] },
  ];
  if (includeFunding) rows.push({ key: 'funding-open-interest', label: '펀딩비·미결제약정', status: 'matched', source: 'test', observedAt: OBSERVED_AT, reasons: ['펀딩비와 OI 확인'] });
  return rows;
}

function safe(input: ScannerSignalCard): ScannerSignalCard {
  return applyScannerApprovalSafety(enrichScannerMarketAction(input), NOW);
}

test('approval fails closed for partial stale insufficient and expired data', () => {
  for (const dataState of ['partial', 'stale', 'insufficient'] as const) {
    const result = safe(card({ dataState }));
    assert.equal(result.marketApprovalEligible, false);
    assert.match(result.warnings.join(' '), /승인 불가/);
  }
  const expired = safe(card({ expiresAt: '2026-08-05T00:30:00.000Z' }));
  assert.equal(expired.marketApprovalEligible, false);
  assert.match(expired.warnings.join(' '), /만료/);
});

test('futures requires fresh funding and open-interest evidence', () => {
  const base = card({
    assetClass: 'coin_futures', market: 'BITGET_USDT_FUTURES', exchange: 'BITGET',
    assetType: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', currency: 'USDT', direction: 'LONG',
    score: 84, confidence: 82, dataCompleteness: 95, riskScore: 20,
    spreadPercent: 0.08, volatilityPercent: 3, evidence: cryptoEvidence(false),
  });
  assert.equal(safe(base).marketApprovalEligible, false);
  const staleEvidence = cryptoEvidence(true).map((item) => item.key === 'funding-open-interest' ? { ...item, observedAt: null } : item);
  assert.equal(safe({ ...base, evidence: staleEvidence }).marketApprovalEligible, false);
  assert.equal(safe({ ...base, evidence: cryptoEvidence(true) }).marketApprovalEligible, true);
});

test('cash SELL is reduce-only and requires a server-verified holding', () => {
  const result = safe(card({
    matched: ['RSI 과열'],
    evidence: [{ key: 'rsi_overheat', label: 'RSI 과열', status: 'matched', source: 'test', observedAt: OBSERVED_AT, reasons: ['과열'] }],
  }));
  assert.equal(result.action, 'SELL');
  assert.equal(result.executionIntent, 'REDUCE_OR_EXIT');
  assert.equal(result.requiresExistingPosition, true);
  assert.match(result.warnings.join(' '), /보유 수량을 재검증/);
});

test('chase risk and unvalidated initial policy are explicit', () => {
  const result = safe(card({ changePercent: 9 }));
  assert.equal(result.chaseRisk, 'ELEVATED');
  assert.equal(result.marketApprovalEligible, false);
  assert.equal(result.approvalPolicyStatus, 'UNVALIDATED_INITIAL_POLICY');
  assert.match(result.warnings.join(' '), /백테스트 검증 전/);
  assert.match(result.warnings.join(' '), /보장하지 않습니다/);
});

import assert from 'node:assert/strict';
import {
  assertSignalIntelligenceV3Snapshot,
  runSignalIntelligenceV3,
  SIGNAL_INTELLIGENCE_V3_POLICY,
} from '../src/engine.mjs';
import { toCanonicalTelegramAlert } from '../src/telegram-events.mjs';

const common = {
  strategy: 'SWING',
  timeframe: '1h',
  dataStatus: 'READY',
  quantEligible: true,
  profitEligible: true,
  riskReady: true,
  evidence: {
    expectedNetEdgeR: 1.4,
    tailLossPenaltyR: 0.2,
    uncertaintyPenaltyR: 0.1,
    executionPenaltyR: 0.1,
  },
};

const futuresRisk = {
  stopDistancePct: 2,
  maeQ95Pct: 2.2,
  downsideIntervalPct: 2.5,
  spreadPct: 0.05,
  slippagePct: 0.10,
  uncertainty: 'LOW',
  volatility: 'NORMAL',
  liquidity: 'HIGH',
  tiers: [
    { leverage: 1, liquidationDistancePct: 60, maintenanceMarginRatePct: 0.4, verified: true },
    { leverage: 2, liquidationDistancePct: 32, maintenanceMarginRatePct: 0.5, verified: true },
    { leverage: 3, liquidationDistancePct: 20, maintenanceMarginRatePct: 0.6, verified: true },
  ],
};

const snapshot = runSignalIntelligenceV3([
  { ...common, market: 'KR_STOCK', symbol: '005930', direction: 'BUY', timeframe: '1D' },
  { ...common, market: 'US_STOCK', symbol: 'AAPL', direction: 'BUY', timeframe: '1D' },
  { ...common, market: 'CRYPTO_SPOT', symbol: 'KRW-BTC', direction: 'BUY' },
  { ...common, market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', direction: 'LONG', leverageEvidence: futuresRisk },
  {
    ...common,
    market: 'CRYPTO_FUTURES',
    symbol: 'ETHUSDT',
    direction: 'SHORT',
    leverageEvidence: futuresRisk,
    ai: { catalyst: { signal: 'NEGATIVE', impact: 'HIGH' } },
  },
]);

assertSignalIntelligenceV3Snapshot(snapshot);
assert.equal(snapshot.safety.executionAuthority, 'NONE');
assert.equal(snapshot.safety.privateTradingApiAllowed, false);
assert.equal(snapshot.safety.realOrderAllowed, false);
assert.equal(snapshot.safety.aiCanPromoteCandidate, false);
assert.equal(snapshot.safety.aiCanIncreaseLeverage, false);
assert.equal(snapshot.lists.krBuy.length, 1);
assert.equal(snapshot.lists.usBuy.length, 1);
assert.equal(snapshot.lists.spotBuy.length, 1);
assert.equal(snapshot.lists.futuresLong.length, 1);
assert.equal(snapshot.lists.futuresShort.length, 1);
assert.equal(snapshot.events.some((event) => event.type === 'RESCAN_REQUESTED' && event.symbol === 'ETHUSDT'), true);

const longEvent = snapshot.events.find((event) => event.type === 'NEW_CANDIDATE' && event.direction === 'LONG');
const telegram = toCanonicalTelegramAlert(longEvent, (room) => room === 'CRYPTO_ROOM' ? 'test-crypto-room' : 'test-stock-room');
assert.equal(telegram.type, 'crypto_futures_long');
assert.equal(telegram.destinationChatId, 'test-crypto-room');

console.log(JSON.stringify({
  ok: true,
  policyVersion: SIGNAL_INTELLIGENCE_V3_POLICY.version,
  lists: Object.fromEntries(Object.entries(snapshot.lists).map(([key, rows]) => [key, rows.length])),
  eventCount: snapshot.events.length,
  safety: snapshot.safety,
}, null, 2));

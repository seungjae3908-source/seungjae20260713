import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRulePackPilotCapitalFromTrades } from './trade-rule-pack-pilot-capital.service';

test('50/50 HWM split compounds only new realized highs and does not split drawdown recovery twice', () => {
  const state = deriveRulePackPilotCapitalFromTrades([
    { id: 't1', symbol: 'BTC', signalId: 's1', closedAt: '2026-10-03T01:00:00.000Z', netPnlKrw: 50_000 },
    { id: 't2', symbol: 'BTC', signalId: 's2', closedAt: '2026-10-03T02:00:00.000Z', netPnlKrw: -20_000 },
    { id: 't3', symbol: 'ETH', signalId: 's3', closedAt: '2026-10-03T03:00:00.000Z', netPnlKrw: 20_000 },
    { id: 't4', symbol: 'ETH', signalId: 's4', closedAt: '2026-10-03T04:00:00.000Z', netPnlKrw: 10_000 },
  ], new Date('2026-10-03T05:00:00.000Z'));
  assert.equal(state.operatingCapitalKrw, 530_000);
  assert.equal(state.reserveKrw, 30_000);
  assert.equal(state.highWaterMarkKrw, 560_000);
  assert.equal(state.maxEntryKrw, 530_000);
  assert.equal(state.compoundedProfitKrw, 30_000);
  assert.equal(state.realizedNetPnlKrw, 60_000);
  assert.equal(state.reserveWithdrawalAutomatic, false);
});

test('initial max entry is 500k and realized losses reduce operating capital and entry ceiling', () => {
  const initial = deriveRulePackPilotCapitalFromTrades([], new Date('2026-10-03T00:00:00.000Z'));
  assert.equal(initial.operatingCapitalKrw, 500_000);
  assert.equal(initial.maxEntryKrw, 500_000);
  const loss = deriveRulePackPilotCapitalFromTrades([
    { id: 'loss', symbol: 'BTC', signalId: 's-loss', closedAt: '2026-10-03T01:00:00.000Z', netPnlKrw: -25_000 },
  ], new Date('2026-10-03T02:00:00.000Z'));
  assert.equal(loss.operatingCapitalKrw, 475_000);
  assert.equal(loss.reserveKrw, 0);
  assert.equal(loss.maxEntryKrw, 475_000);
});

test('daily five-loss count and latest same-symbol loss are deterministic', () => {
  const trades = Array.from({ length: 5 }, (_, index) => ({
    id: 'l' + index, symbol: index === 4 ? 'BTC' : 'ETH', signalId: 'signal-' + index,
    closedAt: '2026-10-03T0' + (index + 1) + ':00:00.000Z', netPnlKrw: -1_000,
  }));
  const state = deriveRulePackPilotCapitalFromTrades(trades, new Date('2026-10-03T10:00:00.000Z'));
  assert.equal(state.dailyLosingTrades, 5);
  assert.equal(state.consecutiveLosses, 5);
  assert.equal(state.latestLossBySymbol.BTC?.signalId, 'signal-4');
});
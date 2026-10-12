import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalAccountSnapshot, CanonicalPosition } from '../features/account-readonly/account-readonly.contract';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import type { MemberAutoTradingMarketMark } from './member-auto-trading-market-mark.service';
import { automaticLiveUnrealizedPnlKrw } from './automatic-live-unrealized-risk.service';

const owned = [
  { remainingQuantity: 1, plan: { exchange: 'upbit', symbol: 'KRW-ETH', market: 'KRW', side: 'buy' } as TradingPlan },
  { remainingQuantity: 1, plan: { exchange: 'bitget', symbol: 'BTCUSDT', market: 'USDT', side: 'long', leverage: 2 } as TradingPlan },
  { remainingQuantity: 1, plan: { exchange: 'toss', symbol: '005930', market: 'KR', side: 'buy' } as TradingPlan },
  { remainingQuantity: 1, plan: { exchange: 'kiwoom', symbol: 'AAPL', market: 'US', side: 'buy' } as TradingPlan },
];
function snapshots(): CanonicalAccountSnapshot[] {
  const position = (symbol: string, pnl: number | null, extra = {}) => ({ symbol, market: 'USDT',
    quantity: 1, availableQuantity: 1, unrealizedPnl: pnl, side: 'long', marginMode: 'isolated', leverage: 2, ...extra } as CanonicalPosition);
  return [
    { provider: 'upbit', connected: true, status: 'CONNECTED', stale: false, errorCode: null, openOrders: [],
      positions: [position('ETH', -50_000), position('BTC', null)] } as unknown as CanonicalAccountSnapshot,
    { provider: 'bitget', connected: true, status: 'CONNECTED', stale: false, errorCode: null, openOrders: [],
      positionMode: 'one_way_mode', positions: [position('BTCUSDT', -100)] } as unknown as CanonicalAccountSnapshot,
    { provider: 'toss', connected: true, status: 'CONNECTED', stale: false, errorCode: null, openOrders: [],
      positions: [position('005930', -15_000, { market: 'KR' })] } as unknown as CanonicalAccountSnapshot,
    { provider: 'kiwoom', connected: true, status: 'CONNECTED', stale: false, errorCode: null, openOrders: [],
      positions: [position('AAPL', -10, { market: 'US' })] } as unknown as CanonicalAccountSnapshot,
  ];
}
test('aggregates other-market AUTO losses instead of authorizing entry using only this provider', async () => {
  const data = snapshots(); const reads: string[] = [];
  const result = await automaticLiveUnrealizedPnlKrw({ owned, maximumLeverage: 7,
    snapshotFor: async (provider) => { reads.push(provider); return data.find((row) => row.provider === provider)!; },
    krwPerQuoteFor: async (plan) => ['bitget', 'kiwoom'].includes(plan.exchange) ? 1400 : 1 });
  assert.equal(result, -219_000);
  assert.deepEqual(reads.sort(), ['bitget', 'kiwoom', 'toss', 'upbit']);
  assert.ok(result / 4_000_000 * 100 < -3, 'account-wide loss must trip the 3% entry guard');
});
test('no AUTO-owned positions means no manual adoption or unnecessary provider read', async () => {
  let reads = 0;
  assert.equal(await automaticLiveUnrealizedPnlKrw({ owned: [], maximumLeverage: 7,
    snapshotFor: async () => { reads += 1; throw new Error('FORBIDDEN'); },
    krwPerQuoteFor: async () => { throw new Error('FORBIDDEN'); } }), 0);
  assert.equal(reads, 0);
});
test('unknown AUTO PnL, missing other-provider evidence and invalid FX fail closed; manual unknown PnL is excluded', async () => {
  for (const failure of ['pnl', 'provider', 'fx']) {
    const data = snapshots();
    if (failure === 'pnl') data[0] = { ...data[0]!, positions: data[0]!.positions!.map((row, index) =>
      index === 0 ? { ...row, unrealizedPnl: null } : row) };
    await assert.rejects(automaticLiveUnrealizedPnlKrw({ owned, maximumLeverage: 7,
      snapshotFor: async (provider) => {
        if (failure === 'provider' && provider === 'bitget') throw new Error('READONLY_PROVIDER_TIMEOUT');
        return data.find((row) => row.provider === provider)!;
      }, krwPerQuoteFor: async () => failure === 'fx' ? Number.NaN : 1 }),
    /UNREALIZED_PNL_EVIDENCE_REQUIRED|READONLY_PROVIDER_TIMEOUT|PNL_FX_EVIDENCE_REQUIRED/u);
  }
});

const nowMs = Date.parse('2026-10-12T00:00:00Z');
function upbitInput() {
  const plan = { ...owned[0]!.plan, id: 'entry-eth', userId: 'owner' } as TradingPlan;
  const snapshot = { ...snapshots()[0]!, positions: snapshots()[0]!.positions!.map((row, index) =>
    index === 0 ? { ...row, unrealizedPnl: null, averageEntryPrice: 1 } : row) };
  return { owned: [{ plan, remainingQuantity: 1 }], maximumLeverage: 7, nowMs,
    snapshotFor: async () => snapshot, krwPerQuoteFor: async () => 1,
    orders: [{ id: 'filled', planId: plan.id, userId: 'owner', exchange: 'upbit', state: 'FILLED',
      filledQuantity: 2, averageFillPrice: 100_000, feeAmount: 100, feeCurrency: 'KRW' } as TradingOrder],
    readMark: async () => ({ market: 'CRYPTO_SPOT', symbol: 'KRW-ETH', price: 90_000,
      observedAt: new Date(nowMs - 1_000).toISOString(), source: 'UPBIT_PUBLIC_TICKER' } as MemberAutoTradingMarketMark) };
}
test('Upbit missing account PnL uses fresh actual price, canonical fill cost and remaining paid fee, not manual average', async () => {
  assert.equal(await automaticLiveUnrealizedPnlKrw(upbitInput()), -10_050);
  const input = upbitInput();
  input.orders[0] = { ...input.orders[0]!, feeAmount: null, feeCurrency: null,
    fills: [{ id: 'fill', quantity: 2, price: 100_000, feeAmount: 100, feeCurrency: 'KRW', filledAt: new Date(nowMs).toISOString() }] };
  assert.equal(await automaticLiveUnrealizedPnlKrw(input), -10_050);
});
test('Upbit cannot invent unknown costs or fees or accept stale, future or another instrument mark', async () => {
  for (const failure of ['missing', 'basis', 'owner', 'fee', 'feeCurrency', 'fillQuantity', 'fillAverage', 'stale', 'future', 'symbol', 'market', 'price', 'source']) {
    const input = upbitInput();
    if (failure === 'missing') input.orders = [];
    if (failure === 'basis') input.orders[0]!.averageFillPrice = null;
    if (failure === 'owner') input.orders[0]!.userId = 'other-member';
    if (failure === 'fee') input.orders[0]!.feeAmount = null;
    if (failure === 'feeCurrency') input.orders[0]!.feeCurrency = 'ETH';
    if (failure.startsWith('fill')) input.orders[0] = { ...input.orders[0]!, feeAmount: null, fills: [{
      id: 'fill', quantity: failure === 'fillQuantity' ? 1 : 2, price: failure === 'fillAverage' ? 1 : 100_000,
      feeAmount: 100, feeCurrency: 'KRW', filledAt: new Date(nowMs).toISOString() }] };
    const read = input.readMark;
    input.readMark = async () => ({ ...await read(),
      ...(failure === 'stale' ? { observedAt: new Date(nowMs - 30_001).toISOString() } : {}),
      ...(failure === 'future' ? { observedAt: new Date(nowMs + 5_001).toISOString() } : {}),
      ...(failure === 'symbol' ? { symbol: 'KRW-BTC' } : {}),
      ...(failure === 'market' ? { market: 'CRYPTO_FUTURES' as const } : {}),
      ...(failure === 'price' ? { price: Number.NaN } : {}),
      ...(failure === 'source' ? { source: '' } : {}),
    });
    await assert.rejects(automaticLiveUnrealizedPnlKrw(input), /PNL_(COST_BASIS|FEE|MARK)_EVIDENCE_REQUIRED/u, failure);
  }
});

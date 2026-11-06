import { StatArbHedgeAdapter } from './stat-arb-hedge-adapter';
import {
  InMemoryHedgePairStore, MockExchange, RecordingAlertPort, StaticConflictPort, StaticControlPort, StaticLedgerPort, VirtualClock,
} from './stat-arb-hedge-mock';
import { STAT_ARB_HEDGE_SIGNAL_SCHEMA, type HedgeAdapterConfig, type HedgeSignal, type PerformanceEvidence } from './stat-arb-hedge.types';

export const USER = 'user-hedge-1';
export const SHA = 'f476c30c8a1b2c3d4e5f60718293a4b5c6d7e8f9';
export const FX = 1_380;
export const SPOT_PX = 138_000_000; // KRW
export const PERP_PX = 100_000; // USDT (138,000,000 / 1,380)
export const QTY = 0.003;

export function makeSignal(clock: VirtualClock, overrides: Partial<HedgeSignal> = {}, legOverrides: { spot?: Partial<HedgeSignal['legs'][0]>; perp?: Partial<HedgeSignal['legs'][0]> } = {}): HedgeSignal {
  const now = clock.nowMs();
  const action = overrides.action ?? 'ENTER';
  const spot = {
    legId: 'spot', role: 'SPOT' as const, venue: 'upbit' as const, product: 'spot' as const, symbol: 'KRW-BTC',
    side: action === 'ENTER' ? 'buy' as const : 'sell' as const, quantity: QTY, priceType: 'market' as const, referencePrice: SPOT_PX, quoteCurrency: 'KRW' as const,
    ...legOverrides.spot,
  };
  const perp = {
    legId: 'perp', role: 'PERP' as const, venue: 'bitget' as const, product: 'usdt_perp' as const, symbol: 'BTCUSDT',
    side: action === 'ENTER' ? 'short' as const : 'long' as const, quantity: QTY, priceType: 'market' as const, referencePrice: PERP_PX, quoteCurrency: 'USDT' as const,
    ...legOverrides.perp,
  };
  return {
    schema: STAT_ARB_HEDGE_SIGNAL_SCHEMA, strategyId: 'carry', strategyVersion: '1.0.0', parameterHash: 'p-abc', researchCodeSha: SHA,
    signalId: 'sig-1', signalAtMs: now - 1_000, dataAsOfMs: now - 2_000, maxDataAgeMs: 60_000, expiresAtMs: now + 120_000,
    action, legs: [spot, perp], fx: { krwPerUsdt: FX, asOfMs: now - 500, source: 'test' }, leverage: 3, marginMode: 'isolated',
    ...overrides,
  };
}

export function passingEvidence(overrides: Partial<PerformanceEvidence['rows'][0]> = {}): PerformanceEvidence {
  return {
    researchCodeSha: SHA, generatedAtMs: 1_700_000_000_000,
    rows: [{
      window: 'readme_test', strategy: 'carry', cost_profile: 'current_public_assumed', leverage: 3, status: 'OK', data_verdict: 'OK',
      window_start: '2023-07-01', window_end_exclusive: '2025-01-01', net_return: 0.05, trades: 40, liquidations: 0, pf_net: 1.4, mdd: -0.02,
      ...overrides,
    }],
  };
}

export function makeHarness(config: Partial<HedgeAdapterConfig> = {}) {
  const clock = new VirtualClock();
  const upbit = new MockExchange('upbit', { minQuantity: 0, quantityStep: 1e-8, priceStep: 1000, minNotional: 5_000, tradable: true }, clock);
  const bitget = new MockExchange('bitget', { minQuantity: 0.001, quantityStep: 0.001, priceStep: 0.1, minNotional: 5, tradable: true }, clock);
  upbit.available = { KRW: 3_000_000, USDT: 0 };
  bitget.available = { KRW: 0, USDT: 2_000 };
  const store = new InMemoryHedgePairStore();
  const control = new StaticControlPort({
    emergencyStopped: false, newEntriesStopped: false,
    canPlaceOrders: { upbit: true, bitget: true, binance: false, hyperliquid: false },
    canCancelOrders: { upbit: true, bitget: true, binance: false, hyperliquid: false },
    policyBitgetLeverage: 3, roleCapKrw: 500_000, policyMaxOrderKrw: 500_000,
  });
  const ledger = new StaticLedgerPort(
    { allocatedKrw: 3_000_000, openOrderReservedKrw: 0, positionMarginKrw: 0, realizedPnlKrw: 0, costsKrw: 0, exchangeAvailableKrw: null },
    { allocatedKrw: 2_760_000, openOrderReservedKrw: 0, positionMarginKrw: 0, realizedPnlKrw: 0, costsKrw: 0, exchangeAvailableKrw: null },
  );
  const conflicts = new StaticConflictPort();
  const alerts = new RecordingAlertPort();
  const adapter = new StatArbHedgeAdapter(
    { userId: USER, executionAuthority: 'MOCK', legFillTimeoutMs: 5_000, pollIntervalMs: 1_000, ...config },
    { exchanges: { upbit, bitget }, store, control, ledger, conflicts, alerts, clock },
  );
  return { clock, upbit, bitget, store, control, ledger, conflicts, alerts, adapter };
}

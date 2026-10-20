import test from 'node:test';
import assert from 'node:assert/strict';
import { tradingIdempotencyKey } from '../trade-automation.service';
import { finalAllowedEntryKrw, projectMarketLedger, MARKET_LEDGER_DEFAULT_DRIFT_TOLERANCE_KRW } from '../trade-automation-risk.service';
import { upbitKrwAmountString, upbitVolumeString, validateBitgetContractRules } from '../trade-exchange-adapters.service';
import { killSwitchReasons, killSwitchScope } from '../trade-kill-switch.service';
import { hedgeLegToTradingPlanInput } from './stat-arb-hedge-bridge';
import { PERP_PX, QTY, SPOT_PX, USER, makeHarness, makeSignal, passingEvidence } from './stat-arb-hedge-test-fixtures';

/** Bitget `/api/v2/mix/market/contracts` shape for BTCUSDT as the existing adapter reads it. */
const BTCUSDT_CONTRACT = { minTradeNum: '0.001', sizeMultiplier: '0.001', pricePlace: '1', priceEndStep: '1', maxOrderQty: '1000', maxMarketOrderQty: '500', minTradeUSDT: '5', symbolStatus: 'normal' };

async function hedgedPair() {
  const h = makeHarness();
  h.upbit.queue({ kind: 'fill', price: SPOT_PX });
  h.bitget.queue({ kind: 'fill', price: PERP_PX });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.accepted, true, r.blockCodes.join(','));
  return { h, pair: r.pair! };
}

test('hedge perp leg passes the existing Bitget contract validator and fails it on a bad step/notional exactly like the single-leg path', async () => {
  const { pair } = await hedgedPair();
  const plan = hedgeLegToTradingPlanInput(pair, pair.legs.PERP, 'mock');
  assert.equal(plan.exchange, 'bitget');
  assert.equal(plan.side, 'short');
  assert.equal(plan.marginMode, 'isolated');
  assert.equal(plan.leverage, 3);
  assert.doesNotThrow(() => validateBitgetContractRules(plan, BTCUSDT_CONTRACT, PERP_PX));
  assert.throws(() => validateBitgetContractRules({ ...plan, quantity: 0.0015 }, BTCUSDT_CONTRACT, PERP_PX), /BITGET_QUANTITY_STEP/u);
  assert.throws(() => validateBitgetContractRules({ ...plan, quantity: 0.001 }, BTCUSDT_CONTRACT, 4_000), /BITGET_MINIMUM_NOTIONAL/u);
  assert.throws(() => validateBitgetContractRules(plan, { ...BTCUSDT_CONTRACT, symbolStatus: 'maintain' }, PERP_PX), /BITGET_CONTRACT_NOT_TRADABLE/u);
});

test('hedge spot leg formats through the existing Upbit amount/volume helpers (round down, 8 decimals, whole KRW)', async () => {
  const { pair } = await hedgedPair();
  const buy = hedgeLegToTradingPlanInput(pair, pair.legs.SPOT, 'mock');
  assert.equal(buy.exchange, 'upbit');
  assert.equal(buy.market, 'crypto_spot');
  assert.equal(buy.leverage, null);
  assert.equal(upbitKrwAmountString(buy.quoteAmount), String(Math.floor(QTY * SPOT_PX)));
  assert.equal(upbitVolumeString(buy.quantity), '0.003');
  assert.equal(upbitVolumeString(0.0015000000049), '0.0015');
  assert.throws(() => upbitVolumeString(0), /UPBIT_ORDER_VOLUME_INVALID/u);
});

test('bridged legs get distinct existing-path idempotency keys and never collide with the sah- client ids', async () => {
  const { pair } = await hedgedPair();
  const spotKey = tradingIdempotencyKey(USER, hedgeLegToTradingPlanInput(pair, pair.legs.SPOT, 'mock'));
  const perpKey = tradingIdempotencyKey(USER, hedgeLegToTradingPlanInput(pair, pair.legs.PERP, 'mock'));
  assert.notEqual(spotKey, perpKey);
  assert.equal(tradingIdempotencyKey(USER, hedgeLegToTradingPlanInput(pair, pair.legs.SPOT, 'mock')), spotKey);
  assert.ok(pair.legs.SPOT.clientOrderId.startsWith('sah-'));
  assert.ok(!pair.legs.SPOT.clientOrderId.startsWith('sj-'));
});

test('an unknown hedge order state maps to the existing GLOBAL kill-switch scope', () => {
  const reasons = killSwitchReasons(['ORDER_STATE_UNKNOWN', 'HEDGE_UNBALANCED']);
  assert.deepEqual(reasons, ['ORDER_STATE_UNKNOWN']);
  assert.equal(killSwitchScope(reasons, { accountMode: 'live', reduceOnly: false, exchange: 'bitget', side: 'short' }), 'GLOBAL');
  assert.equal(killSwitchScope(killSwitchReasons(['RECOVERY_RECONCILIATION_FAILED'])), 'GLOBAL');
});

test('the adapter uses the shared ledger projection: drift beyond the tolerance blocks, within it passes', async () => {
  const within = makeHarness();
  within.upbit.available.KRW = 3_000_000 - MARKET_LEDGER_DEFAULT_DRIFT_TOLERANCE_KRW + 1;
  within.upbit.queue({ kind: 'fill', price: SPOT_PX });
  within.bitget.queue({ kind: 'fill', price: PERP_PX });
  const ok = await within.adapter.enter(makeSignal(within.clock), passingEvidence());
  assert.equal(ok.accepted, true, ok.blockCodes.join(','));
  const beyond = makeHarness();
  beyond.upbit.available.KRW = 3_000_000 - MARKET_LEDGER_DEFAULT_DRIFT_TOLERANCE_KRW - 1;
  const blocked = await beyond.adapter.enter(makeSignal(beyond.clock), passingEvidence());
  assert.ok(blocked.blockCodes.includes('MARKET_LEDGER_EXCHANGE_DRIFT_UNRESOLVED:crypto_spot'));
  const projection = projectMarketLedger({ market: 'crypto_spot', allocatedKrw: 3_000_000, openOrderReservedKrw: 0, positionMarginKrw: 0, realizedPnlKrw: 0, costsKrw: 0, exchangeAvailableKrw: beyond.upbit.available.KRW });
  assert.equal(projection.driftStatus, 'DRIFT_UNRESOLVED');
  const allowed = finalAllowedEntryKrw({ roleCapKrw: 500_000, policyMaxOrderKrw: 500_000, marketAllocatedKrw: 3_000_000, ledgerAvailableKrw: projection.availableKrw, exchangeAvailableKrw: projection.exchangeAvailableKrw, exchangeMinimumKrw: 5_000, exchangeMaximumKrw: null });
  assert.equal(allowed.bindingLimit, 'ROLE_CAP');
});

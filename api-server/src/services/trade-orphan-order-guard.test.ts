import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoOrphanExchangeOrders } from './trade-orphan-order-guard.service';
import type { TradingOrder, TradingOrderState } from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function order(state: TradingOrderState, overrides: Partial<TradingOrder> = {}): TradingOrder {
  return {
    id: `order-${state}`,
    userId: USER_ID,
    planId: `plan-${state}`,
    exchange: 'upbit',
    clientOrderId: `client-${state}`,
    exchangeOrderId: `exchange-${state}`,
    state,
    version: 1,
    requestedQuantity: 1,
    remainingQuantity: 1,
    filledQuantity: 0,
    averageFillPrice: null,
    fills: [],
    retryCount: 0,
    lastErrorCode: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

test('known active local order owns matching exchange pending order', () => {
  assert.doesNotThrow(() => assertNoOrphanExchangeOrders('upbit', [
    { clientOrderId: 'client-ACCEPTED', exchangeOrderId: 'different-provider-id' },
  ], [order('ACCEPTED')]));
});

test('exchange id can recover ownership when provider omits client order id', () => {
  assert.doesNotThrow(() => assertNoOrphanExchangeOrders('bitget', [
    { clientOrderId: null, exchangeOrderId: 'exchange-PARTIALLY_FILLED' },
  ], [order('PARTIALLY_FILLED', { exchange: 'bitget' })]));
});

test('unmatched pending exchange order fails closed as orphan', () => {
  assert.throws(() => assertNoOrphanExchangeOrders('upbit', [
    { clientOrderId: 'external-client', exchangeOrderId: 'external-exchange' },
  ], [order('ACCEPTED')]), /ORPHAN_EXCHANGE_ORDER_DETECTED/);
});

test('pending exchange order without stable identity fails closed', () => {
  assert.throws(() => assertNoOrphanExchangeOrders('bitget', [
    { clientOrderId: null, exchangeOrderId: null },
  ], []), /EXCHANGE_PENDING_ORDER_IDENTITY_UNKNOWN/);
});

test('terminal local order cannot legitimize an exchange pending order', () => {
  assert.throws(() => assertNoOrphanExchangeOrders('upbit', [
    { clientOrderId: 'client-FILLED', exchangeOrderId: 'exchange-FILLED' },
  ], [order('FILLED')]), /ORPHAN_EXCHANGE_ORDER_DETECTED/);
});

test('SUBMITTED order only owns exchange state after submission intent was persisted', () => {
  const submitted = order('SUBMITTED', { submissionStartedAt: null });
  assert.throws(() => assertNoOrphanExchangeOrders('upbit', [
    { clientOrderId: submitted.clientOrderId, exchangeOrderId: submitted.exchangeOrderId },
  ], [submitted]), /ORPHAN_EXCHANGE_ORDER_DETECTED/);

  assert.doesNotThrow(() => assertNoOrphanExchangeOrders('upbit', [
    { clientOrderId: submitted.clientOrderId, exchangeOrderId: submitted.exchangeOrderId },
  ], [{ ...submitted, submissionStartedAt: '2026-08-19T00:00:01.000Z' }]));
});

test('orders from another exchange cannot legitimize a pending order', () => {
  assert.throws(() => assertNoOrphanExchangeOrders('bitget', [
    { clientOrderId: 'shared-client', exchangeOrderId: 'shared-exchange' },
  ], [order('ACCEPTED', {
    exchange: 'upbit',
    clientOrderId: 'shared-client',
    exchangeOrderId: 'shared-exchange',
  })]), /ORPHAN_EXCHANGE_ORDER_DETECTED/);
});

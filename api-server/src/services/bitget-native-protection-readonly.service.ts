import type { AutomaticLiveOwnedPosition } from './automatic-live-position-isolation.service';
import type { TradingOrder } from './trade-automation.types';
import { readBoundedTradingProviderJson } from './trading-provider-response.service';
import { prepareBitgetSinglePosition, prepareBitgetPendingProtection,
  type BitgetCredentials, type PreparedExchangeRequest } from './trade-exchange-adapters.service';
import { tradingProviderHttpErrorCode, tradingProviderNetworkErrorCode, tradingProviderTimeoutCode } from './trade-provider-http-error.service';

type Row = Record<string, unknown>;
const record = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,39}$/u.test(v);
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v
  : typeof v === 'string' && /^\d+(?:\.\d+)?$/u.test(v) ? Number(v) : Number.NaN;
const equal = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b)
  && Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-10;
function fail(code: string): never { throw new Error(code); }
function data(payload: unknown, nowMs: number): unknown {
  if (!record(payload) || payload.code !== '00000') {
    fail(record(payload) && typeof payload.code === 'string' && /^\d{5}$/u.test(payload.code)
      ? `BITGET_NATIVE_PROTECTION_QUERY_${payload.code}` : 'BITGET_NATIVE_PROTECTION_QUERY_FAILED');
  }
  const at = number(payload.requestTime);
  if (!Number.isFinite(at) || at <= 0 || at > nowMs + 5_000 || nowMs - at > 30_000) {
    fail('BITGET_NATIVE_PROTECTION_RESPONSE_NOT_FRESH');
  }
  return payload.data;
}

/** Fixed-host, fixed-path GET transport. No redirect, mutation, retry or raw
 * response/signature logging. A timeout/unknown response stays unproven. */
export async function sendBitgetNativeProtectionReadonly(request: PreparedExchangeRequest): Promise<unknown> {
  if (request.method !== 'GET' || request.body !== null || ![
    '/api/v2/mix/position/single-position', '/api/v2/mix/order/orders-plan-pending',
  ].includes(request.path) || !request.query.startsWith('?') || request.query.includes('#')) {
    fail('BITGET_NATIVE_PROTECTION_READONLY_CONTRACT_REQUIRED');
  }
  const base = 'https://api.bitget.com';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${base}${request.path}${request.query}`, {
      method: 'GET', body: null, headers: request.headers, redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) fail(tradingProviderHttpErrorCode(base, response.status));
    return await readBoundedTradingProviderJson(response, { signal: controller.signal,
      invalidCode: 'BITGET_NATIVE_PROTECTION_RESPONSE_INVALID', boundCode: 'BITGET_NATIVE_PROTECTION_RESPONSE_BOUND_EXCEEDED' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') fail(tradingProviderTimeoutCode(base));
    if (error instanceof TypeError) fail(tradingProviderNetworkErrorCode(base));
    throw error;
  } finally { clearTimeout(timer); }
}

/** Current official Classic V2 contracts, never a mutation:
 * /docs/catalog/classic-contract-position/classic-contract-position
 * /docs/catalog/classic-contract-plan/classic-contract-plan
 * Require the exchange position's actual TP/SL IDs, then read each exact
 * pending order. Matching symbol/price alone must not adopt a manual order.
 * A disappeared position is NOT a fill or a zero-fee settlement certificate. */
export async function readAutomaticFuturesNativeProtection(input: {
  positions: readonly (AutomaticLiveOwnedPosition & { order: TradingOrder })[]; credentials: BitgetCredentials;
  send: (request: PreparedExchangeRequest) => Promise<unknown>; now: () => number;
}) {
  let reads = 0;
  const get = async (request: PreparedExchangeRequest) => {
    if (request.method !== 'GET' || request.body !== null || ![
      '/api/v2/mix/position/single-position', '/api/v2/mix/order/orders-plan-pending',
    ].includes(request.path)) fail('BITGET_NATIVE_PROTECTION_READONLY_CONTRACT_REQUIRED');
    reads += 1;
    return data(await input.send(request), input.now());
  };
  const proofs = [];
  const seen = new Set<string>();
  for (const owned of input.positions) {
    const plan = owned.plan;
    if (plan.exchange !== 'bitget') continue;
    const symbol = plan.symbol.toUpperCase();
    if (plan.accountMode !== 'live' || plan.reduceOnly || !['long', 'short'].includes(plan.side)
      || owned.order.userId !== plan.userId || owned.order.planId !== plan.id || owned.order.exchange !== 'bitget'
      || !['FILLED', 'PARTIALLY_FILLED'].includes(owned.order.state)
      || !Number.isFinite(owned.order.filledQuantity) || owned.order.filledQuantity < owned.remainingQuantity
      || !Number.isFinite(owned.remainingQuantity) || owned.remainingQuantity <= 0
      || seen.has(symbol)) fail('BITGET_NATIVE_PROTECTION_CANONICAL_OWNERSHIP_REQUIRED');
    seen.add(symbol);
    const raw = await get(prepareBitgetSinglePosition(input.credentials, symbol));
    if (!Array.isArray(raw) || raw.some((v) => !record(v))) fail('BITGET_NATIVE_PROTECTION_POSITION_RESPONSE_INVALID');
    const active = raw.filter((p: Row) => number(p.total) > 0);
    if (raw.some((p: Row) => !Number.isFinite(number(p.total)) || number(p.total) < 0)) {
      fail('BITGET_NATIVE_PROTECTION_POSITION_QUANTITY_UNKNOWN');
    }
    if (active.length === 0) fail('BITGET_NATIVE_CLOSE_RECONCILIATION_REQUIRED');
    if (active.length !== 1) fail('BITGET_NATIVE_PROTECTION_OPPOSITE_OR_DUPLICATE_POSITION');
    const position = active[0] as Row;
    const target = plan.targetPrices.at(-1);
    if (String(position.symbol).toUpperCase() !== symbol || position.marginCoin !== 'USDT'
      || position.holdSide !== plan.side || position.posMode !== 'one_way_mode'
      || position.marginMode !== 'isolated' || !equal(number(position.total), owned.remainingQuantity)
      || number(position.leverage) !== plan.leverage || !Number.isInteger(plan.leverage)
      || Number(plan.leverage) < 2 || Number(plan.leverage) > 7) fail('BITGET_NATIVE_PROTECTION_POSITION_POLICY_MISMATCH');
    if (!equal(number(position.stopLoss), plan.stopPrice) || !equal(number(position.takeProfit), Number(target))
      || !id(position.stopLossId) || !id(position.takeProfitId)
      || position.stopLossId === position.takeProfitId) fail('BITGET_NATIVE_PROTECTION_POSITION_IDS_OR_PRICES_MISSING');
    const checkedAtMs = input.now();
    for (const [kind, orderId, price, allowedTypes] of [
      ['STOP_LOSS', position.stopLossId, plan.stopPrice, ['loss_plan', 'pos_loss']],
      ['TAKE_PROFIT', position.takeProfitId, target, ['profit_plan', 'pos_profit']],
    ] as const) {
      const rawPending = await get(prepareBitgetPendingProtection(input.credentials, symbol, orderId));
      if (!record(rawPending) || !Array.isArray(rawPending.entrustedList)
        || rawPending.entrustedList.some((v) => !record(v))) fail('BITGET_NATIVE_PROTECTION_PENDING_RESPONSE_INVALID');
      // This is an exact-ID query. Unexpected rows/continuation are not a
      // complete unique readback, even if the first row happens to match.
      const rows = rawPending.entrustedList;
    if (rows.length !== 1 || !['', null, undefined, orderId].includes(rawPending.endId as string | null | undefined)) {
      fail('BITGET_NATIVE_PROTECTION_EXACT_PENDING_ORDER_REQUIRED');
    }
      const row = rows[0] as Row;
      const isPositionPlan = row.planType === 'pos_loss' || row.planType === 'pos_profit';
      const size = number(row.size);
      if (row.orderId !== orderId || String(row.symbol).toUpperCase() !== symbol
        || !allowedTypes.some((t) => t === row.planType) || row.planStatus !== 'not_trigger'
        || typeof row.marginCoin !== 'string' || row.marginCoin.toUpperCase() !== 'USDT'
        || row.marginMode !== 'isolated' || row.posMode !== 'one_way_mode'
        || !equal(number(row.triggerPrice), Number(price))
        || !['mark_price', 'fill_price'].includes(String(row.triggerType))
        || (isPositionPlan ? !(row.size === '' || row.size === null || row.size === undefined || equal(size, owned.remainingQuantity))
          : !equal(size, owned.remainingQuantity))
        || !['', '0', 0, null, undefined].includes(row.executePrice as string | number | null | undefined)) {
        fail('BITGET_NATIVE_PROTECTION_PENDING_POLICY_MISMATCH');
      }
      // posSide identifies the position being protected. Do not infer it from
      // an undocumented one-way side encoding or accept missing direction.
      if (row.posSide !== plan.side) fail('BITGET_NATIVE_PROTECTION_PENDING_DIRECTION_MISMATCH');
      const created = number(row.cTime);
      const entryAt = Date.parse(owned.order.createdAt);
      if (!Number.isFinite(created) || !Number.isFinite(entryAt) || created < entryAt - 5_000
        || created > input.now() + 5_000) fail('BITGET_NATIVE_PROTECTION_OLD_MANUAL_ORDER_NOT_ADOPTED');
      proofs.push({ entryPlanId: plan.id, entryOrderId: owned.order.id, protectionOrderId: orderId,
        symbol, kind, quantity: owned.remainingQuantity, triggerPrice: Number(price), checkedAtMs });
    }
  }
  return { version: 'bitget-native-protection-readonly-v1' as const, ready: true,
    activeAutomaticPositionCount: seen.size, checkedAtMs: input.now(), proofs,
    privateReads: reads, orders: 0 as const, cancels: 0 as const, amends: 0 as const,
    transfers: 0 as const, withdrawals: 0 as const, executionAuthority: 'NONE' as const };
}

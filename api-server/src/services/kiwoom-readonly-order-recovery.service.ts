import type { PreparedExchangeRequest } from './trade-exchange-adapters.service';
import type { TradingExchangeOrderSnapshot, TradingOrder, TradingPlan } from './trade-automation.types';

type Row = Record<string, unknown>;
export type KiwoomReadonlyPage = Readonly<{
  payload: Row; apiId: string | null; contYn: string | null; nextKey: string | null;
}>;
const READ_CONTRACTS = new Map([
  ['ka10075', { path: '/api/dostk/acnt', rows: 'oso' }],
  ['kt00007', { path: '/api/dostk/acnt', rows: 'acnt_ord_cntr_prps_dtl' }],
  ['ust21050', { path: '/api/us/acnt', rows: 'result_list' }],
  ['ust21150', { path: '/api/us/acnt', rows: 'result_list' }],
]);
function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown) { return String(value ?? '').trim(); }
function quantity(value: unknown): number {
  const raw = text(value);
  if (!/^\+?\d+$/u.test(raw)) throw new Error('KIWOOM_ORDER_QUANTITY_INVALID');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('KIWOOM_ORDER_QUANTITY_INVALID');
  return n;
}
function positivePrice(value: unknown): number {
  const raw = text(value);
  if (!/^\+?\d+(?:\.\d+)?$/u.test(raw) || !(Number(raw) > 0) || !Number.isFinite(Number(raw))) {
    throw new Error('KIWOOM_ORDER_FILL_PRICE_INVALID');
  }
  return Number(raw);
}

/** Official contracts: Kiwoom-Securities/Kiwoom-REST-API, kiwoom/_data/
 * kiwoom_api_spec.json (ka10075/kt00007/ust21050/ust21150). POST here is a
 * query, never an order/cancel/amend. A truncated/ambiguous page cannot prove
 * the absence of an open order. Do not accept the example's result_lsit typo. */
export async function readCompleteKiwoomOrderRows(
  request: PreparedExchangeRequest,
  send: (request: PreparedExchangeRequest) => Promise<KiwoomReadonlyPage>,
): Promise<Row[]> {
  const apiId = request.headers['api-id'];
  const contract = READ_CONTRACTS.get(apiId);
  if (request.method !== 'POST' || !contract || request.path !== contract.path || request.query !== '') {
    throw new Error('KIWOOM_RECOVERY_READ_CONTRACT_REQUIRED');
  }
  const seenKeys = new Set<string>();
  const rows: Row[] = [];
  let next = request;
  for (let page = 0; page < 100; page += 1) {
    const response = await send(next);
    const payload = response.payload;
    if (!record(payload) || ![0, '0'].includes(payload.return_code as 0 | '0')) {
      throw new Error('KIWOOM_RECOVERY_QUERY_FAILED');
    }
    if (response.apiId !== null && response.apiId !== apiId) throw new Error('KIWOOM_RECOVERY_API_ID_MISMATCH');
    const part = payload[contract.rows];
    if (!Array.isArray(part) || part.some((row) => !record(row))) throw new Error('KIWOOM_RECOVERY_ROWS_INVALID');
    rows.push(...part as Row[]);
    if (rows.length > 10_000) throw new Error('KIWOOM_RECOVERY_HISTORY_BOUND_EXCEEDED');
    const cont = text(response.contYn).toUpperCase();
    if (cont === '' || cont === 'N') {
      if (text(response.nextKey)) throw new Error('KIWOOM_RECOVERY_CONTINUATION_INVALID');
      return rows;
    }
    const key = text(response.nextKey);
    if (cont !== 'Y' || !key || key.length > 50 || seenKeys.has(key) || part.length === 0) {
      throw new Error('KIWOOM_RECOVERY_CONTINUATION_INVALID');
    }
    seenKeys.add(key);
    next = { ...request, headers: { ...request.headers, 'cont-yn': 'Y', 'next-key': key } };
  }
  throw new Error('KIWOOM_RECOVERY_PAGINATION_BOUND_EXCEEDED');
}

export function kiwoomRecoveryOrderIdentityValid(plan: TradingPlan, order: TradingOrder) {
  return plan.exchange === 'kiwoom' && order.exchange === 'kiwoom'
    && ['KR', 'US'].includes(plan.market) && ['buy', 'sell'].includes(plan.side)
    && !/^0+$/u.test(order.exchangeOrderId ?? '')
    && (plan.market === 'US' ? /^\d{9}$/u : /^\d{7}$/u).test(order.exchangeOrderId ?? '');
}

/** Only a unique, exact broker order row can be adopted. Missing rows remain
 * unknown; neither no-open-order nor remaining=0 alone proves cancellation.
 * cntr_qty is the per-order quantity, NOT a list of incremental fills.
 * Fees/tax/individual fills are not supplied by these contracts and remain
 * unknown. Never fabricate zero fees or trade IDs for compounding/PnL. */
export function kiwoomReadonlyRecoverySnapshot(
  rows: readonly Row[], plan: TradingPlan, order: TradingOrder,
  contract: 'ka10075' | 'kt00007' | 'ust21050' | 'ust21150',
): TradingExchangeOrderSnapshot | null {
  if (!kiwoomRecoveryOrderIdentityValid(plan, order)) throw new Error('KIWOOM_RECOVERY_ORDER_ID_INVALID');
  const us = plan.market === 'US';
  if (us !== contract.startsWith('ust')) throw new Error('KIWOOM_RECOVERY_MARKET_CONTRACT_MISMATCH');
  const matches = rows.filter((row) => text(row.ord_no) === order.exchangeOrderId);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('KIWOOM_RECOVERY_ORDER_ROW_AMBIGUOUS');
  const row = matches[0]!;
  const symbol = (value: unknown) => us ? text(value).toUpperCase() : text(value).replace(/^A/u, '').toUpperCase();
  if (symbol(row.stk_cd) !== symbol(plan.symbol)
    || us && text(row.crnc_code) !== 'USD') throw new Error('KIWOOM_ORDER_IDENTITY_MISMATCH');
  const side = us ? text(row.slby_tp ?? row.slby_tp_nm) : text(row.io_tp_nm);
  if (!(plan.side === 'buy' ? ['2', '매수', '+매수', '현금매수'].includes(side)
    : ['1', '매도', '-매도', '현금매도'].includes(side))) throw new Error('KIWOOM_ORDER_SIDE_MISMATCH');
  const requested = quantity(row.ord_qty);
  const remaining = quantity(contract === 'ka10075' ? row.oso_qty : row.ord_remnq);
  const filled = contract === 'ka10075' ? requested - remaining : quantity(row.cntr_qty);
  if (requested <= 0 || filled < 0 || remaining > requested || filled + remaining > requested
    || order.requestedQuantity !== null && requested !== order.requestedQuantity) throw new Error('KIWOOM_ORDER_QUANTITY_INVALID');
  const status = text(row.ord_stat_nm ?? row.ord_stat ?? row.ord_stt ?? row.acpt_tp);
  const modification = text(row.mdfy_cncl);
  // An amended parent cannot be reconciled as a canceled or filled child.
  if (/정정/u.test(modification) || /정정/u.test(status) || us && quantity(row.mdfy_qty) !== 0) {
    throw new Error('KIWOOM_RECOVERY_AMENDMENT_REQUIRES_REVIEW');
  }
  let state: TradingExchangeOrderSnapshot['state'];
  if (/거부|실패|무효/u.test(status)) {
    if (filled !== 0 || remaining !== 0) throw new Error('KIWOOM_ORDER_STATUS_QUANTITY_MISMATCH');
    state = 'REJECTED';
  } else if (/취소/u.test(status) || /취소/u.test(modification)) {
    if (remaining !== 0 || filled >= requested
      || quantity(us ? row.cncl_qty : row.cnfm_qty) !== requested - filled) {
      throw new Error('KIWOOM_ORDER_STATUS_QUANTITY_MISMATCH');
    }
    state = 'CANCELED';
  } else if (filled === requested && remaining === 0) {
    if (!['접수', '확인', '체결', '체결완료', '완전체결'].includes(status)) throw new Error('KIWOOM_ORDER_STATUS_UNKNOWN');
    state = 'FILLED';
  } else if (filled + remaining === requested && remaining > 0
    && ['접수', '확인', '부분체결', '체결', '주문전송'].includes(status)) {
    state = filled > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED';
  } else { throw new Error('KIWOOM_ORDER_STATUS_UNKNOWN'); }
  if (us && !['CANCELED', 'REJECTED'].includes(state) && quantity(row.cncl_qty) !== 0) {
    throw new Error('KIWOOM_RECOVERY_PARTIAL_CANCELLATION_REQUIRES_REVIEW');
  }
  const price = filled > 0 ? contract === 'ka10075'
    ? positivePrice(row.cntr_tot_amt) / filled : positivePrice(row.cntr_uv) : null;
  return {
    exchangeOrderId: order.exchangeOrderId, state, requestedQuantity: requested,
    filledQuantity: filled,
    // Repository residual quantity tracks unfilled requested units even after
    // a terminal cancellation; raw broker remaining=0 was validated above.
    remainingQuantity: requested - filled, averageFillPrice: price, fills: [],
    feeAmount: null, feeCurrency: null, exchangeCreatedAt: null, exchangeUpdatedAt: null,
    cancelable: state === 'ACCEPTED' || state === 'PARTIALLY_FILLED', providerStatusCode: status,
  };
}

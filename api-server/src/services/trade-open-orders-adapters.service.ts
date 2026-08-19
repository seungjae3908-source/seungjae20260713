import {
  buildUpbitJwt,
  type PreparedExchangeRequest,
  type UpbitCredentials,
} from './trade-exchange-adapters.service';

export type UpbitOpenOrderState = 'wait' | 'watch';

export function prepareUpbitOpenOrders(
  credentials: UpbitCredentials,
  symbol: string,
  state: UpbitOpenOrderState,
  page = 1,
  nonce?: string,
): PreparedExchangeRequest {
  if (!Number.isInteger(page) || page < 1) throw new Error('UPBIT_OPEN_ORDER_PAGE_INVALID');
  const market = `KRW-${symbol.toUpperCase().replace(/^KRW-/, '')}`;
  const query = `market=${market}&state=${state}&page=${page}&limit=100&order_by=asc`;
  return {
    method: 'GET',
    path: '/v1/orders/open',
    query,
    headers: {
      Authorization: `Bearer ${buildUpbitJwt(credentials, query, nonce)}`,
      Accept: 'application/json',
    },
    body: null,
  };
}

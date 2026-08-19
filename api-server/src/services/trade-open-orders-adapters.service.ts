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
  nonce?: string,
): PreparedExchangeRequest {
  const market = `KRW-${symbol.toUpperCase().replace(/^KRW-/, '')}`;
  const query = `market=${market}&state=${state}&limit=100`;
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

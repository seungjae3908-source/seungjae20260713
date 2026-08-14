export const TOSS_OPENAPI_VERSION = '1.2.13' as const;
export const TOSS_OPENAPI_BASE_URL = 'https://openapi.tossinvest.com' as const;

export const TOSS_ENDPOINTS = Object.freeze({
  token: '/oauth2/token',
  accounts: '/api/v1/accounts',
  holdings: '/api/v1/holdings',
  orders: '/api/v1/orders',
  buyingPower: '/api/v1/buying-power',
  sellableQuantity: '/api/v1/sellable-quantity',
  commissions: '/api/v1/commissions',
});

export type TossMarketCountry = 'KR' | 'US';
export type TossOrderSide = 'BUY' | 'SELL';
export type TossOrderType = 'LIMIT' | 'MARKET';
export type TossTimeInForce = 'DAY' | 'CLS';

export type TossOrderContractInput = {
  marketCountry: TossMarketCountry;
  symbol: string;
  side: TossOrderSide;
  orderType: TossOrderType;
  clientOrderId?: string;
  quantity?: string;
  orderAmount?: string;
  price?: string;
  timeInForce?: TossTimeInForce;
  confirmHighValueOrder?: boolean;
};

export type TossContractValidation = {
  valid: boolean;
  errors: string[];
};

function positiveDecimal(value: string | undefined): boolean {
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0;
}

export function validateTossOrderContract(input: TossOrderContractInput): TossContractValidation {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9.\-]+$/.test(input.symbol)) errors.push('TOSS_SYMBOL_INVALID');
  if (input.clientOrderId && !/^[A-Za-z0-9_-]{1,36}$/.test(input.clientOrderId)) errors.push('TOSS_CLIENT_ORDER_ID_INVALID');

  const hasQuantity = input.quantity != null;
  const hasOrderAmount = input.orderAmount != null;
  if (hasQuantity === hasOrderAmount) errors.push('TOSS_EXACTLY_ONE_QUANTITY_OR_AMOUNT_REQUIRED');

  if (hasOrderAmount) {
    if (input.marketCountry !== 'US' || input.orderType !== 'MARKET') errors.push('TOSS_AMOUNT_ORDER_US_MARKET_ONLY');
    if (!positiveDecimal(input.orderAmount)) errors.push('TOSS_ORDER_AMOUNT_INVALID');
  }

  if (hasQuantity) {
    if (!positiveDecimal(input.quantity)) errors.push('TOSS_QUANTITY_INVALID');
    const fractional = input.quantity?.includes('.') ?? false;
    if (fractional && !(input.marketCountry === 'US' && input.side === 'SELL' && input.orderType === 'MARKET')) {
      errors.push('TOSS_FRACTIONAL_QUANTITY_NOT_ALLOWED');
    }
    if (fractional && (input.quantity?.split('.')[1]?.length ?? 0) > 6) errors.push('TOSS_FRACTIONAL_QUANTITY_SCALE_EXCEEDED');
  }

  if (input.orderType === 'LIMIT') {
    if (!positiveDecimal(input.price)) errors.push('TOSS_LIMIT_PRICE_REQUIRED');
  } else if (input.price != null) {
    errors.push('TOSS_MARKET_PRICE_FORBIDDEN');
  }

  if (input.timeInForce === 'CLS' && !(input.marketCountry === 'US' && input.orderType === 'LIMIT')) {
    errors.push('TOSS_CLS_US_LIMIT_ONLY');
  }

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function tossOrderDetailPath(orderId: string): string {
  if (!orderId.trim()) throw new Error('TOSS_ORDER_ID_REQUIRED');
  return `${TOSS_ENDPOINTS.orders}/${encodeURIComponent(orderId.trim())}`;
}

export function tossOrderModifyPath(orderId: string): string {
  return `${tossOrderDetailPath(orderId)}/modify`;
}

export function tossOrderCancelPath(orderId: string): string {
  return `${tossOrderDetailPath(orderId)}/cancel`;
}

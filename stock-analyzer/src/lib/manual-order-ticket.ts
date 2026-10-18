// Opens the manual real-order ticket from anywhere (orderbook dock, holdings, stock tab).
export type ManualOrderMarket = 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
export type ManualOrderAction = 'buy' | 'sell' | 'long' | 'short' | 'close_long' | 'close_short';

export type ManualOrderTicketRequest = {
  market: ManualOrderMarket;
  symbol: string;
  action?: ManualOrderAction;
  price?: number | null;
  quantity?: number | null;
};

const OPEN_EVENT = 'manual-order-ticket:open';
const PRICE_EVENT = 'manual-order-ticket:price';

export function openManualOrderTicket(request: ManualOrderTicketRequest) {
  window.dispatchEvent(new CustomEvent<ManualOrderTicketRequest>(OPEN_EVENT, { detail: request }));
}

/** Orderbook price click: fills the open ticket's limit price (or opens a ticket). */
export function selectManualOrderPrice(request: ManualOrderTicketRequest & { price: number }) {
  window.dispatchEvent(new CustomEvent<ManualOrderTicketRequest>(PRICE_EVENT, { detail: request }));
}

export function onManualOrderTicketOpen(listener: (request: ManualOrderTicketRequest) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<ManualOrderTicketRequest>).detail);
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

export function onManualOrderPrice(listener: (request: ManualOrderTicketRequest) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<ManualOrderTicketRequest>).detail);
  window.addEventListener(PRICE_EVENT, handler);
  return () => window.removeEventListener(PRICE_EVENT, handler);
}

export const MANUAL_ORDER_MARKET_LABELS: Record<ManualOrderMarket, string> = {
  domestic_stock: '국내주식',
  us_stock: '미국주식',
  crypto_spot: '코인현물',
  crypto_futures: '코인선물',
};

export const MANUAL_ORDER_ACTION_LABELS: Record<ManualOrderAction, string> = {
  buy: '매수',
  sell: '매도',
  long: '롱',
  short: '숏',
  close_long: '롱 청산',
  close_short: '숏 청산',
};

export function isManualOrderExit(action: ManualOrderAction) {
  return action === 'sell' || action === 'close_long' || action === 'close_short';
}

export const MANUAL_ORDER_ERRORS: Record<string, string> = {
  MANUAL_ORDER_MARKET_INVALID: '시장을 확인해 주세요.',
  MANUAL_ORDER_SYMBOL_INVALID: '종목 코드를 확인해 주세요.',
  MANUAL_ORDER_TYPE_INVALID: '주문 방식을 확인해 주세요.',
  MANUAL_ORDER_LIMIT_PRICE_REQUIRED: '지정가를 입력해 주세요.',
  MANUAL_ORDER_ACTION_INVALID: '이 시장에서 쓸 수 없는 주문 종류입니다.',
  MANUAL_ORDER_AMOUNT_REQUIRED: '업비트 시장가 매수는 주문 금액(원)을 입력해 주세요.',
  MANUAL_ORDER_QUANTITY_REQUIRED: '수량을 입력해 주세요.',
  MANUAL_ORDER_QUANTITY_MUST_BE_INTEGER: '국내주식(키움)은 정수 수량만 주문할 수 있습니다.',
  MANUAL_ORDER_US_EXCHANGE_REQUIRED: '키움 미국주식은 거래소(NASDAQ/NYSE/AMEX)를 선택해 주세요.',
  MANUAL_ORDER_STOP_REQUIRED: '신규 진입은 손절가를 입력해야 합니다.',
  MANUAL_ORDER_STOP_SIDE_INVALID: '손절가가 현재가의 반대쪽에 있어야 합니다. (매수·롱은 아래, 숏은 위)',
  MANUAL_ORDER_TARGET_SIDE_INVALID: '목표가 방향을 확인해 주세요. (매수·롱은 위, 숏은 아래)',
  MANUAL_ORDER_PRICE_UNAVAILABLE: '현재가를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  MANUAL_ORDER_FX_UNAVAILABLE: '환율을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  LIVE_ORDER_CAPABILITY_REQUIRED: '실주문 권한이 없는 계정입니다.',
  FUTURES_ACCESS_REQUIRED: '코인선물 이용 권한이 없는 계정입니다.',
  LIVE_EXECUTION_CONNECTION_NOT_CONFIGURED: '이 거래소의 실거래 키가 연결되어 있지 않습니다. 계좌 연결에서 등록해 주세요.',
  LIVE_EXECUTION_CONNECTION_NOT_VERIFIED: '거래소 키 검증이 오래됐습니다. 계좌 연결에서 다시 검증해 주세요.',
  TRADE_PLAN_EXPIRED: '확인 시간이 지났습니다. 다시 주문 확인을 눌러 주세요.',
};

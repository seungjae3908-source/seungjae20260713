export const TELEGRAM_MARKET_ROOMS = [
  'KR_STOCK_ROOM',
  'US_STOCK_ROOM',
  'CRYPTO_SPOT_ROOM',
  'CRYPTO_FUTURES_ROOM',
] as const;

export type TelegramMarketRoom = (typeof TELEGRAM_MARKET_ROOMS)[number];

export type TelegramMarketLane =
  | 'KR_STOCK'
  | 'US_STOCK'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_FUTURES';

const US_STOCK_MARKET_CODES = new Set([
  'US', 'USA', 'US_STOCK', 'STOCK_US', 'US_EQUITY',
  'NASDAQ', 'NYSE', 'AMEX', 'NYSE_AMERICAN', 'NYSE_ARCA', 'BATS', 'IEX', 'CBOE',
  'NASDAQ_CM', 'NASDAQ_GM', 'NASDAQ_GS',
]);
const KR_STOCK_MARKET_CODES = new Set([
  'KR', 'KOREA', 'KR_STOCK', 'STOCK_KR', 'KRX', 'KOSPI', 'KOSDAQ', 'KONEX', 'KS', 'KQ',
]);

/** Never default an unknown stock venue to the Korean public Telegram room. */
export function telegramStockLaneForMarket(market: string): 'KR_STOCK' | 'US_STOCK' | null {
  const value = market.trim().toUpperCase().replace(/[\s-]+/gu, '_');
  if (US_STOCK_MARKET_CODES.has(value)) return 'US_STOCK';
  if (KR_STOCK_MARKET_CODES.has(value)) return 'KR_STOCK';
  return null;
}

export function telegramMarketRoomForLane(lane: TelegramMarketLane): TelegramMarketRoom {
  switch (lane) {
    case 'KR_STOCK': return 'KR_STOCK_ROOM';
    case 'US_STOCK': return 'US_STOCK_ROOM';
    case 'CRYPTO_SPOT': return 'CRYPTO_SPOT_ROOM';
    case 'CRYPTO_FUTURES': return 'CRYPTO_FUTURES_ROOM';
  }
}

export function telegramMarketRoomChatId(
  room: TelegramMarketRoom,
  env: NodeJS.ProcessEnv = process.env,
  options: { allowLegacyFallback?: boolean } = {},
): string | null {
  // Keep public markets isolated from other markets, holdings and AUTO.
  // Fail closed if any two configured dedicated destinations collide.
  const dedicatedIds = [
    env.TELEGRAM_KR_STOCK_CHAT_ID, env.TELEGRAM_US_STOCK_CHAT_ID,
    env.TELEGRAM_CRYPTO_SPOT_CHAT_ID, env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID,
    env.TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID, env.TELEGRAM_AUTO_TRADING_CHAT_ID,
  ].map(value => value?.trim()).filter((value): value is string => Boolean(value));
  if (new Set(dedicatedIds).size !== dedicatedIds.length) return null;

  const exact = (() => {
    switch (room) {
      case 'KR_STOCK_ROOM': return env.TELEGRAM_KR_STOCK_CHAT_ID;
      case 'US_STOCK_ROOM': return env.TELEGRAM_US_STOCK_CHAT_ID;
      case 'CRYPTO_SPOT_ROOM': return env.TELEGRAM_CRYPTO_SPOT_CHAT_ID;
      case 'CRYPTO_FUTURES_ROOM': return env.TELEGRAM_CRYPTO_FUTURES_CHAT_ID;
    }
  })()?.trim();
  if (exact) return exact;

  if (options.allowLegacyFallback !== true) return null;
  if (room === 'KR_STOCK_ROOM' || room === 'US_STOCK_ROOM') {
    return env.TELEGRAM_STOCK_CHAT_ID?.trim() || null;
  }
  return env.TELEGRAM_CRYPTO_CHAT_ID?.trim() || null;
}

export function telegramMarketRoomLabel(room: TelegramMarketRoom): string {
  switch (room) {
    case 'KR_STOCK_ROOM': return '국내주식';
    case 'US_STOCK_ROOM': return '해외주식';
    case 'CRYPTO_SPOT_ROOM': return '코인현물';
    case 'CRYPTO_FUTURES_ROOM': return '코인선물';
  }
}

export function missingTelegramMarketRoomEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const required: Array<[TelegramMarketRoom, string]> = [
    ['KR_STOCK_ROOM', 'TELEGRAM_KR_STOCK_CHAT_ID'],
    ['US_STOCK_ROOM', 'TELEGRAM_US_STOCK_CHAT_ID'],
    ['CRYPTO_SPOT_ROOM', 'TELEGRAM_CRYPTO_SPOT_CHAT_ID'],
    ['CRYPTO_FUTURES_ROOM', 'TELEGRAM_CRYPTO_FUTURES_CHAT_ID'],
  ];
  return required
    .filter(([room]) => !telegramMarketRoomChatId(room, env))
    .map(([, key]) => key);
}

export type TelegramScannerMarket = 'KR' | 'US' | 'UPBIT' | 'BITGET';
export type TelegramScannerView = 'KR' | 'US' | 'SPOT' | 'FUTURES';
export type TelegramScannerStrategy = 'scalping' | 'swing' | 'position';
export type TelegramScannerAction = 'BUY' | 'LONG' | 'SHORT';

export type TelegramScannerIntent = {
  source: 'telegram';
  market: TelegramScannerMarket;
  view: TelegramScannerView;
  symbol: string;
  strategyMode: TelegramScannerStrategy;
  timeframe: string | null;
  action: TelegramScannerAction | null;
  orderPreparation: true;
};

const FORBIDDEN_IDENTITY_PARAMS = [
  'userId',
  'user_id',
  'memberId',
  'member_id',
  'chatId',
  'chat_id',
  'accountId',
  'account_id',
] as const;

function marketView(value: string | null): { market: TelegramScannerMarket; view: TelegramScannerView } | null {
  const market = String(value ?? '').trim().toUpperCase();
  if (market === 'KR' || market === 'KR_STOCK') return { market: 'KR', view: 'KR' };
  if (market === 'US' || market === 'US_STOCK') return { market: 'US', view: 'US' };
  if (market === 'UPBIT' || market === 'CRYPTO_SPOT') return { market: 'UPBIT', view: 'SPOT' };
  if (market === 'BITGET' || market === 'CRYPTO_FUTURES') return { market: 'BITGET', view: 'FUTURES' };
  return null;
}

function strategy(value: string | null): TelegramScannerStrategy {
  if (value === 'scalping' || value === 'position') return value;
  return 'swing';
}

function action(value: string | null, market: TelegramScannerMarket): TelegramScannerAction | null {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (market === 'BITGET') return normalized === 'LONG' || normalized === 'SHORT' ? normalized : null;
  return normalized === 'BUY' ? 'BUY' : null;
}

export function parseTelegramScannerIntent(search: string): TelegramScannerIntent | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.get('source') !== 'telegram' || params.get('orderPreparation') !== '1') return null;
  if (FORBIDDEN_IDENTITY_PARAMS.some((key) => params.has(key))) return null;

  const resolved = marketView(params.get('market'));
  if (!resolved) return null;
  const symbol = String(params.get('symbol') ?? params.get('ticker') ?? '')
    .normalize('NFKC')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9._:-]{1,40}$/u.test(symbol)) return null;

  return {
    source: 'telegram',
    market: resolved.market,
    view: resolved.view,
    symbol,
    strategyMode: strategy(params.get('strategyMode')),
    timeframe: params.get('timeframe')?.trim().slice(0, 12) || null,
    action: action(params.get('action'), resolved.market),
    orderPreparation: true,
  };
}

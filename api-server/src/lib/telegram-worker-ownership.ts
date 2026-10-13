/** Embedded remains the default until a separately approved atomic handoff. */
const tradingFlags = [
  'LIVE_TRADING','AUTO_TRADING','REAL_ORDER_ENABLED',
  'PRIVATE_TRADING_API_ALLOWED','ORDER_EXECUTION_ENABLED',
  'LIVE_TRADING_ACTIVATION_APPROVED','SPOT_LIVE_LIMITED_ACTIVATION_APPROVED',
  'LIVE_AUTOMATIC_TRADING_ENABLED','MEMBER_AUTO_TRADING_BACKGROUND_ENABLED',
  'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
  'MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED','FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED',
  'BITGET_FUTURES_LIVE_ORDER_ENABLED','CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED',
  'CRYPTO_AUTO_TRADE_ENABLED','BITGET_AUTO_TRADE_ENABLED',
  'BITGET_LIVE_ORDER_ENABLED','UPBIT_LIVE_ORDER_ENABLED',
  'KIWOOM_LIVE_ORDER_ENABLED','TOSS_LIVE_ORDER_ENABLED',
] as const;
const tradingAuthorities = ['executionAuthority','FUTURES_LIVE_EXECUTION_AUTHORITY'] as const;
const tradingAllowlists = [
  'SPOT_LIVE_CAPABILITY_ALLOWLIST','SPOT_LIVE_MARKET_ALLOWLIST',
  'FUTURES_LIVE_CAPABILITY_ALLOWLIST','FUTURES_LIVE_MARKET_ALLOWLIST',
] as const;

export function embeddedTelegramWorkersAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const owner = env.TELEGRAM_WORKER_OWNER?.trim() || 'embedded';
  if (owner === 'embedded') return true;
  if (owner === 'isolated') return false;
  throw new Error('TELEGRAM_WORKER_OWNER_INVALID');
}

export function assertIsolatedTelegramWorkerEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.TELEGRAM_WORKER_OWNER !== 'isolated'
    || env.TELEGRAM_SINGLE_WRITER_LEASE !== 'LOCK_HELD_V1'
    || env.TELEGRAM_ISOLATED_CUTOVER_APPROVED !== 'true') {
    throw new Error('TELEGRAM_ISOLATED_OWNER_OR_LEASE_NOT_APPROVED');
  }
  if (env.LIVE_TELEGRAM_ACTIVATION_APPROVED !== 'true'
    || env.PERSONAL_TELEGRAM_WORKER_ENABLED !== 'true'
    || env.TELEGRAM_INTELLIGENCE_WORKER_ENABLED !== 'true'
    || !env.TELEGRAM_BOT_TOKEN?.trim()) {
    throw new Error('TELEGRAM_ISOLATED_DELIVERY_FLAGS_INCOMPLETE');
  }
  const active = (key: string) => {
    const value = String(env[key] ?? '').trim().toLowerCase();
    return value !== '' && value !== 'false' && value !== '0';
  };
  const hasTradingAuthority = tradingFlags.some(active)
    || tradingAuthorities.some(key => {
      const value = String(env[key] ?? 'NONE').trim().toUpperCase();
      return value !== '' && value !== 'NONE';
    })
    || tradingAllowlists.some(key => String(env[key] ?? '').trim().length > 0);
  if (hasTradingAuthority) {
    throw new Error('TELEGRAM_ISOLATED_WORKER_TRADING_AUTHORITY_FORBIDDEN');
  }
  // All six destinations must be distinct before ANY worker can POST.
  const roomKeys = [
    'TELEGRAM_KR_STOCK_CHAT_ID','TELEGRAM_US_STOCK_CHAT_ID',
    'TELEGRAM_CRYPTO_SPOT_CHAT_ID','TELEGRAM_CRYPTO_FUTURES_CHAT_ID',
    'TELEGRAM_AUTO_TRADING_CHAT_ID','TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID',
  ] as const;
  const roomIds = roomKeys.map(key => env[key]?.trim() || '');
  if (roomIds.some(x => !x) || new Set(roomIds).size !== roomIds.length) {
    throw new Error('TELEGRAM_ISOLATED_SIX_ROOM_CONFIG_INVALID');
  }
  if (!env.SUPABASE_URL?.trim()
    || !(env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim())) {
    throw new Error('TELEGRAM_ISOLATED_PERSONAL_STORAGE_NOT_CONFIGURED');
  }
  if (!env.TELEGRAM_INTELLIGENCE_STATE_PATH?.startsWith('/opt/stock-app/.runtime/')
    || !env.SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH?.startsWith('/opt/stock-app/.runtime/')) {
    throw new Error('TELEGRAM_ISOLATED_LEDGER_PATH_UNVERIFIED');
  }
}

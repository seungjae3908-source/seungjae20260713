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
  'TRANSFER_ENABLED','WITHDRAWAL_ENABLED',
  'TOSS_ORDER_ENABLED','KIWOOM_ORDER_ENABLED','UPBIT_ORDER_ENABLED','BITGET_ORDER_ENABLED',
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
  // The Telegram worker must never inherit private broker signing material,
  // even if an order-enable boolean is false. Service-role is separately
  // required for the owner-bound personal notification outbox.
  const brokerCredentialKeys = [
    'TRADING_CREDENTIAL_MASTER_KEY','TOSS_APP_KEY','TOSS_API_KEY',
    'TOSS_ACCESS_TOKEN','KIWOOM_APP_KEY','KIWOOM_APP_SECRET',
    'UPBIT_ACCESS_KEY','UPBIT_SECRET_KEY','BITGET_API_KEY',
    'BITGET_API_SECRET','BITGET_PASSPHRASE',
  ] as const;
  if (brokerCredentialKeys.some(key => Boolean(env[key]?.trim()))) {
    throw new Error('TELEGRAM_ISOLATED_PRIVATE_BROKER_SECRETS_FORBIDDEN');
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
  // Fixed durable paths are part of the single-writer identity. A prefix
  // match can be bypassed by dot-dot or by writing to another ledger file.
  if (env.TELEGRAM_INTELLIGENCE_STATE_PATH
      !== '/opt/stock-app/.runtime/telegram-intelligence-delivery-state.json'
    || env.SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH
      !== '/opt/stock-app/.runtime/signal-intelligence-telegram-state.json'
    || env.SIGNAL_INTELLIGENCE_AI_WATCH_STATE_PATH
      !== '/opt/stock-app/.runtime/signal-ai-watch-delivery-state.json') {
    throw new Error('TELEGRAM_ISOLATED_LEDGER_PATH_UNVERIFIED');
  }
}

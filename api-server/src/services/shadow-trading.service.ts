import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MarketDataService } from './market-data.service';
import {
  fetchBitgetTickers,
  fetchUpbitTopTickers,
} from './analysis/crypto-source';

export type ShadowMarket = 'KR' | 'US' | 'UPBIT_SPOT' | 'BITGET_FUTURES';
export type ShadowDirection = 'LONG' | 'SHORT';

export const SHADOW_POLICY = {
  version: 'shadow-200k-v1',
  startingCapitalKRW: 200_000,
  minimumNotionalKRW: 5_000,
  maximumNotionalPerPositionKRW: 20_000,
  maximumConcurrentPositions: 1,
  maximumDailyLossKRW: 4_000,
  maximumTotalLossKRW: 10_000,
  allowedLeverage: 1,
  feeBpsPerSide: {
    KR: 20,
    US: 25,
    UPBIT_SPOT: 10,
    BITGET_FUTURES: 12,
  } satisfies Record<ShadowMarket, number>,
  slippageBpsPerSide: {
    KR: 10,
    US: 15,
    UPBIT_SPOT: 10,
    BITGET_FUTURES: 15,
  } satisfies Record<ShadowMarket, number>,
} as const;

export type ShadowPosition = {
  id: string;
  market: ShadowMarket;
  symbol: string;
  direction: ShadowDirection;
  quantity: number;
  entryPrice: number;
  entryFxRate: number;
  allocatedCapitalKRW: number;
  entryFeeKRW: number;
  estimatedEntrySlippageKRW: number;
  stopPrice: number | null;
  targetPrice: number | null;
  provider: string;
  sourceFetchedAt: string;
  openedAt: string;
};

export type ShadowTrade = {
  id: string;
  positionId: string;
  market: ShadowMarket;
  symbol: string;
  direction: ShadowDirection;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryFxRate: number;
  exitFxRate: number;
  allocatedCapitalKRW: number;
  grossPnlKRW: number;
  entryFeeKRW: number;
  exitFeeKRW: number;
  netPnlKRW: number;
  estimatedSlippageKRW: number;
  exitReason: string;
  openedAt: string;
  closedAt: string;
};

type ShadowAccount = {
  memberId: string;
  version: 1;
  startedAt: string;
  updatedAt: string;
  disabled: boolean;
  disabledReason: string | null;
  positions: ShadowPosition[];
  trades: ShadowTrade[];
};

type ShadowStore = {
  version: 1;
  accounts: Record<string, ShadowAccount>;
};

type LiveQuote = {
  price: number;
  fxRate: number;
  provider: string;
  fetchedAt: string;
};

let loaded = false;
let store: ShadowStore = { version: 1, accounts: {} };
let writeQueue = Promise.resolve();

function storageDirectory() {
  const cwd = process.cwd();
  return path.basename(cwd) === 'api-server'
    ? path.join(cwd, 'data')
    : path.join(cwd, 'api-server', 'data');
}

function storeFile() {
  return path.join(storageDirectory(), 'shadow-trading-200k.json');
}

function nowIso() {
  return new Date().toISOString();
}

function createAccount(memberId: string): ShadowAccount {
  const createdAt = nowIso();
  return {
    memberId,
    version: 1,
    startedAt: createdAt,
    updatedAt: createdAt,
    disabled: false,
    disabledReason: null,
    positions: [],
    trades: [],
  };
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(storeFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ShadowStore>;
    store = {
      version: 1,
      accounts:
        parsed.accounts && typeof parsed.accounts === 'object'
          ? (parsed.accounts as Record<string, ShadowAccount>)
          : {},
    };
  } catch {
    store = { version: 1, accounts: {} };
  }
}

function saveStore() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(storageDirectory(), { recursive: true });
    await writeFile(storeFile(), JSON.stringify(store, null, 2), 'utf8');
  });
  return writeQueue;
}

async function accountFor(memberId: string) {
  await ensureLoaded();
  if (!store.accounts[memberId]) {
    store.accounts[memberId] = createAccount(memberId);
    await saveStore();
  }
  return store.accounts[memberId];
}

function finitePositive(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} 값이 올바르지 않습니다.`);
  }
  return number;
}

function normalizeSymbol(market: ShadowMarket, value: unknown) {
  let symbol = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '');
  if (market === 'UPBIT_SPOT') symbol = symbol.replace(/^KRW-/, '');
  if (market === 'BITGET_FUTURES' && !symbol.endsWith('USDT')) {
    symbol = `${symbol}USDT`;
  }
  if (!symbol) throw new Error('종목 또는 코인 심볼이 필요합니다.');
  return symbol.slice(0, 30);
}

function bpsAmount(amount: number, bps: number) {
  return amount * (bps / 10_000);
}

function closedNetPnl(account: ShadowAccount) {
  return account.trades.reduce((sum, trade) => sum + trade.netPnlKRW, 0);
}

function openEntryFees(account: ShadowAccount) {
  return account.positions.reduce((sum, position) => sum + position.entryFeeKRW, 0);
}

function allocatedCapital(account: ShadowAccount) {
  return account.positions.reduce(
    (sum, position) => sum + position.allocatedCapitalKRW,
    0,
  );
}

function availableCapital(account: ShadowAccount) {
  return Math.max(
    0,
    SHADOW_POLICY.startingCapitalKRW +
      closedNetPnl(account) -
      openEntryFees(account) -
      allocatedCapital(account),
  );
}

function todayKey(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function dailyNetPnl(account: ShadowAccount) {
  const today = todayKey();
  return account.trades
    .filter((trade) => trade.closedAt.slice(0, 10) === today)
    .reduce((sum, trade) => sum + trade.netPnlKRW, 0);
}

function enforceLossLocks(account: ShadowAccount) {
  const total = closedNetPnl(account);
  const daily = dailyNetPnl(account);
  if (daily <= -SHADOW_POLICY.maximumDailyLossKRW) {
    account.disabled = true;
    account.disabledReason = '일일 가상 손실한도에 도달했습니다.';
  }
  if (total <= -SHADOW_POLICY.maximumTotalLossKRW) {
    account.disabled = true;
    account.disabledReason = '전체 가상 손실한도에 도달했습니다.';
  }
}

async function usdKrwRate() {
  const summary = await MarketDataService.getMarketSummary();
  const row = summary.find((item) => item.key === 'usdkrw');
  if (!row?.ok || !(row.price > 0)) {
    throw new Error('원/달러 환율을 확인하지 못해 가상 주문을 차단했습니다.');
  }
  return row.price;
}

async function liveQuote(
  market: ShadowMarket,
  rawSymbol: unknown,
): Promise<LiveQuote> {
  const symbol = normalizeSymbol(market, rawSymbol);
  const fetchedAt = nowIso();

  if (market === 'KR' || market === 'US') {
    const quote = (await MarketDataService.getQuote(symbol)) as Record<string, unknown>;
    const price = finitePositive(
      quote.price ?? quote.currentPrice ?? quote.regularMarketPrice,
      '현재가',
    );
    return {
      price,
      fxRate: market === 'US' ? await usdKrwRate() : 1,
      provider: `market-data:${market}`,
      fetchedAt,
    };
  }

  if (market === 'UPBIT_SPOT') {
    const rows = await fetchUpbitTopTickers(500);
    const row = rows.find((item) => item.symbol === symbol);
    if (!row?.price) throw new Error(`업비트 ${symbol} 현재가를 찾지 못했습니다.`);
    return {
      price: finitePositive(row.price, '현재가'),
      fxRate: 1,
      provider: 'upbit-public',
      fetchedAt,
    };
  }

  const rows = await fetchBitgetTickers();
  const row = rows.find((item) => item.symbol === symbol);
  if (!row?.price) throw new Error(`비트겟 ${symbol} 현재가를 찾지 못했습니다.`);
  return {
    price: finitePositive(row.price, '현재가'),
    fxRate: await usdKrwRate(),
    provider: 'bitget-public',
    fetchedAt,
  };
}

function markPnl(position: ShadowPosition, quote: LiveQuote) {
  const entryValue =
    position.entryPrice * position.quantity * position.entryFxRate;
  const currentValue = quote.price * position.quantity * quote.fxRate;
  return position.direction === 'LONG'
    ? currentValue - entryValue
    : entryValue - currentValue;
}

async function positionView(position: ShadowPosition) {
  try {
    const quote = await liveQuote(position.market, position.symbol);
    const unrealizedPnlKRW = markPnl(position, quote);
    return {
      ...position,
      currentPrice: quote.price,
      currentFxRate: quote.fxRate,
      unrealizedPnlKRW,
      unrealizedReturnPercent:
        position.allocatedCapitalKRW > 0
          ? (unrealizedPnlKRW / position.allocatedCapitalKRW) * 100
          : 0,
      quoteProvider: quote.provider,
      quoteFetchedAt: quote.fetchedAt,
      quoteError: null,
    };
  } catch (error) {
    return {
      ...position,
      currentPrice: null,
      currentFxRate: null,
      unrealizedPnlKRW: null,
      unrealizedReturnPercent: null,
      quoteProvider: null,
      quoteFetchedAt: null,
      quoteError: error instanceof Error ? error.message : '현재가 조회 실패',
    };
  }
}

export async function getShadowStatus(memberId: string) {
  const account = await accountFor(memberId);
  enforceLossLocks(account);
  const positions = await Promise.all(account.positions.map(positionView));
  const unrealizedPnlKRW = positions.reduce(
    (sum, position) =>
      sum +
      (typeof position.unrealizedPnlKRW === 'number'
        ? position.unrealizedPnlKRW
        : 0),
    0,
  );
  const realizedPnlKRW = closedNetPnl(account);
  const pendingEntryFeesKRW = openEntryFees(account);
  const equityKRW =
    SHADOW_POLICY.startingCapitalKRW +
    realizedPnlKRW +
    unrealizedPnlKRW -
    pendingEntryFeesKRW;
  const wins = account.trades.filter((trade) => trade.netPnlKRW > 0).length;
  const losses = account.trades.filter((trade) => trade.netPnlKRW < 0).length;
  const totalFeesKRW =
    account.trades.reduce(
      (sum, trade) => sum + trade.entryFeeKRW + trade.exitFeeKRW,
      0,
    ) + pendingEntryFeesKRW;
  const estimatedSlippageKRW =
    account.trades.reduce(
      (sum, trade) => sum + trade.estimatedSlippageKRW,
      0,
    ) +
    account.positions.reduce(
      (sum, position) => sum + position.estimatedEntrySlippageKRW,
      0,
    );

  account.updatedAt = nowIso();
  await saveStore();

  return {
    ok: true,
    mode: 'SHADOW' as const,
    realOrdersEnabled: false,
    policy: SHADOW_POLICY,
    account: {
      startedAt: account.startedAt,
      updatedAt: account.updatedAt,
      disabled: account.disabled,
      disabledReason: account.disabledReason,
      startingCapitalKRW: SHADOW_POLICY.startingCapitalKRW,
      equityKRW,
      availableCapitalKRW: availableCapital(account),
      allocatedCapitalKRW: allocatedCapital(account),
      realizedPnlKRW,
      unrealizedPnlKRW,
      dailyNetPnlKRW: dailyNetPnl(account),
      totalFeesKRW,
      estimatedSlippageKRW,
      tradeCount: account.trades.length,
      wins,
      losses,
      winRate:
        account.trades.length > 0
          ? (wins / account.trades.length) * 100
          : 0,
    },
    positions,
    trades: account.trades.slice(0, 100),
  };
}

export async function openShadowPosition(
  memberId: string,
  input: {
    market: ShadowMarket;
    symbol: string;
    direction: ShadowDirection;
    notionalKRW: number;
    stopPrice?: number | null;
    targetPrice?: number | null;
  },
) {
  const account = await accountFor(memberId);
  enforceLossLocks(account);
  if (account.disabled) {
    throw new Error(account.disabledReason ?? '가상매매가 안전정지 상태입니다.');
  }
  if (account.positions.length >= SHADOW_POLICY.maximumConcurrentPositions) {
    throw new Error('1단계에서는 동시에 한 포지션만 허용합니다.');
  }

  const market = input.market;
  if (!(['KR', 'US', 'UPBIT_SPOT', 'BITGET_FUTURES'] as const).includes(market)) {
    throw new Error('지원하지 않는 시장입니다.');
  }
  const direction = input.direction;
  if (direction !== 'LONG' && direction !== 'SHORT') {
    throw new Error('방향은 LONG 또는 SHORT여야 합니다.');
  }
  if (market !== 'BITGET_FUTURES' && direction === 'SHORT') {
    throw new Error('현물·주식 섀도 모드에서는 숏 진입을 허용하지 않습니다.');
  }

  const symbol = normalizeSymbol(market, input.symbol);
  const notionalKRW = Math.round(finitePositive(input.notionalKRW, '주문금액'));
  if (notionalKRW < SHADOW_POLICY.minimumNotionalKRW) {
    throw new Error(`최소 가상 주문금액은 ${SHADOW_POLICY.minimumNotionalKRW.toLocaleString()}원입니다.`);
  }
  if (notionalKRW > SHADOW_POLICY.maximumNotionalPerPositionKRW) {
    throw new Error(`1회 최대 가상 주문금액은 ${SHADOW_POLICY.maximumNotionalPerPositionKRW.toLocaleString()}원입니다.`);
  }

  const feeRate = SHADOW_POLICY.feeBpsPerSide[market] / 10_000;
  const slippageRate = SHADOW_POLICY.slippageBpsPerSide[market] / 10_000;
  const entryFeeKRW = notionalKRW * feeRate;
  if (availableCapital(account) < notionalKRW + entryFeeKRW) {
    throw new Error('가상계좌의 사용 가능 금액이 부족합니다.');
  }

  const quote = await liveQuote(market, symbol);
  const entryPrice =
    direction === 'LONG'
      ? quote.price * (1 + slippageRate)
      : quote.price * (1 - slippageRate);
  const quantity = notionalKRW / (entryPrice * quote.fxRate);
  const estimatedEntrySlippageKRW =
    Math.abs(entryPrice - quote.price) * quantity * quote.fxRate;

  const position: ShadowPosition = {
    id: randomUUID(),
    market,
    symbol,
    direction,
    quantity,
    entryPrice,
    entryFxRate: quote.fxRate,
    allocatedCapitalKRW: notionalKRW,
    entryFeeKRW,
    estimatedEntrySlippageKRW,
    stopPrice:
      input.stopPrice == null ? null : finitePositive(input.stopPrice, '손절가'),
    targetPrice:
      input.targetPrice == null
        ? null
        : finitePositive(input.targetPrice, '목표가'),
    provider: quote.provider,
    sourceFetchedAt: quote.fetchedAt,
    openedAt: nowIso(),
  };

  account.positions.push(position);
  account.updatedAt = nowIso();
  await saveStore();
  return getShadowStatus(memberId);
}

export async function closeShadowPosition(
  memberId: string,
  positionId: string,
  exitReason = 'USER_SHADOW_CLOSE',
) {
  const account = await accountFor(memberId);
  const index = account.positions.findIndex(
    (position) => position.id === positionId,
  );
  const position = account.positions[index];
  if (!position) throw new Error('가상 포지션을 찾지 못했습니다.');

  const quote = await liveQuote(position.market, position.symbol);
  const slippageRate =
    SHADOW_POLICY.slippageBpsPerSide[position.market] / 10_000;
  const exitPrice =
    position.direction === 'LONG'
      ? quote.price * (1 - slippageRate)
      : quote.price * (1 + slippageRate);
  const entryValue =
    position.entryPrice * position.quantity * position.entryFxRate;
  const exitValue = exitPrice * position.quantity * quote.fxRate;
  const grossPnlKRW =
    position.direction === 'LONG'
      ? exitValue - entryValue
      : entryValue - exitValue;
  const exitFeeKRW = bpsAmount(
    exitValue,
    SHADOW_POLICY.feeBpsPerSide[position.market],
  );
  const estimatedExitSlippageKRW =
    Math.abs(exitPrice - quote.price) * position.quantity * quote.fxRate;
  const netPnlKRW =
    grossPnlKRW - position.entryFeeKRW - exitFeeKRW;

  const trade: ShadowTrade = {
    id: randomUUID(),
    positionId: position.id,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    exitPrice,
    entryFxRate: position.entryFxRate,
    exitFxRate: quote.fxRate,
    allocatedCapitalKRW: position.allocatedCapitalKRW,
    grossPnlKRW,
    entryFeeKRW: position.entryFeeKRW,
    exitFeeKRW,
    netPnlKRW,
    estimatedSlippageKRW:
      position.estimatedEntrySlippageKRW + estimatedExitSlippageKRW,
    exitReason: String(exitReason || 'USER_SHADOW_CLOSE').slice(0, 80),
    openedAt: position.openedAt,
    closedAt: nowIso(),
  };

  account.positions.splice(index, 1);
  account.trades.unshift(trade);
  account.trades = account.trades.slice(0, 1000);
  enforceLossLocks(account);
  account.updatedAt = nowIso();
  await saveStore();
  return getShadowStatus(memberId);
}

export async function resetShadowAccount(memberId: string) {
  await ensureLoaded();
  const current = store.accounts[memberId];
  if (current?.positions.length) {
    throw new Error('열린 가상 포지션을 먼저 종료해야 초기화할 수 있습니다.');
  }
  store.accounts[memberId] = createAccount(memberId);
  await saveStore();
  return getShadowStatus(memberId);
}

import { Router, type IRouter, type Request, type Response } from 'express';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requireMember } from '../middleware/auth';

const router: IRouter = Router();
const BITGET_BASE = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';
const APPROVAL_TTL_MS = 10 * 60_000;
const JOURNAL_LIMIT = 1500;
const ORDER_DETAIL_RETRY_COUNT = 8;
const ORDER_DETAIL_RETRY_DELAY_MS = 650;

type Direction = 'LONG' | 'SHORT';
type PositionMode = 'one_way_mode' | 'hedge_mode';
type MarginMode = 'isolated' | 'crossed';
type ExecutionMode = 'PAPER' | 'REAL';
type ApprovalKind = 'OPEN' | 'CLOSE' | 'CONFIGURE';
type JournalStatus = 'SUCCESS' | 'FAILED' | 'SIMULATED' | 'PARTIAL' | 'PENDING';

type ExchangeAccount = {
  marginCoin: string;
  available: number;
  accountEquity: number;
  unrealizedPL: number;
  marginMode: MarginMode;
  posMode: PositionMode;
};

type ExchangePosition = {
  symbol: string;
  holdSide: string;
  total: number;
  available: number;
  openPriceAvg: number;
  markPrice: number;
  unrealizedPL: number;
  liquidationPrice: number;
  leverage: number;
  marginMode: string;
  marginSize: number;
  breakEvenPrice: number;
};

type OpenPlan = {
  kind: 'OPEN';
  executionMode: ExecutionMode;
  symbol: string;
  direction: Direction;
  side: 'buy' | 'sell';
  tradeSide?: 'open';
  requestedPositionMode: PositionMode;
  requestedMarginMode: MarginMode;
  positionMode: PositionMode;
  marginMode: MarginMode;
  leverage: number;
  marginAmountUSDT: number;
  notionalUSDT: number;
  currentPrice: number;
  tickerFetchedAt: string;
  size: number;
  sizeText: string;
  stopPrice: number;
  targetPrice: number;
  score: number;
  oppositeScore: number;
  minScore: number;
  btcChangePercent24h: number | null;
  reasons: string[];
  createdAt: string;
};

type ClosePlan = {
  kind: 'CLOSE';
  symbol: string;
  holdSide: 'long' | 'short' | null;
  positionMode: PositionMode;
  positionSize: number;
  markPrice: number | null;
  unrealizedPL: number | null;
  reason: string;
  createdAt: string;
};

type ConfigurePlan = {
  kind: 'CONFIGURE';
  symbol: string;
  currentPositionMode: PositionMode;
  currentMarginMode: MarginMode;
  positionMode: PositionMode;
  marginMode: MarginMode;
  leverage: number;
  pendingOrderCount: number;
  createdAt: string;
};

type ApprovalPlan = OpenPlan | ClosePlan | ConfigurePlan;

type ApprovalRecord = {
  token: string;
  memberId: string;
  kind: ApprovalKind;
  plan: ApprovalPlan;
  expiresAt: number;
  used: boolean;
};

type JournalEntry = {
  id: string;
  memberId: string;
  action:
    | 'OPEN_LONG'
    | 'OPEN_SHORT'
    | 'CLOSE_LONG'
    | 'CLOSE_SHORT'
    | 'CLOSE_ALL'
    | 'CONFIGURE'
    | 'KILL_SWITCH_ON'
    | 'KILL_SWITCH_OFF';
  symbol: string;
  status: JournalStatus;
  orderId: string | null;
  clientOid: string | null;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
};

type RuntimeState = {
  version: 2;
  killSwitch: boolean;
  killSwitchReason: string;
  killSwitchUpdatedAt: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastPositionCount: number;
  lastAccountMode: PositionMode | null;
  lastMarginMode: MarginMode | null;
};

type OrderDetail = {
  symbol?: string;
  size?: string;
  orderId?: string;
  clientOid?: string;
  baseVolume?: string;
  priceAvg?: string;
  fee?: string;
  price?: string;
  state?: string;
  status?: string;
  totalProfits?: string;
  quoteVolume?: string;
  posSide?: string;
  marginCoin?: string;
  leverage?: string;
  marginMode?: string;
  posMode?: string;
  tradeSide?: string;
  cTime?: string;
  uTime?: string;
};

const approvals = new Map<string, ApprovalRecord>();
const inFlightSymbols = new Set<string>();
let journalLoaded = false;
let journalEntries: JournalEntry[] = [];
let journalWriteQueue = Promise.resolve();
let runtimeLoaded = false;
let runtimeState: RuntimeState = defaultRuntimeState();
let runtimeWriteQueue = Promise.resolve();

function defaultRuntimeState(): RuntimeState {
  return {
    version: 2,
    killSwitch: true,
    killSwitchReason: '초기 안전정지 상태입니다. 모의매매 확인 후 직접 해제하세요.',
    killSwitchUpdatedAt: new Date().toISOString(),
    lastSyncAt: null,
    lastSyncError: null,
    lastPositionCount: 0,
    lastAccountMode: null,
    lastMarginMode: null,
  };
}

function storageDirectory() {
  const cwd = process.cwd();
  return path.basename(cwd) === 'api-server'
    ? path.join(cwd, 'data')
    : path.join(cwd, 'api-server', 'data');
}

function journalFile() {
  return path.join(storageDirectory(), 'crypto-auto-journal.json');
}

function runtimeFile() {
  return path.join(storageDirectory(), 'crypto-auto-runtime.json');
}

async function ensureJournalLoaded() {
  if (journalLoaded) return;
  journalLoaded = true;
  try {
    const raw = await readFile(journalFile(), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
    journalEntries = Array.isArray(parsed.entries) ? parsed.entries.slice(0, JOURNAL_LIMIT) : [];
  } catch {
    journalEntries = [];
  }
}

function saveJournal() {
  journalWriteQueue = journalWriteQueue.then(async () => {
    await mkdir(storageDirectory(), { recursive: true });
    await writeFile(
      journalFile(),
      JSON.stringify({ version: 2, entries: journalEntries.slice(0, JOURNAL_LIMIT) }, null, 2),
      'utf8',
    );
  });
  return journalWriteQueue;
}

async function appendJournal(entry: JournalEntry) {
  await ensureJournalLoaded();
  journalEntries = [entry, ...journalEntries].slice(0, JOURNAL_LIMIT);
  await saveJournal();
}

async function ensureRuntimeLoaded() {
  if (runtimeLoaded) return;
  runtimeLoaded = true;
  try {
    const raw = await readFile(runtimeFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RuntimeState>;
    runtimeState = {
      ...defaultRuntimeState(),
      ...parsed,
      version: 2,
      killSwitch: parsed.killSwitch !== false,
    };
  } catch {
    runtimeState = defaultRuntimeState();
    await saveRuntime();
  }
}

function saveRuntime() {
  runtimeWriteQueue = runtimeWriteQueue.then(async () => {
    await mkdir(storageDirectory(), { recursive: true });
    await writeFile(runtimeFile(), JSON.stringify(runtimeState, null, 2), 'utf8');
  });
  return runtimeWriteQueue;
}

function safeSymbol(value: unknown) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 30);
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function memberId(req: Request) {
  return String((req as Request & { member?: { id?: string } }).member?.id ?? 'unknown');
}

function normalizeExecutionKey(value: unknown) {
  let normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim();

  const first = normalized.at(0);
  const last = normalized.at(-1);
  const quoted =
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '`' && last === '`');

  if (quoted && normalized.length >= 2) normalized = normalized.slice(1, -1).trim();
  return normalized;
}

function configuredExecutionKey() {
  return normalizeExecutionKey(
    process.env.CRYPTO_AUTO_TRADE_KEY ?? process.env.KIWOOM_AUTO_TRADE_KEY ?? '',
  );
}

function constantTimeEqual(left: string, right: string) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function executionKeyValid(req: Request) {
  const configured = configuredExecutionKey();
  const supplied = normalizeExecutionKey(
    req.header('X-Crypto-Auto-Trade-Key') ?? req.header('X-Auto-Trade-Key') ?? '',
  );
  return Boolean(configured && supplied && constantTimeEqual(configured, supplied));
}

function tradingEnabled() {
  return (
    String(process.env.CRYPTO_AUTO_TRADE_ENABLED ?? '').toLowerCase() === 'true' &&
    String(process.env.BITGET_AUTO_TRADE_ENABLED ?? '').toLowerCase() === 'true'
  );
}

function credentialsConfigured() {
  return Boolean(
    String(process.env.BITGET_API_KEY ?? '').trim() &&
      String(process.env.BITGET_SECRET_KEY ?? '').trim() &&
      String(process.env.BITGET_PASSPHRASE ?? '').trim(),
  );
}

function cleanupApprovals() {
  const now = Date.now();
  for (const [token, record] of approvals) {
    if (record.used || record.expiresAt <= now) approvals.delete(token);
  }
}

function issueApproval(member: string, plan: ApprovalPlan) {
  cleanupApprovals();
  const token = randomBytes(32).toString('base64url');
  approvals.set(token, {
    token,
    memberId: member,
    kind: plan.kind,
    plan,
    expiresAt: Date.now() + APPROVAL_TTL_MS,
    used: false,
  });
  return { token, expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() };
}

function consumeApproval(req: Request, expectedKind: ApprovalKind) {
  cleanupApprovals();
  const token = String(req.body?.approvalToken ?? '').trim();
  const record = approvals.get(token);
  if (!record) throw new Error('승인 토큰이 없거나 만료됐습니다. 계획을 다시 생성하세요.');
  if (record.used) throw new Error('이미 사용된 승인 토큰입니다.');
  if (record.kind !== expectedKind) throw new Error('승인 토큰의 작업 종류가 일치하지 않습니다.');
  if (record.memberId !== memberId(req)) throw new Error('다른 사용자의 승인 토큰입니다.');
  if (record.expiresAt <= Date.now()) {
    approvals.delete(token);
    throw new Error('승인 토큰이 만료됐습니다. 계획을 다시 생성하세요.');
  }
  record.used = true;
  approvals.delete(token);
  return record.plan;
}

function bitgetHeaders(method: 'GET' | 'POST', requestPath: string, query = '', body = '') {
  const apiKey = String(process.env.BITGET_API_KEY ?? '').trim();
  const secret = String(process.env.BITGET_SECRET_KEY ?? '').trim();
  const passphrase = String(process.env.BITGET_PASSPHRASE ?? '').trim();
  if (!apiKey || !secret || !passphrase) throw new Error('BITGET_PRIVATE_KEYS_NOT_CONFIGURED');

  const timestamp = Date.now().toString();
  const queryPart = query ? `?${query}` : '';
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}${method}${requestPath}${queryPart}${body}`)
    .digest('base64');

  return {
    'ACCESS-KEY': apiKey,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    locale: 'en-US',
    'User-Agent': 'seungjae-investment-app/2.0',
  };
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text.slice(0, 300) };
    }
    if (!response.ok) throw new Error(`HTTP_${response.status}:${text.slice(0, 240)}`);
    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function bitgetPrivate<T>(method: 'GET' | 'POST', requestPath: string, query = '', data?: unknown) {
  const body = method === 'POST' ? JSON.stringify(data ?? {}) : '';
  const payload = await requestJson<{ code?: string; msg?: string; data?: T }>(
    `${BITGET_BASE}${requestPath}${query ? `?${query}` : ''}`,
    {
      method,
      headers: bitgetHeaders(method, requestPath, query, body),
      body: method === 'POST' ? body : undefined,
    },
  );
  if (String(payload.code ?? '') !== '00000') {
    throw new Error(`BITGET_${String(payload.code ?? 'INVALID')}:${String(payload.msg ?? '요청 실패')}`);
  }
  return payload.data as T;
}

async function bitgetPublic<T>(requestPath: string, query: string) {
  const payload = await requestJson<{ code?: string; msg?: string; data?: T }>(
    `${BITGET_BASE}${requestPath}?${query}`,
    { headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/2.0' } },
  );
  if (String(payload.code ?? '') !== '00000') {
    throw new Error(`BITGET_${String(payload.code ?? 'INVALID')}:${String(payload.msg ?? '요청 실패')}`);
  }
  return payload.data as T;
}

async function currentTicker(symbol: string) {
  const startedAt = Date.now();
  const rows = await bitgetPublic<any[]>(
    '/api/v2/mix/market/ticker',
    `symbol=${encodeURIComponent(symbol)}&productType=${PRODUCT_TYPE}`,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  const price = finiteNumber(row?.markPrice ?? row?.lastPr, 0);
  if (!(price > 0)) throw new Error('현재가를 확인하지 못했습니다.');
  const fetchedAt = Date.now();
  const responseAgeMs = fetchedAt - startedAt;
  const maxResponseAgeMs = clamp(
    Math.floor(finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_TICKER_RESPONSE_MS, 10_000)),
    1000,
    30_000,
  );
  if (responseAgeMs > maxResponseAgeMs) {
    throw new Error(`시세 응답이 ${responseAgeMs}ms 지연돼 안전상 중단했습니다.`);
  }
  return {
    price,
    lastPrice: finiteNumber(row?.lastPr, price),
    markPrice: finiteNumber(row?.markPrice, price),
    indexPrice: finiteNumber(row?.indexPrice, price),
    fundingRate: finiteNumber(row?.fundingRate, 0),
    fetchedAt,
    responseAgeMs,
  };
}

async function contractConfig(symbol: string) {
  const rows = await bitgetPublic<any[]>(
    '/api/v2/mix/market/contracts',
    `productType=${PRODUCT_TYPE}&symbol=${encodeURIComponent(symbol)}`,
  );
  const row = Array.isArray(rows)
    ? rows.find((item) => String(item?.symbol ?? '').toUpperCase() === symbol) ?? rows[0]
    : null;
  if (!row) throw new Error('계약 규격을 확인하지 못했습니다.');
  if (!['normal', 'listed'].includes(String(row.symbolStatus ?? '').toLowerCase())) {
    throw new Error(`현재 API 주문이 제한된 종목입니다: ${String(row.symbolStatus ?? 'unknown')}`);
  }
  return {
    minTradeNum: finiteNumber(row.minTradeNum, 0),
    minTradeUSDT: finiteNumber(row.minTradeUSDT, 5),
    sizeMultiplier: finiteNumber(row.sizeMultiplier, 0.00000001),
    volumePlace: Math.max(0, Math.floor(finiteNumber(row.volumePlace, 8))),
    pricePlace: Math.max(0, Math.floor(finiteNumber(row.pricePlace, 8))),
    minLever: Math.max(1, Math.floor(finiteNumber(row.minLever, 1))),
    maxLever: Math.max(1, Math.floor(finiteNumber(row.maxLever, 20))),
    maxMarketOrderQty: finiteNumber(row.maxMarketOrderQty, Number.POSITIVE_INFINITY),
  };
}

function normalizePositionMode(value: unknown): PositionMode {
  return String(value ?? '').toLowerCase() === 'hedge_mode' ? 'hedge_mode' : 'one_way_mode';
}

function normalizeMarginMode(value: unknown): MarginMode {
  return String(value ?? '').toLowerCase() === 'crossed' ? 'crossed' : 'isolated';
}

async function singleAccount(symbol: string): Promise<ExchangeAccount> {
  const row = await bitgetPrivate<any>(
    'GET',
    '/api/v2/mix/account/account',
    `symbol=${encodeURIComponent(symbol)}&productType=${PRODUCT_TYPE}&marginCoin=${MARGIN_COIN}`,
  );
  return {
    marginCoin: String(row?.marginCoin ?? MARGIN_COIN).toUpperCase(),
    available: finiteNumber(row?.available, 0),
    accountEquity: finiteNumber(row?.accountEquity ?? row?.usdtEquity, 0),
    unrealizedPL: finiteNumber(row?.unrealizedPL, 0),
    marginMode: normalizeMarginMode(row?.marginMode),
    posMode: normalizePositionMode(row?.posMode),
  };
}

async function allPositions(): Promise<ExchangePosition[]> {
  const rows = await bitgetPrivate<any[]>(
    'GET',
    '/api/v2/mix/position/all-position',
    `productType=${PRODUCT_TYPE}&marginCoin=${MARGIN_COIN}`,
  );
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      symbol: safeSymbol(row?.symbol),
      holdSide: String(row?.holdSide ?? '').toLowerCase(),
      total: finiteNumber(row?.total, 0),
      available: finiteNumber(row?.available, 0),
      openPriceAvg: finiteNumber(row?.openPriceAvg, 0),
      markPrice: finiteNumber(row?.markPrice, 0),
      unrealizedPL: finiteNumber(row?.unrealizedPL, 0),
      liquidationPrice: finiteNumber(row?.liquidationPrice, 0),
      leverage: finiteNumber(row?.leverage, 0),
      marginMode: String(row?.marginMode ?? ''),
      marginSize: finiteNumber(row?.marginSize, 0),
      breakEvenPrice: finiteNumber(row?.breakEvenPrice, 0),
    }))
    .filter((row) => row.total !== 0);
}

async function pendingOrders(symbol?: string) {
  const query = new URLSearchParams({ productType: PRODUCT_TYPE, limit: '100' });
  if (symbol) query.set('symbol', symbol);
  const data = await bitgetPrivate<{ entrustedList?: any[] }>(
    'GET',
    '/api/v2/mix/order/orders-pending',
    query.toString(),
  );
  return Array.isArray(data?.entrustedList) ? data.entrustedList : [];
}

function decimalPlaces(value: number) {
  const text = String(value);
  if (text.includes('e-')) return Number(text.split('e-')[1] ?? 0);
  return text.includes('.') ? text.split('.')[1]?.length ?? 0 : 0;
}

function floorToStep(value: number, step: number, maxDecimals: number) {
  if (!(step > 0)) return Number(value.toFixed(maxDecimals));
  const floored = Math.floor((value + Number.EPSILON) / step) * step;
  const decimals = Math.min(12, Math.max(maxDecimals, decimalPlaces(step)));
  return Number(floored.toFixed(decimals));
}

function priceText(value: number, decimals: number) {
  return value
    .toFixed(Math.min(12, Math.max(0, decimals)))
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

function planAgeMilliseconds(plan: { createdAt: string }) {
  return Math.max(0, Date.now() - new Date(plan.createdAt).getTime());
}

function todayOrderCount(member: string, mode: ExecutionMode) {
  const today = new Date().toISOString().slice(0, 10);
  return journalEntries.filter((entry) => {
    if (entry.memberId !== member) return false;
    if (entry.createdAt.slice(0, 10) !== today) return false;
    if (entry.action !== 'OPEN_LONG' && entry.action !== 'OPEN_SHORT') return false;
    const entryMode = String(entry.details.executionMode ?? 'REAL').toUpperCase();
    if (entryMode !== mode) return false;
    return mode === 'PAPER'
      ? entry.status === 'SIMULATED'
      : entry.status === 'SUCCESS' || entry.status === 'PARTIAL' || entry.status === 'PENDING';
  }).length;
}

function recentEntryForSymbol(member: string, symbol: string, mode: ExecutionMode) {
  const cooldownMinutes = clamp(
    finiteNumber(process.env.CRYPTO_AUTO_TRADE_REENTRY_COOLDOWN_MINUTES, 30),
    0,
    1440,
  );
  if (cooldownMinutes <= 0) return null;
  const cutoff = Date.now() - cooldownMinutes * 60_000;
  return journalEntries.find((entry) => {
    if (entry.memberId !== member || entry.symbol !== symbol) return false;
    if (entry.action !== 'OPEN_LONG' && entry.action !== 'OPEN_SHORT') return false;
    const entryMode = String(entry.details.executionMode ?? 'REAL').toUpperCase();
    if (entryMode !== mode) return false;
    if (!['SUCCESS', 'PARTIAL', 'SIMULATED'].includes(entry.status)) return false;
    return new Date(entry.createdAt).getTime() >= cutoff;
  }) ?? null;
}

function requireExecutionKey(req: Request, res: Response) {
  if (!configuredExecutionKey()) {
    res.status(503).json({ ok: false, message: 'Replit Secrets에 CRYPTO_AUTO_TRADE_KEY가 설정되지 않았습니다.' });
    return false;
  }
  if (!executionKeyValid(req)) {
    res.status(401).json({ ok: false, message: '코인 자동매매 실행키가 올바르지 않습니다.' });
    return false;
  }
  return true;
}

function requireSafety(req: Request, res: Response) {
  if (!credentialsConfigured()) {
    res.status(503).json({ ok: false, message: '비트겟 개인 API 키가 서버 환경변수에 설정되지 않았습니다.' });
    return false;
  }
  return requireExecutionKey(req, res);
}

async function getOrderDetail(symbol: string, orderId: string | null, clientOid: string | null) {
  const query = new URLSearchParams({ symbol, productType: PRODUCT_TYPE });
  if (orderId) query.set('orderId', orderId);
  else if (clientOid) query.set('clientOid', clientOid);
  else throw new Error('주문번호가 없어 체결내역을 확인하지 못했습니다.');
  return bitgetPrivate<OrderDetail>('GET', '/api/v2/mix/order/detail', query.toString());
}

async function waitForOrderDetail(symbol: string, orderId: string | null, clientOid: string | null) {
  let lastDetail: OrderDetail | null = null;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < ORDER_DETAIL_RETRY_COUNT; attempt += 1) {
    try {
      lastDetail = await getOrderDetail(symbol, orderId, clientOid);
      const state = String(lastDetail?.state ?? lastDetail?.status ?? '').toLowerCase();
      const filledSize = finiteNumber(lastDetail?.baseVolume, 0);
      if (state === 'filled' || state === 'canceled' || filledSize > 0) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : '체결내역 조회 실패';
    }
    await sleep(ORDER_DETAIL_RETRY_DELAY_MS);
  }
  return { detail: lastDetail, error: lastError };
}

async function orderFillSummary(symbol: string, orderId: string | null) {
  if (!orderId) return { fills: [] as any[], fees: [] as Array<{ coin: string; amount: number }> };
  try {
    const query = new URLSearchParams({
      productType: PRODUCT_TYPE,
      symbol,
      orderId,
      limit: '100',
    });
    const data = await bitgetPrivate<{ fillList?: any[] }>(
      'GET',
      '/api/v2/mix/order/fills',
      query.toString(),
    );
    const fills = Array.isArray(data?.fillList) ? data.fillList : [];
    const feeMap = new Map<string, number>();
    for (const fill of fills) {
      const feeDetails = Array.isArray(fill?.feeDetail) ? fill.feeDetail : [];
      for (const fee of feeDetails) {
        const coin = String(fee?.feeCoin ?? '').toUpperCase() || 'UNKNOWN';
        const amount = finiteNumber(fee?.totalFee ?? fee?.totalDeductionFee, 0);
        feeMap.set(coin, (feeMap.get(coin) ?? 0) + amount);
      }
    }
    return {
      fills,
      fees: [...feeMap.entries()].map(([coin, amount]) => ({ coin, amount })),
    };
  } catch {
    return { fills: [] as any[], fees: [] as Array<{ coin: string; amount: number }> };
  }
}

function normalizedFill(detail: OrderDetail | null, fallbackPrice: number, fallbackSize: number) {
  const state = String(detail?.state ?? detail?.status ?? 'unknown').toLowerCase();
  const averagePrice = finiteNumber(detail?.priceAvg, fallbackPrice);
  const filledSize = finiteNumber(detail?.baseVolume, 0);
  const requestedSize = finiteNumber(detail?.size, fallbackSize);
  const fillRatio = requestedSize > 0 ? clamp(filledSize / requestedSize, 0, 1) : 0;
  return {
    state,
    averagePrice,
    filledSize,
    requestedSize,
    fillRatio,
    quoteVolume: finiteNumber(detail?.quoteVolume, averagePrice * filledSize),
    exchangeFee: detail?.fee ?? null,
    totalProfits: finiteNumber(detail?.totalProfits, 0),
    exchangeUpdatedAt: detail?.uTime ?? detail?.cTime ?? null,
  };
}

async function syncExchangeState(preferredSymbol = 'BTCUSDT') {
  await ensureRuntimeLoaded();
  if (!credentialsConfigured()) {
    runtimeState = {
      ...runtimeState,
      lastSyncAt: new Date().toISOString(),
      lastSyncError: '비트겟 개인 API 키 미설정',
    };
    await saveRuntime();
    return { positions: [] as ExchangePosition[], account: null as ExchangeAccount | null };
  }
  try {
    const positions = await allPositions();
    const accountSymbol = positions[0]?.symbol || preferredSymbol;
    const account = await singleAccount(accountSymbol);
    runtimeState = {
      ...runtimeState,
      lastSyncAt: new Date().toISOString(),
      lastSyncError: null,
      lastPositionCount: positions.length,
      lastAccountMode: account.posMode,
      lastMarginMode: account.marginMode,
    };
    await saveRuntime();
    return { positions, account };
  } catch (error) {
    runtimeState = {
      ...runtimeState,
      lastSyncAt: new Date().toISOString(),
      lastSyncError: error instanceof Error ? error.message : '거래소 동기화 실패',
    };
    await saveRuntime();
    throw error;
  }
}

router.get('/crypto/futures/auto/status', requireMember, async (req: Request, res: Response) => {
  await Promise.all([ensureJournalLoaded(), ensureRuntimeLoaded()]);
  const member = memberId(req);
  let positions: ExchangePosition[] = [];
  let account: ExchangeAccount | null = null;
  let syncError: string | null = null;
  if (credentialsConfigured()) {
    try {
      const synced = await syncExchangeState(safeSymbol(req.query.symbol) || 'BTCUSDT');
      positions = synced.positions;
      account = synced.account;
    } catch (error) {
      syncError = error instanceof Error ? error.message : '거래소 동기화 실패';
    }
  }
  return res.json({
    ok: true,
    exchange: 'BITGET',
    productType: PRODUCT_TYPE,
    credentialsConfigured: credentialsConfigured(),
    serverTradingEnabled: tradingEnabled(),
    executionKeyConfigured: Boolean(configuredExecutionKey()),
    approvalTtlSeconds: APPROVAL_TTL_MS / 1000,
    killSwitch: runtimeState.killSwitch,
    killSwitchReason: runtimeState.killSwitchReason,
    killSwitchUpdatedAt: runtimeState.killSwitchUpdatedAt,
    lastSyncAt: runtimeState.lastSyncAt,
    lastSyncError: runtimeState.lastSyncError ?? syncError,
    exchangeAccount: account,
    todayRealOrders: todayOrderCount(member, 'REAL'),
    todayPaperOrders: todayOrderCount(member, 'PAPER'),
    positions,
    latestJournal: journalEntries.filter((entry) => entry.memberId === member).slice(0, 20),
    inFlightSymbols: [...inFlightSymbols],
    checks: [
      '거래소 실제 포지션·계정 모드 동기화',
      '긴급정지 상태 영구 저장',
      '모의매매와 실주문 완전 분리',
      '주문별 10분 승인 토큰',
      '계획 생성 후 최대 허용시간',
      '주문 직전 최신 마크가격과 가격변동 검사',
      '실제 포지션 모드 자동 인식',
      '동일 종목 동시주문 잠금',
      '동일 종목 재진입 대기시간',
      'BTC 급락 시 신규 롱 차단',
      '계약 최소수량·최소금액·최대 레버리지',
      '주문 후 평균 체결가·체결수량·수수료 재조회',
    ],
    updatedAt: new Date().toISOString(),
  });
});

router.post('/crypto/futures/auto/verify-key', requireMember, async (req: Request, res: Response) => {
  const configured = configuredExecutionKey();
  if (!configured) {
    return res.status(503).json({
      ok: false,
      verified: false,
      message: 'Replit Secrets에 CRYPTO_AUTO_TRADE_KEY가 설정되지 않았습니다.',
    });
  }
  if (!executionKeyValid(req)) {
    return res.status(401).json({
      ok: false,
      verified: false,
      message: '코인 자동매매 실행키가 서버 보호키와 일치하지 않습니다.',
    });
  }
  return res.json({
    ok: true,
    verified: true,
    message: '코인 자동매매 실행키가 확인됐습니다.',
    checkedAt: new Date().toISOString(),
  });
});

router.post('/crypto/futures/auto/kill-switch', requireMember, async (req: Request, res: Response) => {
  if (!requireExecutionKey(req, res)) return;
  await Promise.all([ensureJournalLoaded(), ensureRuntimeLoaded()]);
  const enabled = Boolean(req.body?.enabled);
  const reason = String(req.body?.reason ?? (enabled ? '사용자 긴급정지' : '사용자 안전정지 해제'))
    .trim()
    .slice(0, 200);
  runtimeState = {
    ...runtimeState,
    killSwitch: enabled,
    killSwitchReason: reason || (enabled ? '사용자 긴급정지' : '사용자 안전정지 해제'),
    killSwitchUpdatedAt: new Date().toISOString(),
  };
  await saveRuntime();
  const entry: JournalEntry = {
    id: randomUUID(),
    memberId: memberId(req),
    action: enabled ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF',
    symbol: 'ALL',
    status: 'SUCCESS',
    orderId: null,
    clientOid: null,
    message: enabled
      ? '긴급정지가 켜졌습니다. 신규 실주문이 즉시 차단됩니다.'
      : '긴급정지가 해제됐습니다. 실주문 서버 스위치와 개별 승인은 계속 필요합니다.',
    details: { enabled, reason: runtimeState.killSwitchReason },
    createdAt: new Date().toISOString(),
  };
  await appendJournal(entry);
  return res.json({ ok: true, killSwitch: runtimeState.killSwitch, journal: entry });
});

router.get('/crypto/futures/auto/journal', requireMember, async (req: Request, res: Response) => {
  await ensureJournalLoaded();
  const limit = clamp(Math.floor(finiteNumber(req.query.limit, 100)), 1, 500);
  const entries = journalEntries.filter((entry) => entry.memberId === memberId(req)).slice(0, limit);
  return res.json({ ok: true, entries, count: entries.length });
});

router.post('/crypto/futures/auto/plan', requireMember, async (req: Request, res: Response) => {
  if (!requireSafety(req, res)) return;
  try {
    await Promise.all([ensureJournalLoaded(), ensureRuntimeLoaded()]);
    const symbol = safeSymbol(req.body?.symbol);
    const direction = String(req.body?.direction ?? '').toUpperCase() as Direction;
    const executionMode = String(req.body?.executionMode ?? 'PAPER').toUpperCase() === 'REAL' ? 'REAL' : 'PAPER';
    const requestedPositionMode = normalizePositionMode(req.body?.positionMode);
    const requestedMarginMode = normalizeMarginMode(req.body?.marginMode);
    const requestedLeverage = Math.floor(finiteNumber(req.body?.leverage, 2));
    const marginAmountUSDT = finiteNumber(req.body?.marginAmountUSDT, 0);
    const score = clamp(finiteNumber(req.body?.score, 0), 0, 100);
    const oppositeScore = clamp(finiteNumber(req.body?.oppositeScore, 0), 0, 100);
    const minScore = clamp(finiteNumber(req.body?.minScore, 70), 50, 95);
    const stopLossPercent = clamp(finiteNumber(req.body?.stopLossPercent, 1.5), 0.2, 15);
    const targetProfitPercent = clamp(finiteNumber(req.body?.targetProfitPercent, 3), 0.2, 50);
    const maxOpenPositions = clamp(Math.floor(finiteNumber(req.body?.maxOpenPositions, 3)), 1, 20);
    const maxDailyOrders = clamp(Math.floor(finiteNumber(req.body?.maxDailyOrders, 5)), 1, 100);
    const btcChangePercent24h = Number.isFinite(Number(req.body?.btcChangePercent24h))
      ? Number(req.body?.btcChangePercent24h)
      : null;
    const reasons = Array.isArray(req.body?.reasons)
      ? req.body.reasons.map((item: unknown) => String(item).slice(0, 120)).filter(Boolean).slice(0, 8)
      : [];

    if (!symbol) return res.status(400).json({ ok: false, message: '코인 심볼이 필요합니다.' });
    if (direction !== 'LONG' && direction !== 'SHORT') {
      return res.status(400).json({ ok: false, message: 'LONG 또는 SHORT 신호만 주문계획을 만들 수 있습니다.' });
    }
    if (!(marginAmountUSDT > 0)) {
      return res.status(400).json({ ok: false, message: '1회 증거금(USDT)을 입력하세요.' });
    }
    if (score < minScore || score - oppositeScore < 10) {
      return res.status(400).json({
        ok: false,
        message: `신호 조건 미달입니다. 선택 신호 ${score.toFixed(0)}점, 반대 신호 ${oppositeScore.toFixed(0)}점, 최소 ${minScore.toFixed(0)}점이 필요합니다.`,
      });
    }

    const btcLongBlockPercent = finiteNumber(process.env.CRYPTO_AUTO_TRADE_BTC_LONG_BLOCK_PERCENT, -5);
    if (direction === 'LONG' && btcChangePercent24h != null && btcChangePercent24h <= btcLongBlockPercent) {
      return res.status(409).json({
        ok: false,
        message: `BTC 24시간 등락률이 ${btcChangePercent24h.toFixed(2)}%로 급락 차단 기준 ${btcLongBlockPercent}% 이하입니다. 신규 롱 계획을 중단했습니다.`,
      });
    }

    const member = memberId(req);
    if (todayOrderCount(member, executionMode) >= maxDailyOrders) {
      return res.status(409).json({
        ok: false,
        message: `${executionMode === 'REAL' ? '실주문' : '모의매매'} 하루 신규 주문 한도 ${maxDailyOrders}회에 도달했습니다.`,
      });
    }
    const recentEntry = recentEntryForSymbol(member, symbol, executionMode);
    if (recentEntry) {
      return res.status(409).json({
        ok: false,
        message: `${symbol} 재진입 대기시간이 적용 중입니다. 마지막 기록 ${new Date(recentEntry.createdAt).toLocaleString('ko-KR')}`,
      });
    }

    const [ticker, config, positions, account] = await Promise.all([
      currentTicker(symbol),
      contractConfig(symbol),
      allPositions(),
      singleAccount(symbol),
    ]);

    if (executionMode === 'REAL' && positions.length >= maxOpenPositions) {
      return res.status(409).json({ ok: false, message: `동시 보유 한도 ${maxOpenPositions}개에 도달했습니다.` });
    }
    const duplicate = positions.find((position) => position.symbol === symbol);
    if (executionMode === 'REAL' && duplicate) {
      return res.status(409).json({
        ok: false,
        message: `${symbol} 실제 포지션이 이미 있습니다. 기존 포지션을 먼저 확인하거나 종료하세요.`,
        position: duplicate,
      });
    }

    const serverMaxLeverage = clamp(
      Math.floor(finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_LEVERAGE, 5)),
      1,
      config.maxLever,
    );
    const leverage = clamp(requestedLeverage, config.minLever, serverMaxLeverage);
    const maxMarginByServer = finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_MARGIN_USDT, 500);
    if (marginAmountUSDT > maxMarginByServer) {
      return res.status(400).json({
        ok: false,
        message: `서버 1회 증거금 상한 ${maxMarginByServer} USDT를 초과했습니다.`,
      });
    }
    if (executionMode === 'REAL' && account.available < marginAmountUSDT) {
      return res.status(400).json({
        ok: false,
        message: `실제 사용가능 USDT ${account.available.toFixed(4)}보다 증거금 ${marginAmountUSDT}가 큽니다.`,
      });
    }

    const notionalUSDT = marginAmountUSDT * leverage;
    const rawSize = notionalUSDT / ticker.markPrice;
    const size = floorToStep(rawSize, config.sizeMultiplier, config.volumePlace);
    if (!(size >= config.minTradeNum)) {
      return res.status(400).json({
        ok: false,
        message: `계산 수량 ${size}가 최소 주문수량 ${config.minTradeNum}보다 작습니다.`,
      });
    }
    if (size > config.maxMarketOrderQty) {
      return res.status(400).json({ ok: false, message: `시장가 최대 수량 ${config.maxMarketOrderQty}를 초과했습니다.` });
    }
    if (size * ticker.markPrice < config.minTradeUSDT) {
      return res.status(400).json({ ok: false, message: `최소 주문금액 ${config.minTradeUSDT} USDT보다 작습니다.` });
    }

    const stopPriceRaw = direction === 'LONG'
      ? ticker.markPrice * (1 - stopLossPercent / 100)
      : ticker.markPrice * (1 + stopLossPercent / 100);
    const targetPriceRaw = direction === 'LONG'
      ? ticker.markPrice * (1 + targetProfitPercent / 100)
      : ticker.markPrice * (1 - targetProfitPercent / 100);
    const stopPrice = Number(priceText(stopPriceRaw, config.pricePlace));
    const targetPrice = Number(priceText(targetPriceRaw, config.pricePlace));

    const plan: OpenPlan = {
      kind: 'OPEN',
      executionMode,
      symbol,
      direction,
      side: direction === 'LONG' ? 'buy' : 'sell',
      tradeSide: account.posMode === 'hedge_mode' ? 'open' : undefined,
      requestedPositionMode,
      requestedMarginMode,
      positionMode: account.posMode,
      marginMode: account.marginMode,
      leverage,
      marginAmountUSDT,
      notionalUSDT,
      currentPrice: ticker.markPrice,
      tickerFetchedAt: new Date(ticker.fetchedAt).toISOString(),
      size,
      sizeText: priceText(size, Math.max(config.volumePlace, decimalPlaces(config.sizeMultiplier))),
      stopPrice,
      targetPrice,
      score,
      oppositeScore,
      minScore,
      btcChangePercent24h,
      reasons,
      createdAt: new Date().toISOString(),
    };
    const approval = issueApproval(member, plan);
    const modeMismatch =
      requestedPositionMode !== account.posMode || requestedMarginMode !== account.marginMode;
    return res.json({
      ok: true,
      approvalRequired: true,
      approvalToken: approval.token,
      approvalExpiresAt: approval.expiresAt,
      plan,
      warning: executionMode === 'PAPER'
        ? '모의매매 계획입니다. 최종 승인해도 비트겟에 실제 주문을 전송하지 않습니다.'
        : modeMismatch
          ? `화면 설정과 실제 거래소 설정이 달라 실제 설정(${account.posMode}/${account.marginMode})을 기준으로 계획했습니다.`
          : '실주문 계획입니다. 종목·방향·수량·레버리지·손절·익절을 다시 확인한 뒤 승인하세요.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '주문계획 생성 실패';
    return res.status(502).json({ ok: false, message });
  }
});

router.post('/crypto/futures/auto/execute', requireMember, async (req: Request, res: Response) => {
  if (!requireSafety(req, res)) return;
  await Promise.all([ensureJournalLoaded(), ensureRuntimeLoaded()]);
  const member = memberId(req);
  let plan: OpenPlan | null = null;
  let lockAcquired = false;
  try {
    plan = consumeApproval(req, 'OPEN') as OpenPlan;

    const maxPlanAgeMs = clamp(
      finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_PLAN_AGE_SECONDS, 120) * 1000,
      15_000,
      APPROVAL_TTL_MS,
    );
    if (planAgeMilliseconds(plan) > maxPlanAgeMs) {
      throw new Error(`주문계획이 ${Math.round(planAgeMilliseconds(plan) / 1000)}초 지나 만료됐습니다. 최신 가격으로 다시 만드세요.`);
    }

    if (inFlightSymbols.has(plan.symbol)) {
      throw new Error(`${plan.symbol} 주문이 이미 처리 중이라 중복 실행을 차단했습니다.`);
    }
    inFlightSymbols.add(plan.symbol);
    lockAcquired = true;

    const ticker = await currentTicker(plan.symbol);
    const slippagePercent = Math.abs(ticker.markPrice - plan.currentPrice) / plan.currentPrice * 100;
    const maxPriceDriftPercent = clamp(
      finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_PRICE_DRIFT_PERCENT, 1),
      0.05,
      5,
    );
    if (slippagePercent > maxPriceDriftPercent) {
      throw new Error(`계획 이후 가격이 ${slippagePercent.toFixed(2)}% 변해 허용치 ${maxPriceDriftPercent}%를 초과했습니다. 계획을 다시 만드세요.`);
    }

    if (plan.executionMode === 'PAPER') {
      const estimatedFeeRate = clamp(
        finiteNumber(process.env.CRYPTO_PAPER_TAKER_FEE_RATE, 0.0006),
        0,
        0.01,
      );
      const simulatedFill = {
        state: 'filled',
        averagePrice: ticker.markPrice,
        filledSize: plan.size,
        requestedSize: plan.size,
        fillRatio: 1,
        quoteVolume: plan.size * ticker.markPrice,
        estimatedFeeUSDT: plan.size * ticker.markPrice * estimatedFeeRate,
      };
      const entry: JournalEntry = {
        id: randomUUID(),
        memberId: member,
        action: plan.direction === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        symbol: plan.symbol,
        status: 'SIMULATED',
        orderId: null,
        clientOid: null,
        message: `${plan.direction === 'LONG' ? '롱' : '숏'} 모의매매가 체결가 기준으로 기록됐습니다. 실제 주문은 전송되지 않았습니다.`,
        details: { ...plan, fill: simulatedFill, executionMode: 'PAPER' },
        createdAt: new Date().toISOString(),
      };
      await appendJournal(entry);
      return res.json({ ok: true, simulated: true, journal: entry });
    }

    if (!tradingEnabled()) {
      throw new Error('서버 실주문 기능이 꺼져 있습니다. CRYPTO_AUTO_TRADE_ENABLED와 BITGET_AUTO_TRADE_ENABLED를 모두 true로 설정해야 합니다.');
    }
    if (runtimeState.killSwitch) {
      throw new Error(`긴급정지가 켜져 있어 실주문을 차단했습니다: ${runtimeState.killSwitchReason}`);
    }

    const [positions, account] = await Promise.all([allPositions(), singleAccount(plan.symbol)]);
    if (positions.some((position) => position.symbol === plan!.symbol)) {
      throw new Error(`${plan.symbol} 포지션이 승인 사이에 새로 생겨 주문을 중단했습니다.`);
    }
    if (account.posMode !== plan.positionMode || account.marginMode !== plan.marginMode) {
      throw new Error(`거래소 설정이 계획 이후 변경됐습니다. 현재 ${account.posMode}/${account.marginMode}, 계획 ${plan.positionMode}/${plan.marginMode}. 계획을 다시 생성하세요.`);
    }
    if (account.available < plan.marginAmountUSDT) {
      throw new Error(`실제 사용가능 USDT ${account.available.toFixed(4)}가 계획 증거금 ${plan.marginAmountUSDT}보다 작습니다.`);
    }

    const leverageBody: Record<string, string> = {
      symbol: plan.symbol,
      productType: PRODUCT_TYPE,
      marginCoin: MARGIN_COIN,
      leverage: String(plan.leverage),
    };
    if (plan.positionMode === 'hedge_mode' && plan.marginMode === 'isolated') {
      leverageBody.holdSide = plan.direction === 'LONG' ? 'long' : 'short';
    }
    await bitgetPrivate('POST', '/api/v2/mix/account/set-leverage', '', leverageBody);

    const clientOid = `lsj119-${Date.now()}-${randomBytes(5).toString('hex')}`;
    const orderBody: Record<string, string> = {
      symbol: plan.symbol,
      productType: PRODUCT_TYPE,
      marginMode: plan.marginMode,
      marginCoin: MARGIN_COIN,
      size: plan.sizeText,
      side: plan.side,
      orderType: 'market',
      clientOid,
      presetStopSurplusPrice: String(plan.targetPrice),
      presetStopLossPrice: String(plan.stopPrice),
      stpMode: 'cancel_taker',
    };
    if (plan.positionMode === 'hedge_mode') orderBody.tradeSide = 'open';
    else orderBody.reduceOnly = 'NO';

    const result = await bitgetPrivate<{ orderId?: string; clientOid?: string }>(
      'POST',
      '/api/v2/mix/order/place-order',
      '',
      orderBody,
    );
    const orderId = String(result?.orderId ?? '') || null;
    const returnedClientOid = String(result?.clientOid ?? clientOid) || clientOid;
    const confirmation = await waitForOrderDetail(plan.symbol, orderId, returnedClientOid);
    const fill = normalizedFill(confirmation.detail, ticker.markPrice, plan.size);
    const fills = await orderFillSummary(plan.symbol, orderId);
    const status: JournalStatus = fill.state === 'filled'
      ? 'SUCCESS'
      : fill.filledSize > 0
        ? 'PARTIAL'
        : fill.state === 'canceled'
          ? 'FAILED'
          : 'PENDING';
    const message = status === 'SUCCESS'
      ? `${plan.direction === 'LONG' ? '롱' : '숏'} 주문이 전량 체결됐습니다. 평균 체결가 ${fill.averagePrice}.`
      : status === 'PARTIAL'
        ? `${plan.direction === 'LONG' ? '롱' : '숏'} 주문이 일부 체결됐습니다. 실제 포지션을 즉시 확인하세요.`
        : status === 'PENDING'
          ? `${plan.direction === 'LONG' ? '롱' : '숏'} 주문은 접수됐지만 체결 확인이 지연되고 있습니다. 거래소 실제 포지션 동기화를 확인하세요.`
          : `${plan.direction === 'LONG' ? '롱' : '숏'} 주문이 취소됐거나 체결되지 않았습니다.`;

    const entry: JournalEntry = {
      id: randomUUID(),
      memberId: member,
      action: plan.direction === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
      symbol: plan.symbol,
      status,
      orderId,
      clientOid: returnedClientOid,
      message,
      details: {
        ...plan,
        executionMode: 'REAL',
        preExecutionMarkPrice: ticker.markPrice,
        priceDriftPercent: slippagePercent,
        fill,
        fees: fills.fees,
        fillCount: fills.fills.length,
        confirmationError: confirmation.error,
      },
      createdAt: new Date().toISOString(),
    };
    await appendJournal(entry);
    const synced = await syncExchangeState(plan.symbol).catch(() => null);
    return res.status(status === 'PENDING' ? 202 : 200).json({
      ok: status !== 'FAILED',
      pendingConfirmation: status === 'PENDING',
      order: result,
      fill,
      fees: fills.fees,
      positions: synced?.positions ?? null,
      journal: entry,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '주문 실행 실패';
    if (plan) {
      await appendJournal({
        id: randomUUID(),
        memberId: member,
        action: plan.direction === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        symbol: plan.symbol,
        status: 'FAILED',
        orderId: null,
        clientOid: null,
        message,
        details: { ...plan, executionMode: plan.executionMode },
        createdAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
    return res.status(502).json({ ok: false, message });
  } finally {
    if (lockAcquired && plan) inFlightSymbols.delete(plan.symbol);
  }
});

router.post('/crypto/futures/auto/close-plan', requireMember, async (req: Request, res: Response) => {
  if (!requireSafety(req, res)) return;
  try {
    await ensureRuntimeLoaded();
    const symbol = safeSymbol(req.body?.symbol);
    const requestedHoldSide = String(req.body?.holdSide ?? '').toLowerCase();
    if (!symbol) return res.status(400).json({ ok: false, message: '종료할 코인 심볼이 필요합니다.' });

    const [positions, account] = await Promise.all([allPositions(), singleAccount(symbol)]);
    const position = positions.find((row) => {
      if (row.symbol !== symbol) return false;
      if (account.posMode === 'one_way_mode') return true;
      return row.holdSide === requestedHoldSide;
    });
    if (!position) return res.status(404).json({ ok: false, message: '종료할 실제 포지션을 찾지 못했습니다.' });

    const plan: ClosePlan = {
      kind: 'CLOSE',
      symbol,
      holdSide: account.posMode === 'hedge_mode'
        ? position.holdSide === 'short' ? 'short' : 'long'
        : null,
      positionMode: account.posMode,
      positionSize: Math.abs(position.total),
      markPrice: position.markPrice || null,
      unrealizedPL: position.unrealizedPL,
      reason: String(req.body?.reason ?? '사용자 수동 종료').slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    const approval = issueApproval(memberId(req), plan);
    return res.json({
      ok: true,
      approvalRequired: true,
      approvalToken: approval.token,
      approvalExpiresAt: approval.expiresAt,
      plan,
      warning: '아직 종료되지 않았습니다. 실제 거래소 포지션 방향과 수량을 확인한 뒤 승인하세요.',
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : '종료계획 생성 실패',
    });
  }
});

router.post('/crypto/futures/auto/close', requireMember, async (req: Request, res: Response) => {
  if (!requireSafety(req, res)) return;
  await ensureRuntimeLoaded();
  if (!tradingEnabled()) {
    return res.status(409).json({ ok: false, message: '서버 실주문 기능이 꺼져 있습니다.' });
  }

  const member = memberId(req);
  let plan: ClosePlan | null = null;
  let lockAcquired = false;
  try {
    plan = consumeApproval(req, 'CLOSE') as ClosePlan;
    if (inFlightSymbols.has(plan.symbol)) {
      throw new Error(`${plan.symbol} 주문이 이미 처리 중이라 중복 종료를 차단했습니다.`);
    }
    inFlightSymbols.add(plan.symbol);
    lockAcquired = true;

    const positions = await allPositions();
    const current = positions.find((row) => {
      if (row.symbol !== plan!.symbol) return false;
      if (plan!.positionMode === 'one_way_mode') return true;
      return row.holdSide === plan!.holdSide;
    });
    if (!current) throw new Error('승인 사이에 포지션이 없어졌습니다. 거래소 상태를 다시 확인하세요.');

    const body: Record<string, string> = {
      symbol: plan.symbol,
      productType: PRODUCT_TYPE,
    };
    if (plan.positionMode === 'hedge_mode' && plan.holdSide) body.holdSide = plan.holdSide;
    const result = await bitgetPrivate<{
      successList?: Array<{ orderId?: string; clientOid?: string; symbol?: string }>;
      failureList?: Array<{ orderId?: string; clientOid?: string; symbol?: string; errorMsg?: string; errorCode?: string }>;
    }>('POST', '/api/v2/mix/order/close-positions', '', body);

    const first = Array.isArray(result?.successList) ? result.successList[0] : null;
    if (!first && Array.isArray(result?.failureList) && result.failureList.length) {
      const failure = result.failureList[0];
      throw new Error(`BITGET_${String(failure.errorCode ?? 'CLOSE_FAILED')}:${String(failure.errorMsg ?? '포지션 종료 실패')}`);
    }
    const orderId = String(first?.orderId ?? '') || null;
    const clientOid = String(first?.clientOid ?? '') || null;
    const confirmation = orderId || clientOid
      ? await waitForOrderDetail(plan.symbol, orderId, clientOid)
      : { detail: null, error: '종료 주문번호 미반환' };
    const fill = normalizedFill(confirmation.detail, current.markPrice || plan.markPrice || 0, Math.abs(current.total));
    const fills = await orderFillSummary(plan.symbol, orderId);
    const action = plan.holdSide === 'long'
      ? 'CLOSE_LONG'
      : plan.holdSide === 'short'
        ? 'CLOSE_SHORT'
        : 'CLOSE_ALL';
    const entry: JournalEntry = {
      id: randomUUID(),
      memberId: member,
      action,
      symbol: plan.symbol,
      status: fill.state === 'filled' || !confirmation.detail ? 'SUCCESS' : fill.filledSize > 0 ? 'PARTIAL' : 'SUCCESS',
      orderId,
      clientOid,
      message: confirmation.detail
        ? `포지션 종료가 처리됐습니다. 평균 체결가 ${fill.averagePrice}.`
        : '포지션 종료 요청이 접수됐습니다. 거래소 실제 포지션 동기화 결과를 확인하세요.',
      details: { ...plan, fill, fees: fills.fees, confirmationError: confirmation.error },
      createdAt: new Date().toISOString(),
    };
    await appendJournal(entry);
    const synced = await syncExchangeState(plan.symbol).catch(() => null);
    return res.json({ ok: true, result, fill, fees: fills.fees, positions: synced?.positions ?? null, journal: entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : '포지션 종료 실패';
    if (plan) {
      await appendJournal({
        id: randomUUID(),
        memberId: member,
        action: plan.holdSide === 'long' ? 'CLOSE_LONG' : plan.holdSide === 'short' ? 'CLOSE_SHORT' : 'CLOSE_ALL',
        symbol: plan.symbol,
        status: 'FAILED',
        orderId: null,
        clientOid: null,
        message,
        details: plan,
        createdAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
    return res.status(502).json({ ok: false, message });
  } finally {
    if (lockAcquired && plan) inFlightSymbols.delete(plan.symbol);
  }
});

router.post('/crypto/futures/auto/configure-plan', requireMember, async (req: Request, res: Response) => {
  if (!requireSafety(req, res)) return;
  try {
    const symbol = safeSymbol(req.body?.symbol);
    const positionMode = normalizePositionMode(req.body?.positionMode);
    const marginMode = normalizeMarginMode(req.body?.marginMode);
    const leverage = clamp(Math.floor(finiteNumber(req.body?.leverage, 2)), 1, 125);
    if (!symbol) return res.status(400).json({ ok: false, message: '코인 심볼이 필요합니다.' });

    const [positions, orders, account] = await Promise.all([
      allPositions(),
      pendingOrders(),
      singleAccount(symbol),
    ]);
    if (positions.length || orders.length) {
      return res.status(409).json({
        ok: false,
        message: '포지션 모드·마진 모드는 실제 보유 포지션과 미체결 주문이 모두 없을 때만 바꿀 수 있습니다.',
        positions,
        pendingOrders: orders,
      });
    }

    const plan: ConfigurePlan = {
      kind: 'CONFIGURE',
      symbol,
      currentPositionMode: account.posMode,
      currentMarginMode: account.marginMode,
      positionMode,
      marginMode,
      leverage,
      pendingOrderCount: orders.length,
      createdAt: new Date().toISOString(),
    };
    const approval = issueApproval(memberId(req), plan);
    return res.json({
      ok: true,
      approvalRequired: true,
      approvalToken: approval.token,
      approvalExpiresAt: approval.expiresAt,
      plan,
      warning: '거래소 설정 변경은 주문이 아닙니다. USDT 선물 상품군의 실제 포지션 모드와 해당 심볼의 마진·레버리지 설정을 바꿉니다.',
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : '설정계획 생성 실패',
    });
  }
});

router.post('/crypto/futures/auto/configure', requireMember, async (req: Request, res: Response) => {
  if (!requireSafety(req, res)) return;
  if (!tradingEnabled()) {
    return res.status(409).json({ ok: false, message: '서버 실주문 기능이 꺼져 있습니다.' });
  }
  const member = memberId(req);
  let plan: ConfigurePlan | null = null;
  try {
    plan = consumeApproval(req, 'CONFIGURE') as ConfigurePlan;
    const [positions, orders, accountBefore, config] = await Promise.all([
      allPositions(),
      pendingOrders(),
      singleAccount(plan.symbol),
      contractConfig(plan.symbol),
    ]);
    if (positions.length || orders.length) {
      throw new Error('승인 사이에 포지션 또는 미체결 주문이 생겨 설정 변경을 중단했습니다.');
    }
    const serverMaxLeverage = clamp(
      Math.floor(finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_LEVERAGE, 5)),
      1,
      config.maxLever,
    );
    const leverage = clamp(plan.leverage, config.minLever, serverMaxLeverage);

    if (accountBefore.posMode !== plan.positionMode) {
      await bitgetPrivate('POST', '/api/v2/mix/account/set-position-mode', '', {
        productType: PRODUCT_TYPE,
        posMode: plan.positionMode,
      });
    }
    if (accountBefore.marginMode !== plan.marginMode) {
      await bitgetPrivate('POST', '/api/v2/mix/account/set-margin-mode', '', {
        symbol: plan.symbol,
        productType: PRODUCT_TYPE,
        marginCoin: MARGIN_COIN,
        marginMode: plan.marginMode,
      });
    }
    await bitgetPrivate('POST', '/api/v2/mix/account/set-leverage', '', {
      symbol: plan.symbol,
      productType: PRODUCT_TYPE,
      marginCoin: MARGIN_COIN,
      leverage: String(leverage),
    });
    const accountAfter = await singleAccount(plan.symbol);
    const entry: JournalEntry = {
      id: randomUUID(),
      memberId: member,
      action: 'CONFIGURE',
      symbol: plan.symbol,
      status: 'SUCCESS',
      orderId: null,
      clientOid: null,
      message: `비트겟 설정을 적용했습니다. 현재 ${accountAfter.posMode}/${accountAfter.marginMode}, 레버리지 ${leverage}배.`,
      details: { ...plan, leverage, accountBefore, accountAfter },
      createdAt: new Date().toISOString(),
    };
    await appendJournal(entry);
    await syncExchangeState(plan.symbol).catch(() => undefined);
    return res.json({ ok: true, account: accountAfter, journal: entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : '거래소 설정 실패';
    if (plan) {
      await appendJournal({
        id: randomUUID(),
        memberId: member,
        action: 'CONFIGURE',
        symbol: plan.symbol,
        status: 'FAILED',
        orderId: null,
        clientOid: null,
        message,
        details: plan,
        createdAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
    return res.status(502).json({ ok: false, message });
  }
});

export default router;
import { Router, type IRouter, type Request } from 'express';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requireAdmin, requireMember } from '../middleware/auth';
import {
  deriveStagedTradeAllocation,
  parseTradeStage,
  stageAmount,
  type StagedTradeAllocation,
  type TradeStage,
} from '../services/staged-trade.service';

const router: IRouter = Router();
const BITGET_BASE = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';
const APPROVAL_TTL_MS = 10 * 60_000;
const JOURNAL_LIMIT = 1000;

type Direction = 'LONG' | 'SHORT';
type PositionMode = 'one_way_mode' | 'hedge_mode';
type MarginMode = 'isolated' | 'crossed';
type ApprovalKind = 'OPEN' | 'CLOSE' | 'CONFIGURE';

type OpenPlan = {
  kind: 'OPEN';
  symbol: string;
  direction: Direction;
  side: 'buy' | 'sell';
  tradeSide?: 'open';
  positionMode: PositionMode;
  marginMode: MarginMode;
  leverage: number;
  totalMarginAmountUSDT: number;
  marginAmountUSDT: number;
  notionalUSDT: number;
  currentPrice: number;
  size: number;
  sizeText: string;
  stopPrice: number;
  targetPrice: number;
  score: number;
  oppositeScore: number;
  minScore: number;
  reasons: string[];
  sequenceId: string;
  stage: TradeStage;
  stageRatio: number;
  allocation: StagedTradeAllocation;
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
  positionMode: PositionMode;
  marginMode: MarginMode;
  leverage: number;
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
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT' | 'CLOSE_ALL' | 'CONFIGURE';
  symbol: string;
  status: 'SUCCESS' | 'FAILED';
  orderId: string | null;
  clientOid: string | null;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
};

const approvals = new Map<string, ApprovalRecord>();
let journalLoaded = false;
let journalEntries: JournalEntry[] = [];
let journalWriteQueue = Promise.resolve();

function storageDirectory() {
  const cwd = process.cwd();
  return path.basename(cwd) === 'api-server'
    ? path.join(cwd, 'data')
    : path.join(cwd, 'api-server', 'data');
}

function journalFile() {
  return path.join(storageDirectory(), 'crypto-auto-journal.json');
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
      JSON.stringify({ version: 1, entries: journalEntries.slice(0, JOURNAL_LIMIT) }, null, 2),
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

  if (quoted && normalized.length >= 2) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}

function configuredExecutionKey() {
  return normalizeExecutionKey(
    process.env.CRYPTO_AUTO_TRADE_KEY ??
      process.env.KIWOOM_AUTO_TRADE_KEY ??
      '',
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
    req.header('X-Crypto-Auto-Trade-Key') ??
      req.header('X-Auto-Trade-Key') ??
      '',
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
  if (!record) throw new Error('승인 토큰이 없거나 만료됐습니다. 주문계획을 다시 생성하세요.');
  if (record.used) throw new Error('이미 사용된 승인 토큰입니다.');
  if (record.kind !== expectedKind) throw new Error('승인 토큰의 작업 종류가 일치하지 않습니다.');
  if (record.memberId !== memberId(req)) throw new Error('다른 사용자의 승인 토큰입니다.');
  if (record.expiresAt <= Date.now()) {
    approvals.delete(token);
    throw new Error('승인 토큰이 만료됐습니다. 주문계획을 다시 생성하세요.');
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
    'User-Agent': 'seungjae-investment-app/1.0',
  };
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
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
    { headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/1.0' } },
  );
  if (String(payload.code ?? '') !== '00000') {
    throw new Error(`BITGET_${String(payload.code ?? 'INVALID')}:${String(payload.msg ?? '요청 실패')}`);
  }
  return payload.data as T;
}

async function currentTicker(symbol: string) {
  const rows = await bitgetPublic<any[]>(
    '/api/v2/mix/market/ticker',
    `symbol=${encodeURIComponent(symbol)}&productType=${PRODUCT_TYPE}`,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  const price = finiteNumber(row?.markPrice ?? row?.lastPr, 0);
  if (!(price > 0)) throw new Error('현재가를 확인하지 못했습니다.');
  return {
    price,
    lastPrice: finiteNumber(row?.lastPr, price),
    markPrice: finiteNumber(row?.markPrice, price),
    indexPrice: finiteNumber(row?.indexPrice, price),
    fundingRate: finiteNumber(row?.fundingRate, 0),
  };
}

async function recentBitgetRiskMetrics(symbol: string) {
  const rows = await bitgetPublic<unknown[][]>(
    '/api/v2/mix/market/candles',
    `symbol=${encodeURIComponent(symbol)}&productType=${PRODUCT_TYPE}&granularity=1H&limit=80`,
  );
  const candles = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      time: finiteNumber(row?.[0], 0),
      high: finiteNumber(row?.[2], 0),
      low: finiteNumber(row?.[3], 0),
      close: finiteNumber(row?.[4], 0),
    }))
    .filter((row) => row.time > 0 && row.high > 0 && row.low > 0 && row.close > 0)
    .sort((a, b) => a.time - b.time)
    .slice(-80);
  if (candles.length < 20) throw new Error('분할 비율 산정에 필요한 실제 1시간봉이 20개 미만입니다.');
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  const recentRanges = ranges.slice(-14);
  const atr = recentRanges.reduce((sum, value) => sum + value, 0) / recentRanges.length;
  const latestClose = candles.at(-1)?.close ?? 0;
  const volatilityPercent = latestClose > 0 ? atr / latestClose * 100 : 0;
  return {
    volatilityPercent,
    dataCompleteness: Math.min(100, Math.round(candles.length / 60 * 100)),
    candleCount: candles.length,
  };
}

async function contractConfig(symbol: string) {
  const rows = await bitgetPublic<any[]>(
    '/api/v2/mix/market/contracts',
    `productType=${PRODUCT_TYPE}&symbol=${encodeURIComponent(symbol)}`,
  );
  const row = Array.isArray(rows) ? rows.find((item) => String(item?.symbol ?? '').toUpperCase() === symbol) ?? rows[0] : null;
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
  return value.toFixed(Math.min(12, Math.max(0, decimals))).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

async function allPositions() {
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
      leverage: finiteNumber(row?.leverage, 0),
      marginMode: String(row?.marginMode ?? ''),
    }))
    .filter((row) => row.total !== 0);
}

function todayOrderCount(member: string) {
  const today = new Date().toISOString().slice(0, 10);
  return journalEntries.filter((entry) =>
    entry.memberId === member &&
    entry.status === 'SUCCESS' &&
    (entry.action === 'OPEN_LONG' || entry.action === 'OPEN_SHORT') &&
    entry.createdAt.slice(0, 10) === today,
  ).length;
}

function completedOpenStages(member: string, sequenceId: string) {
  return new Set(
    journalEntries
      .filter((entry) => entry.memberId === member && entry.status === 'SUCCESS')
      .filter((entry) => String(entry.details?.sequenceId ?? '') === sequenceId)
      .map((entry) => Number(entry.details?.stage))
      .filter((stage): stage is TradeStage => stage === 1 || stage === 2 || stage === 3),
  );
}

function requireSafety(req: Request, res: any) {
  if (!credentialsConfigured()) {
    res.status(503).json({ ok: false, message: '비트겟 개인 API 키가 서버 환경변수에 설정되지 않았습니다.' });
    return false;
  }
  if (!executionKeyValid(req)) {
    res.status(401).json({ ok: false, message: '코인 자동매매 실행키가 올바르지 않습니다.' });
    return false;
  }
  return true;
}

router.get('/crypto/futures/auto/status', requireMember, requireAdmin, async (req, res) => {
  await ensureJournalLoaded();
  const member = memberId(req);
  let positions: Awaited<ReturnType<typeof allPositions>> = [];
  let positionError: string | null = null;
  if (credentialsConfigured()) {
    try {
      positions = await allPositions();
    } catch (error) {
      positionError = error instanceof Error ? error.message : '포지션 조회 실패';
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
    todayOrders: todayOrderCount(member),
    positions,
    positionError,
    latestJournal: journalEntries.filter((entry) => entry.memberId === member).slice(0, 10),
    checks: [
      '서버 주문 기능 켜짐 여부',
      '실행키 일치',
      '주문별 10분 승인 토큰',
      '롱·숏 최소 점수',
      '반대 신호 점수 차이',
      '계약 최소수량·수량단위',
      '최소 주문금액',
      '최대 레버리지',
      '동시 보유 수',
      '동일 종목 중복 포지션',
      '하루 주문 횟수',
      '주문 직전 마크가격',
    ],
    updatedAt: new Date().toISOString(),
  });
});

router.post('/crypto/futures/auto/verify-key', requireMember, requireAdmin, async (req, res) => {
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

router.get('/crypto/futures/auto/journal', requireMember, requireAdmin, async (req, res) => {
  await ensureJournalLoaded();
  const limit = clamp(Math.floor(finiteNumber(req.query.limit, 100)), 1, 500);
  const entries = journalEntries.filter((entry) => entry.memberId === memberId(req)).slice(0, limit);
  return res.json({ ok: true, entries, count: entries.length });
});

router.post('/crypto/futures/auto/plan', requireMember, requireAdmin, async (req, res) => {
  if (!requireSafety(req, res)) return;
  try {
    const symbol = safeSymbol(req.body?.symbol);
    const direction = String(req.body?.direction ?? '').toUpperCase() as Direction;
    const positionMode = String(req.body?.positionMode ?? 'one_way_mode') as PositionMode;
    const marginMode = String(req.body?.marginMode ?? 'isolated') as MarginMode;
    const requestedLeverage = Math.floor(finiteNumber(req.body?.leverage, 2));
    const totalMarginAmountUSDT = finiteNumber(req.body?.totalMarginAmountUSDT ?? req.body?.marginAmountUSDT, 0);
    const stage = parseTradeStage(req.body?.stage ?? 1);
    const score = clamp(finiteNumber(req.body?.score, 0), 0, 100);
    const oppositeScore = clamp(finiteNumber(req.body?.oppositeScore, 0), 0, 100);
    const minScore = clamp(finiteNumber(req.body?.minScore, 70), 50, 95);
    const stopLossPercent = clamp(finiteNumber(req.body?.stopLossPercent, 1.5), 0.2, 15);
    const targetProfitPercent = clamp(finiteNumber(req.body?.targetProfitPercent, 3), 0.2, 50);
    const maxOpenPositions = clamp(Math.floor(finiteNumber(req.body?.maxOpenPositions, 3)), 1, 20);
    const maxDailyOrders = clamp(Math.floor(finiteNumber(req.body?.maxDailyOrders, 5)), 1, 100);
    const reasons = Array.isArray(req.body?.reasons)
      ? req.body.reasons.map((item: unknown) => String(item).slice(0, 120)).filter(Boolean).slice(0, 8)
      : [];

    if (!symbol) return res.status(400).json({ ok: false, message: '코인 심볼이 필요합니다.' });
    if (direction !== 'LONG' && direction !== 'SHORT') {
      return res.status(400).json({ ok: false, message: 'LONG 또는 SHORT 신호만 주문계획을 만들 수 있습니다.' });
    }
    if (!['one_way_mode', 'hedge_mode'].includes(positionMode)) {
      return res.status(400).json({ ok: false, message: '포지션 모드가 올바르지 않습니다.' });
    }
    if (!['isolated', 'crossed'].includes(marginMode)) {
      return res.status(400).json({ ok: false, message: '마진 모드가 올바르지 않습니다.' });
    }
    if (!(totalMarginAmountUSDT > 0)) {
		return res.status(400).json({ ok: false, message: '총 진입금액(USDT)을 입력하세요.' });
    }
    if (!stage) return res.status(400).json({ ok: false, message: '진입 단계는 1, 2, 3 중 하나여야 합니다.' });
    if (score < minScore || score - oppositeScore < 10) {
      return res.status(400).json({
        ok: false,
        message: `신호 조건 미달입니다. 선택 신호 ${score.toFixed(0)}점, 반대 신호 ${oppositeScore.toFixed(0)}점, 최소 ${minScore.toFixed(0)}점이 필요합니다.`,
      });
    }

    const member = memberId(req);
    await ensureJournalLoaded();
    if (todayOrderCount(member) >= maxDailyOrders) {
      return res.status(409).json({ ok: false, message: `하루 신규 주문 한도 ${maxDailyOrders}회에 도달했습니다.` });
    }

    const [ticker, config, positions, chartMetrics] = await Promise.all([
      currentTicker(symbol),
      contractConfig(symbol),
      allPositions(),
      recentBitgetRiskMetrics(symbol),
    ]);

	const requestedSequenceId = String(req.body?.sequenceId ?? '').trim();
	const sequenceId = stage === 1 ? randomUUID() : requestedSequenceId;
	if (!sequenceId) return res.status(400).json({ ok: false, message: '2·3차 진입은 1차 계획의 sequenceId가 필요합니다.' });
	const completed = completedOpenStages(member, sequenceId);
	if (stage > 1 && !completed.has((stage - 1) as TradeStage)) {
	  return res.status(409).json({ ok: false, message: `${stage - 1}차 주문 성공 기록이 없어 ${stage}차 계획을 만들 수 없습니다.` });
	}
	if (completed.has(stage)) return res.status(409).json({ ok: false, message: `${stage}차 주문이 이미 성공한 순서입니다.` });

    if (stage === 1 && positions.length >= maxOpenPositions) {
      return res.status(409).json({ ok: false, message: `동시 보유 한도 ${maxOpenPositions}개에 도달했습니다.` });
    }
    const duplicate = positions.find((position) => position.symbol === symbol);
	if (stage === 1 && duplicate) {
      return res.status(409).json({
        ok: false,
        message: `${symbol} 포지션이 이미 있습니다. 기존 포지션을 먼저 확인하거나 종료하세요.`,
        position: duplicate,
      });
    }
	if (stage > 1 && (!duplicate || (duplicate.holdSide && duplicate.holdSide !== (direction === 'LONG' ? 'long' : 'short')))) {
	  return res.status(409).json({ ok: false, message: `${stage}차 진입에 필요한 같은 방향의 기존 포지션을 확인하지 못했습니다.` });
	}

    const serverMaxLeverage = clamp(Math.floor(finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_LEVERAGE, 5)), 1, config.maxLever);
    const leverage = clamp(requestedLeverage, config.minLever, serverMaxLeverage);
    const maxMarginByServer = finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_MARGIN_USDT, 500);
    if (totalMarginAmountUSDT > maxMarginByServer) {
      return res.status(400).json({ ok: false, message: `서버 1회 증거금 상한 ${maxMarginByServer} USDT를 초과했습니다.` });
    }

    const serverRiskScore = clamp(
      Math.round(15 + chartMetrics.volatilityPercent * 9 + Math.abs(ticker.fundingRate) * 10_000),
      0,
      100,
    );
    const allocation = deriveStagedTradeAllocation({
      confidenceScore: score,
      oppositeScore,
      riskScore: serverRiskScore,
      dataCompleteness: chartMetrics.dataCompleteness,
      volatilityPercent: chartMetrics.volatilityPercent,
    });
    if (!allocation.available) {
      return res.status(409).json({ ok: false, message: `분할 비율 산출 불가: ${allocation.reason}` });
    }
    const marginAmountUSDT = stageAmount(totalMarginAmountUSDT, allocation.entryRatios, stage);
    if (!(marginAmountUSDT > 0)) return res.status(409).json({ ok: false, message: '해당 단계의 진입금액을 계산하지 못했습니다.' });

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
      symbol,
      direction,
      side: direction === 'LONG' ? 'buy' : 'sell',
      tradeSide: positionMode === 'hedge_mode' ? 'open' : undefined,
      positionMode,
      marginMode,
      leverage,
      totalMarginAmountUSDT,
      marginAmountUSDT,
      notionalUSDT,
      currentPrice: ticker.markPrice,
      size,
      sizeText: priceText(size, Math.max(config.volumePlace, decimalPlaces(config.sizeMultiplier))),
      stopPrice,
      targetPrice,
      score,
      oppositeScore,
      minScore,
      reasons,
      sequenceId,
      stage,
      stageRatio: allocation.entryRatios[stage - 1],
      allocation,
      createdAt: new Date().toISOString(),
    };
    const approval = issueApproval(member, plan);
    return res.json({
      ok: true,
      approvalRequired: true,
      approvalToken: approval.token,
      approvalExpiresAt: approval.expiresAt,
      plan,
      warning: '아직 주문되지 않았습니다. 종목·방향·수량·레버리지·손절·익절을 확인한 뒤 승인해야 주문됩니다.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '주문계획 생성 실패';
    return res.status(502).json({ ok: false, message });
  }
});

router.post('/crypto/futures/auto/execute', requireMember, requireAdmin, async (req, res) => {
  if (!requireSafety(req, res)) return;
  if (!tradingEnabled()) {
    return res.status(409).json({
      ok: false,
      message: '서버 실주문 기능이 꺼져 있습니다. CRYPTO_AUTO_TRADE_ENABLED와 BITGET_AUTO_TRADE_ENABLED를 모두 true로 설정해야 합니다.',
    });
  }

  const member = memberId(req);
  let plan: OpenPlan | null = null;
  try {
    plan = consumeApproval(req, 'OPEN') as OpenPlan;
    const [ticker, positions] = await Promise.all([currentTicker(plan.symbol), allPositions()]);
	const existingPosition = positions.find((position) => position.symbol === plan!.symbol);
    if (plan.stage === 1 && existingPosition) {
      throw new Error(`${plan.symbol} 포지션이 주문 승인 사이에 새로 생겨 주문을 중단했습니다.`);
    }
	const completed = completedOpenStages(member, plan.sequenceId);
	if (plan.stage > 1 && (!completed.has((plan.stage - 1) as TradeStage) || !existingPosition)) {
	  throw new Error(`${plan.stage}차 진입 순서 또는 기존 포지션이 확인되지 않아 주문을 중단했습니다.`);
	}
	if (completed.has(plan.stage)) throw new Error('같은 분할 단계의 중복 주문을 중단했습니다.');
    const slippagePercent = Math.abs(ticker.markPrice - plan.currentPrice) / plan.currentPrice * 100;
    if (slippagePercent > 1) {
      throw new Error(`주문계획 이후 가격이 ${slippagePercent.toFixed(2)}% 변해 주문을 중단했습니다. 계획을 다시 생성하세요.`);
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

    const clientOid = `lsj119-${Date.now()}-${randomBytes(4).toString('hex')}`;
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
    };
    if (plan.positionMode === 'hedge_mode') orderBody.tradeSide = 'open';
    else orderBody.reduceOnly = 'NO';

    const result = await bitgetPrivate<{ orderId?: string; clientOid?: string }>(
      'POST',
      '/api/v2/mix/order/place-order',
      '',
      orderBody,
    );

    const entry: JournalEntry = {
      id: randomUUID(),
      memberId: member,
      action: plan.direction === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
      symbol: plan.symbol,
      status: 'SUCCESS',
      orderId: String(result?.orderId ?? '') || null,
      clientOid: String(result?.clientOid ?? clientOid) || null,
      message: `${plan.direction === 'LONG' ? '롱' : '숏'} 시장가 주문이 전송됐습니다.`,
      details: { ...plan, executionPrice: ticker.markPrice },
      createdAt: new Date().toISOString(),
    };
    await appendJournal(entry);
    return res.json({ ok: true, order: result, journal: entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : '주문 전송 실패';
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
        details: plan,
        createdAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
    return res.status(502).json({ ok: false, message });
  }
});

router.post('/crypto/futures/auto/close-plan', requireMember, requireAdmin, async (req, res) => {
  if (!requireSafety(req, res)) return;
  try {
    const symbol = safeSymbol(req.body?.symbol);
    const positionMode = String(req.body?.positionMode ?? 'one_way_mode') as PositionMode;
    const requestedHoldSide = String(req.body?.holdSide ?? '').toLowerCase();
    if (!symbol) return res.status(400).json({ ok: false, message: '종료할 코인 심볼이 필요합니다.' });
    if (!['one_way_mode', 'hedge_mode'].includes(positionMode)) {
      return res.status(400).json({ ok: false, message: '포지션 모드가 올바르지 않습니다.' });
    }
    const positions = await allPositions();
    const position = positions.find((row) => {
      if (row.symbol !== symbol) return false;
      if (positionMode === 'one_way_mode') return true;
      return row.holdSide === requestedHoldSide;
    });
    if (!position) return res.status(404).json({ ok: false, message: '종료할 포지션을 찾지 못했습니다.' });

    const plan: ClosePlan = {
      kind: 'CLOSE',
      symbol,
      holdSide: positionMode === 'hedge_mode'
        ? (position.holdSide === 'short' ? 'short' : 'long')
        : null,
      positionMode,
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
      warning: '아직 종료되지 않았습니다. 포지션 방향과 수량을 확인한 뒤 승인하세요.',
    });
  } catch (error) {
    return res.status(502).json({ ok: false, message: error instanceof Error ? error.message : '종료계획 생성 실패' });
  }
});

router.post('/crypto/futures/auto/close', requireMember, requireAdmin, async (req, res) => {
  if (!requireSafety(req, res)) return;
  if (!tradingEnabled()) {
    return res.status(409).json({ ok: false, message: '서버 실주문 기능이 꺼져 있습니다.' });
  }

  const member = memberId(req);
  let plan: ClosePlan | null = null;
  try {
    plan = consumeApproval(req, 'CLOSE') as ClosePlan;
    const body: Record<string, string> = {
      symbol: plan.symbol,
      productType: PRODUCT_TYPE,
    };
    if (plan.positionMode === 'hedge_mode' && plan.holdSide) body.holdSide = plan.holdSide;
    const result = await bitgetPrivate<{
      successList?: Array<{ orderId?: string; clientOid?: string; symbol?: string }>;
      failureList?: Array<{ orderId?: string; clientOid?: string; symbol?: string; errorMsg?: string; errorCode?: string }>;
    }>(
      'POST',
      '/api/v2/mix/order/close-positions',
      '',
      body,
    );
    const first = Array.isArray(result?.successList) ? result.successList[0] : null;
    if (!first && Array.isArray(result?.failureList) && result.failureList.length) {
      const failure = result.failureList[0];
      throw new Error(`BITGET_${String(failure.errorCode ?? 'CLOSE_FAILED')}:${String(failure.errorMsg ?? '포지션 종료 실패')}`);
    }
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
      status: 'SUCCESS',
      orderId: String(first?.orderId ?? '') || null,
      clientOid: String(first?.clientOid ?? '') || null,
      message: '포지션 시장가 종료 요청이 전송됐습니다.',
      details: plan,
      createdAt: new Date().toISOString(),
    };
    await appendJournal(entry);
    return res.json({ ok: true, result, journal: entry });
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
  }
});

router.post('/crypto/futures/auto/configure-plan', requireMember, requireAdmin, async (req, res) => {
  if (!requireSafety(req, res)) return;
  try {
    const symbol = safeSymbol(req.body?.symbol);
    const positionMode = String(req.body?.positionMode ?? 'one_way_mode') as PositionMode;
    const marginMode = String(req.body?.marginMode ?? 'isolated') as MarginMode;
    const leverage = clamp(Math.floor(finiteNumber(req.body?.leverage, 2)), 1, 125);
    if (!symbol) return res.status(400).json({ ok: false, message: '코인 심볼이 필요합니다.' });
    if (!['one_way_mode', 'hedge_mode'].includes(positionMode)) {
      return res.status(400).json({ ok: false, message: '포지션 모드가 올바르지 않습니다.' });
    }
    if (!['isolated', 'crossed'].includes(marginMode)) {
      return res.status(400).json({ ok: false, message: '마진 모드가 올바르지 않습니다.' });
    }
    const positions = await allPositions();
    if (positions.length) {
      return res.status(409).json({
        ok: false,
        message: '포지션 모드·마진 모드는 보유 포지션이 없을 때만 바꿀 수 있습니다. 현재 포지션을 먼저 확인하세요.',
        positions,
      });
    }
    const plan: ConfigurePlan = { kind: 'CONFIGURE', symbol, positionMode, marginMode, leverage, createdAt: new Date().toISOString() };
    const approval = issueApproval(memberId(req), plan);
    return res.json({
      ok: true,
      approvalRequired: true,
      approvalToken: approval.token,
      approvalExpiresAt: approval.expiresAt,
      plan,
      warning: '포지션 모드 변경은 해당 상품군 전체에 영향을 줄 수 있습니다. 비트겟 미체결 주문과 포지션이 없는지 확인하세요.',
    });
  } catch (error) {
    return res.status(502).json({ ok: false, message: error instanceof Error ? error.message : '설정계획 생성 실패' });
  }
});

router.post('/crypto/futures/auto/configure', requireMember, requireAdmin, async (req, res) => {
  if (!requireSafety(req, res)) return;
  if (!tradingEnabled()) return res.status(409).json({ ok: false, message: '서버 실주문 기능이 꺼져 있습니다.' });
  const member = memberId(req);
  let plan: ConfigurePlan | null = null;
  try {
    plan = consumeApproval(req, 'CONFIGURE') as ConfigurePlan;
    const config = await contractConfig(plan.symbol);
    const serverMaxLeverage = clamp(Math.floor(finiteNumber(process.env.CRYPTO_AUTO_TRADE_MAX_LEVERAGE, 5)), 1, config.maxLever);
    const leverage = clamp(plan.leverage, config.minLever, serverMaxLeverage);
    await bitgetPrivate('POST', '/api/v2/mix/account/set-position-mode', '', {
      productType: PRODUCT_TYPE,
      posMode: plan.positionMode,
    });
    await bitgetPrivate('POST', '/api/v2/mix/account/set-margin-mode', '', {
      symbol: plan.symbol,
      productType: PRODUCT_TYPE,
      marginCoin: MARGIN_COIN,
      marginMode: plan.marginMode,
    });
    await bitgetPrivate('POST', '/api/v2/mix/account/set-leverage', '', {
      symbol: plan.symbol,
      productType: PRODUCT_TYPE,
      marginCoin: MARGIN_COIN,
      leverage: String(leverage),
    });
    const entry: JournalEntry = {
      id: randomUUID(),
      memberId: member,
      action: 'CONFIGURE',
      symbol: plan.symbol,
      status: 'SUCCESS',
      orderId: null,
      clientOid: null,
      message: '비트겟 포지션 모드·마진 모드·레버리지 설정을 적용했습니다.',
      details: { ...plan, leverage },
      createdAt: new Date().toISOString(),
    };
    await appendJournal(entry);
    return res.json({ ok: true, journal: entry });
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

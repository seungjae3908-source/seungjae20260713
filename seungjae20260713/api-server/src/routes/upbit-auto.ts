import { Router, type IRouter, type Request, type Response } from 'express';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
const UPBIT_BASE = 'https://api.upbit.com';
const APPROVAL_TTL_MS = 10 * 60_000;

type Side = 'BUY' | 'SELL';
type UpbitPlan = {
  kind: 'OPEN';
  token: string;
  memberId: string;
  expiresAt: number;
  sequenceId: string;
  symbol: string;
  market: string;
  side: Side;
  stage: TradeStage;
  stageRatio: number;
  totalAmountKRW: number;
  stageAmountKRW: number;
  orderVolume: number | null;
  currentPrice: number;
  allocation: StagedTradeAllocation;
  createdAt: string;
};

type UpbitJournalEntry = {
  id: string;
  memberId: string;
  sequenceId: string;
  symbol: string;
  side: Side;
  stage: TradeStage;
  stageRatio: number;
  status: 'SUCCESS' | 'FAILED';
  orderUuid: string | null;
  amountKRW: number;
  volume: number | null;
  message: string;
  createdAt: string;
};

const approvals = new Map<string, UpbitPlan>();
let journalLoaded = false;
let journal: UpbitJournalEntry[] = [];
let journalQueue = Promise.resolve();

function dataDirectory() {
  const cwd = process.cwd();
  return path.basename(cwd) === 'api-server' ? path.join(cwd, 'data') : path.join(cwd, 'api-server', 'data');
}

function journalFile() {
  return path.join(dataDirectory(), 'upbit-auto-journal.json');
}

async function ensureJournal() {
  if (journalLoaded) return;
  journalLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(journalFile(), 'utf8')) as { entries?: UpbitJournalEntry[] };
    journal = Array.isArray(parsed.entries) ? parsed.entries.slice(0, 1000) : [];
  } catch {
    journal = [];
  }
}

async function appendJournal(entry: UpbitJournalEntry) {
  await ensureJournal();
  journal = [entry, ...journal].slice(0, 1000);
  journalQueue = journalQueue.then(async () => {
    await mkdir(dataDirectory(), { recursive: true });
    await writeFile(journalFile(), JSON.stringify({ version: 1, entries: journal }, null, 2), 'utf8');
  });
  await journalQueue;
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createUpbitJwt(queryString = '') {
  const accessKey = String(process.env.UPBIT_ACCESS_KEY ?? '').trim();
  const secretKey = String(process.env.UPBIT_SECRET_KEY ?? '').trim();
  if (!accessKey || !secretKey) throw new Error('UPBIT_PRIVATE_KEYS_NOT_CONFIGURED');
  const header = base64Url(JSON.stringify({ alg: 'HS512', typ: 'JWT' }));
  const payload: Record<string, string> = { access_key: accessKey, nonce: randomUUID() };
  if (queryString) {
    payload.query_hash = createHash('sha512').update(queryString, 'utf8').digest('hex');
    payload.query_hash_alg = 'SHA512';
  }
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = base64Url(createHmac('sha512', secretKey).update(`${header}.${encodedPayload}`).digest());
  return `${header}.${encodedPayload}.${signature}`;
}

function orderQueryString(body: Record<string, string>) {
  return Object.entries(body).map(([key, value]) => `${key}=${value}`).join('&');
}

async function requestJson<T>(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 300) }; }
    if (!response.ok) throw new Error(`UPBIT_HTTP_${response.status}:${text.slice(0, 240)}`);
    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function upbitAccounts() {
  return requestJson<Array<{ currency?: string; balance?: string; locked?: string }>>(`${UPBIT_BASE}/v1/accounts`, {
    headers: { Authorization: `Bearer ${createUpbitJwt()}`, Accept: 'application/json' },
  });
}

async function marketAnalysis(symbol: string) {
  const market = `KRW-${symbol}`;
  const [tickers, candles] = await Promise.all([
    requestJson<Array<{ trade_price?: number }>>(`${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(market)}`),
    requestJson<Array<{ timestamp?: number; high_price?: number; low_price?: number; trade_price?: number }>>(`${UPBIT_BASE}/v1/candles/days?market=${encodeURIComponent(market)}&count=80`),
  ]);
  const currentPrice = Number(tickers[0]?.trade_price ?? 0);
  const rows = candles
    .map((row) => ({ time: Number(row.timestamp), high: Number(row.high_price), low: Number(row.low_price), close: Number(row.trade_price) }))
    .filter((row) => row.time > 0 && row.high > 0 && row.low > 0 && row.close > 0)
    .sort((a, b) => a.time - b.time);
  if (!(currentPrice > 0) || rows.length < 20) throw new Error('업비트 현재가 또는 실제 일봉이 부족합니다.');
  const ranges = rows.slice(1).map((row, index) => {
    const previousClose = rows[index].close;
    return Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose));
  });
  const recent = ranges.slice(-14);
  const atr = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  return {
    market,
    currentPrice,
    volatilityPercent: atr / currentPrice * 100,
    dataCompleteness: Math.min(100, Math.round(rows.length / 60 * 100)),
  };
}

function safeSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
}

function memberId(req: Request) {
  const member = (req as Request & { member?: { id?: string } }).member?.id;
  if (!member) throw new Error('로그인이 필요합니다.');
  return member;
}

function credentialsConfigured() {
  return Boolean(String(process.env.UPBIT_ACCESS_KEY ?? '').trim() && String(process.env.UPBIT_SECRET_KEY ?? '').trim());
}

function executionKeyValid(req: Request) {
  const configured = Buffer.from(String(process.env.UPBIT_AUTO_TRADE_KEY ?? '').trim());
  const supplied = Buffer.from(String(req.header('X-Auto-Trade-Key') ?? '').trim());
  return configured.length > 0 && configured.length === supplied.length && timingSafeEqual(configured, supplied);
}

function tradingEnabled() {
  return String(process.env.CRYPTO_AUTO_TRADE_ENABLED ?? '').toLowerCase() === 'true'
    && String(process.env.UPBIT_AUTO_TRADE_ENABLED ?? '').toLowerCase() === 'true';
}

function requirePlanAccess(req: Request, res: Response) {
  if (!credentialsConfigured()) {
    res.status(503).json({ ok: false, message: '업비트 개인 API 키가 서버 환경변수에 설정되지 않았습니다.' });
    return false;
  }
  if (!executionKeyValid(req)) {
    res.status(401).json({ ok: false, message: '업비트 자동매매 실행키가 올바르지 않습니다.' });
    return false;
  }
  return true;
}

function cleanupApprovals() {
  const now = Date.now();
  for (const [token, plan] of approvals) if (plan.expiresAt <= now) approvals.delete(token);
}

function completedStages(member: string, sequenceId: string, side: Side) {
  return new Set(journal.filter((entry) => entry.memberId === member && entry.sequenceId === sequenceId && entry.side === side && entry.status === 'SUCCESS').map((entry) => entry.stage));
}

router.get('/crypto/spot/auto/status', requireMember, requireAdmin, async (req, res) => {
  await ensureJournal();
  const member = memberId(req);
  return res.json({
    ok: true,
    exchange: 'UPBIT',
    configured: credentialsConfigured(),
    enabled: tradingEnabled(),
    executionKeyConfigured: Boolean(String(process.env.UPBIT_AUTO_TRADE_KEY ?? '').trim()),
    approvalTtlSeconds: APPROVAL_TTL_MS / 1000,
    latestJournal: journal.filter((entry) => entry.memberId === member).slice(0, 20),
  });
});

router.post('/crypto/spot/auto/verify-key', requireMember, requireAdmin, (req, res) => {
  if (!requirePlanAccess(req, res)) return;
  return res.json({ ok: true, verified: true, message: '업비트 자동매매 실행키가 확인됐습니다.', checkedAt: new Date().toISOString() });
});

router.post('/crypto/spot/auto/plan', requireMember, requireAdmin, async (req, res) => {
  if (!requirePlanAccess(req, res)) return;
  try {
    await ensureJournal();
    const member = memberId(req);
    const symbol = safeSymbol(req.body?.symbol);
    const side: Side = String(req.body?.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const stage = parseTradeStage(req.body?.stage ?? 1);
    const totalAmountKRW = Math.floor(Number(req.body?.totalAmountKRW ?? 0));
    const score = Number(req.body?.score);
    const oppositeScore = req.body?.oppositeScore == null ? null : Number(req.body.oppositeScore);
    if (!symbol) return res.status(400).json({ ok: false, message: '코인 심볼이 필요합니다.' });
    if (!stage) return res.status(400).json({ ok: false, message: '진입·청산 단계는 1, 2, 3 중 하나여야 합니다.' });
    if (!(totalAmountKRW > 0)) return res.status(400).json({ ok: false, message: '총 거래금액(KRW)을 입력하세요.' });
    if (!Number.isFinite(score) || score < 0 || score > 100) return res.status(400).json({ ok: false, message: '실제 분석 신뢰도 점수가 필요합니다.' });

    const analysis = await marketAnalysis(symbol);
    const serverRiskScore = Math.min(100, Math.max(0, Math.round(15 + analysis.volatilityPercent * 9)));
    const allocation = deriveStagedTradeAllocation({
      confidenceScore: score,
      oppositeScore,
      riskScore: serverRiskScore,
      dataCompleteness: analysis.dataCompleteness,
      volatilityPercent: analysis.volatilityPercent,
    });
    if (!allocation.available) return res.status(409).json({ ok: false, message: `분할 비율 산출 불가: ${allocation.reason}` });

    const ratios = side === 'BUY' ? allocation.entryRatios : allocation.exitRatios;
    const stageAmountKRW = Math.floor(stageAmount(totalAmountKRW, ratios, stage));
    const minimumOrderKRW = Math.max(1, Number(process.env.UPBIT_AUTO_TRADE_MIN_ORDER_KRW ?? 5000));
    if (stageAmountKRW < minimumOrderKRW) return res.status(409).json({ ok: false, message: `${stage}차 금액이 최소 주문금액 ${minimumOrderKRW.toLocaleString('ko-KR')}원보다 작습니다.` });

    const accounts = await upbitAccounts();
    const accountCurrency = side === 'BUY' ? 'KRW' : symbol;
    const account = accounts.find((row) => String(row.currency ?? '').toUpperCase() === accountCurrency);
    const available = Number(account?.balance ?? 0);
    const orderVolume = side === 'SELL' ? stageAmountKRW / analysis.currentPrice : null;
    if (side === 'BUY' && available < stageAmountKRW) return res.status(409).json({ ok: false, message: '업비트 주문가능 KRW 잔고가 해당 단계 금액보다 작습니다.' });
    if (side === 'SELL' && (!(orderVolume && orderVolume > 0) || available < orderVolume)) return res.status(409).json({ ok: false, message: `업비트 ${symbol} 주문가능 잔고가 해당 단계 수량보다 작습니다.` });

    const requestedSequenceId = String(req.body?.sequenceId ?? '').trim();
    const sequenceId = stage === 1 ? randomUUID() : requestedSequenceId;
    if (!sequenceId) return res.status(400).json({ ok: false, message: '2·3차 주문은 1차 계획의 sequenceId가 필요합니다.' });
    if (stage > 1) {
      const completed = completedStages(member, sequenceId, side);
      if (!completed.has((stage - 1) as TradeStage)) return res.status(409).json({ ok: false, message: `${stage - 1}차 체결 기록이 없어 ${stage}차 계획을 만들 수 없습니다.` });
      if (completed.has(stage)) return res.status(409).json({ ok: false, message: `${stage}차 주문이 이미 전송된 순서입니다.` });
    }

    cleanupApprovals();
    const token = randomUUID();
    const plan: UpbitPlan = {
      kind: 'OPEN',
      token,
      memberId: member,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
      sequenceId,
      symbol,
      market: analysis.market,
      side,
      stage,
      stageRatio: ratios[stage - 1],
      totalAmountKRW,
      stageAmountKRW,
      orderVolume,
      currentPrice: analysis.currentPrice,
      allocation,
      createdAt: new Date().toISOString(),
    };
    approvals.set(token, plan);
    return res.json({ ok: true, approvalRequired: true, approvalToken: token, approvalExpiresAt: new Date(plan.expiresAt).toISOString(), plan, warning: '아직 주문되지 않았습니다. 금액·수량·분할 단계·비율을 확인한 뒤 한 번 더 승인해야 합니다.' });
  } catch (error) {
    return res.status(502).json({ ok: false, message: error instanceof Error ? error.message : '업비트 주문계획 생성 실패' });
  }
});

router.post('/crypto/spot/auto/execute', requireMember, requireAdmin, async (req, res) => {
  if (!requirePlanAccess(req, res)) return;
  if (!tradingEnabled()) return res.status(409).json({ ok: false, message: '서버 실주문 기능이 꺼져 있습니다. CRYPTO_AUTO_TRADE_ENABLED와 UPBIT_AUTO_TRADE_ENABLED가 모두 필요합니다.' });
  cleanupApprovals();
  const token = String(req.body?.approvalToken ?? '').trim();
  const plan = approvals.get(token);
  if (!plan || plan.memberId !== memberId(req) || plan.expiresAt <= Date.now()) return res.status(409).json({ ok: false, message: '주문 승인이 없거나 만료되었습니다.' });
  approvals.delete(token);

  try {
    await ensureJournal();
    const completed = completedStages(plan.memberId, plan.sequenceId, plan.side);
    if (plan.stage > 1 && !completed.has((plan.stage - 1) as TradeStage)) throw new Error('이전 단계의 성공 기록이 없어 주문을 중단했습니다.');
    if (completed.has(plan.stage)) throw new Error('같은 분할 단계가 이미 성공해 중복 주문을 중단했습니다.');
    const latest = await marketAnalysis(plan.symbol);
    const slippage = Math.abs(latest.currentPrice - plan.currentPrice) / plan.currentPrice * 100;
    if (slippage > 1) throw new Error(`계획 이후 가격이 ${slippage.toFixed(2)}% 변해 주문을 중단했습니다.`);

    const identifier = `sa-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const body: Record<string, string> = plan.side === 'BUY'
      ? { market: plan.market, side: 'bid', price: String(plan.stageAmountKRW), ord_type: 'price', identifier }
      : { market: plan.market, side: 'ask', volume: Number(plan.orderVolume).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''), ord_type: 'market', identifier };
    const queryString = orderQueryString(body);
    const result = await requestJson<{ uuid?: string; identifier?: string }>(`${UPBIT_BASE}/v1/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createUpbitJwt(queryString)}`,
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const entry: UpbitJournalEntry = {
      id: randomUUID(), memberId: plan.memberId, sequenceId: plan.sequenceId, symbol: plan.symbol, side: plan.side,
      stage: plan.stage, stageRatio: plan.stageRatio, status: 'SUCCESS', orderUuid: String(result.uuid ?? '') || null,
      amountKRW: plan.stageAmountKRW, volume: plan.orderVolume, message: `${plan.stage}차 ${plan.side === 'BUY' ? '매수' : '매도'} 주문이 전송됐습니다.`, createdAt: new Date().toISOString(),
    };
    await appendJournal(entry);
    return res.json({ ok: true, order: result, journal: entry, sequenceId: plan.sequenceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : '업비트 주문 전송 실패';
    await appendJournal({
      id: randomUUID(), memberId: plan.memberId, sequenceId: plan.sequenceId, symbol: plan.symbol, side: plan.side,
      stage: plan.stage, stageRatio: plan.stageRatio, status: 'FAILED', orderUuid: null, amountKRW: plan.stageAmountKRW,
      volume: plan.orderVolume, message, createdAt: new Date().toISOString(),
    });
    return res.status(502).json({ ok: false, message });
  }
});

export default router;

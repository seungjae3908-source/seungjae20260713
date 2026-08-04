import { createHash } from 'node:crypto';
import { MarketDataService } from './market-data.service';
import { SignalService } from './signal.service';
import { getKiwoomDomesticOrderbook } from '../providers/kiwoom';
import { TradeAutomationService } from './trade-automation.service';
import type { TradingRepository } from './trade-automation.repository';
import type {
  TradingMarketSnapshot,
  TradingPlanInput,
  TradingPolicy,
} from './trade-automation.types';
import type { Candle, Timeframe } from '../sample/types';

const ALLOWED_TIMEFRAMES = new Set(['5m', '15m', '1H', '60m', '4H', '1D']);
const DEFAULT_SPLIT_RATIOS = [40, 30, 30];
const SIGNAL_TTL_MS = 10 * 60_000;
const IDEMPOTENCY_BUCKET_MS = 5 * 60_000;

export type ScannerApprovalPlanRequest = {
  market: 'KR' | 'US';
  symbol: string;
  timeframe: string;
  selectedConditions: string[];
  requestedInvestmentKrw?: number;
  splitRatios?: number[];
  volumeThreshold?: number;
  tradingValueThreshold?: number;
  marketCapThreshold?: number;
  volumeLookbackDays?: number;
  tradingValueLookbackDays?: number;
  minimumScore?: number;
  minimumConfidence?: number;
  maximumRiskScore?: number;
};

type ScannerResult = Awaited<ReturnType<typeof SignalService.scan>>;
type ScannerCard = ScannerResult['cards'][number];

type ScannerApprovalDependencies = {
  scan: typeof SignalService.scan;
  getQuote: typeof MarketDataService.getQuote;
  getCandles: typeof MarketDataService.getCandles;
  getOrderbook: typeof getKiwoomDomesticOrderbook;
  now: () => Date;
};

const DEFAULT_DEPENDENCIES: ScannerApprovalDependencies = {
  scan: SignalService.scan,
  getQuote: MarketDataService.getQuote,
  getCandles: MarketDataService.getCandles,
  getOrderbook: getKiwoomDomesticOrderbook,
  now: () => new Date(),
};

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function normalizedSymbol(value: unknown) {
  const symbol = String(value ?? '').trim().toUpperCase().replace(/^(KR|US)[:.]/, '');
  if (!/^[0-9A-Z._-]{1,20}$/.test(symbol)) throw new Error('SCANNER_SYMBOL_INVALID');
  return symbol;
}

function normalizedConditions(value: unknown) {
  if (!Array.isArray(value)) throw new Error('SCANNER_CONDITIONS_REQUIRED');
  const conditions = [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 20);
  if (!conditions.length) throw new Error('SCANNER_CONDITIONS_REQUIRED');
  return conditions;
}

function normalizedTimeframe(value: unknown) {
  const raw = String(value ?? '1D').trim();
  const timeframe = raw === '60m' ? '1H' : raw;
  if (!ALLOWED_TIMEFRAMES.has(raw) && !ALLOWED_TIMEFRAMES.has(timeframe)) {
    throw new Error('SCANNER_TIMEFRAME_UNSUPPORTED');
  }
  return timeframe;
}

function normalizedSplitRatios(value: unknown) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_SPLIT_RATIOS;
  if (source.length < 1 || source.length > 3) throw new Error('SCANNER_SPLIT_RATIO_INVALID');
  const ratios = source.map((item) => Math.round(finite(item, 0) * 100) / 100);
  if (ratios.some((item) => item <= 0)) throw new Error('SCANNER_SPLIT_RATIO_INVALID');
  const total = ratios.reduce((sum, item) => sum + item, 0);
  if (Math.abs(total - 100) > 0.01) throw new Error('SCANNER_SPLIT_RATIO_INVALID');
  return ratios;
}

function numberFromApi(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value);
  const parsed = Number(String(value ?? '').replace(/[,+%₩$]/g, '').trim());
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

export function parseKiwoomTopOfBook(value: Record<string, unknown>) {
  const ask = numberFromApi(value.sel_fpr_bid);
  const bid = numberFromApi(value.buy_fpr_bid);
  const askQuantity = numberFromApi(value.sel_fpr_req);
  const bidQuantity = numberFromApi(value.buy_fpr_req);
  const totalAskQuantity = numberFromApi(value.tot_sel_req);
  const totalBidQuantity = numberFromApi(value.tot_buy_req);
  if (ask == null || bid == null || ask <= 0 || bid <= 0 || ask < bid) {
    throw new Error('SCANNER_ORDERBOOK_INVALID');
  }
  const midpoint = (ask + bid) / 2;
  const spreadPercent = midpoint > 0 ? ((ask - bid) / midpoint) * 100 : Number.POSITIVE_INFINITY;
  return {
    ask,
    bid,
    askQuantity,
    bidQuantity,
    totalAskQuantity,
    totalBidQuantity,
    spreadPercent,
  };
}

function previousCloseMove(candles: Candle[]) {
  const recent = candles.filter((item) => Number.isFinite(item.close) && item.close > 0).slice(-2);
  if (recent.length < 2) return 0;
  return ((recent[1].close - recent[0].close) / recent[0].close) * 100;
}

function averageTrueRange(candles: Candle[], period = 14) {
  const rows = candles.slice(-(period + 1));
  if (rows.length < 3) return null;
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  const valid = ranges.filter((item) => Number.isFinite(item) && item > 0);
  return valid.length ? valid.reduce((sum, item) => sum + item, 0) / valid.length : null;
}

export function buildLongExitPlan(price: number, candles: Candle[]) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('SCANNER_PRICE_INVALID');
  const recent = candles.slice(-20);
  if (recent.length < 10) throw new Error('SCANNER_CANDLES_INSUFFICIENT');
  const support = Math.min(...recent.map((item) => item.low).filter((item) => Number.isFinite(item) && item > 0));
  const atr = averageTrueRange(candles) ?? price * 0.02;
  const volatilityStop = price - Math.max(atr * 1.5, price * 0.015);
  const structuralStop = support * 0.995;
  const rawStop = Math.max(volatilityStop, structuralStop);
  const stopPrice = Math.max(price * 0.92, Math.min(price * 0.99, rawStop));
  const riskPerShare = price - stopPrice;
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) throw new Error('SCANNER_STOP_PLAN_INVALID');
  return {
    stopPrice: Math.max(1, Math.round(stopPrice)),
    targetPrices: [
      Math.round(price + riskPerShare * 1.5),
      Math.round(price + riskPerShare * 2.5),
    ],
    riskReward: 1.5,
    atr,
    support,
  };
}

function planHash(parts: string[]) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20);
}

function activeOrderStates(state: string) {
  return ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'RECOVERY_REQUIRED'].includes(state);
}

function activePlanStates(state: string) {
  return ['PLANNED', 'APPROVAL_PENDING', 'SUBMITTED'].includes(state);
}

function strictAndMatched(card: ScannerCard, selected: string[]) {
  const matched = new Set(card.matched.map((item) => item.trim()));
  return selected.every((condition) => matched.has(condition)) && card.missing.length === 0;
}

export class ScannerApprovalPlanService {
  private dependencies: ScannerApprovalDependencies;

  constructor(
    private repository: TradingRepository,
    dependencies: Partial<ScannerApprovalDependencies> = {},
  ) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  async createPaperPlan(userId: string, request: ScannerApprovalPlanRequest) {
    const market = String(request.market ?? '').toUpperCase();
    if (market !== 'KR' && market !== 'US') throw new Error('SCANNER_MARKET_INVALID');
    if (market === 'US') throw new Error('US_ORDER_ADAPTER_NOT_AVAILABLE');

    const symbol = normalizedSymbol(request.symbol);
    if (!/^\d{6}(?:_(?:NX|AL))?$/.test(symbol)) throw new Error('SCANNER_KR_SYMBOL_INVALID');
    const timeframe = normalizedTimeframe(request.timeframe);
    const selectedConditions = normalizedConditions(request.selectedConditions);
    const splitRatios = normalizedSplitRatios(request.splitRatios);
    const minimumScore = clamp(request.minimumScore, 0, 100, 70);
    const minimumConfidence = clamp(request.minimumConfidence, 0, 100, 60);
    const maximumRiskScore = clamp(request.maximumRiskScore, 0, 60, 50);
    const policy = await this.repository.getPolicy(userId);
    const requestedInvestmentKrw = Math.floor(clamp(
      request.requestedInvestmentKrw,
      5_000,
      Math.min(policy.maxOrderKrw, policy.totalCapitalKrw),
      Math.min(policy.maxOrderKrw, policy.totalCapitalKrw),
    ));

    const filters = {
      volumeThreshold: request.volumeThreshold,
      tradingValueThreshold: request.tradingValueThreshold,
      marketCapThreshold: request.marketCapThreshold,
      volumeLookbackDays: request.volumeLookbackDays,
      tradingValueLookbackDays: request.tradingValueLookbackDays,
      minimumScore,
      maximumRiskScore,
      timeframe,
    };
    const scan = await this.dependencies.scan('KR', selectedConditions, filters, 200);
    const selected = scan.selected;
    const card = scan.cards.find((item) => item.ticker.toUpperCase() === symbol);
    if (!card) throw new Error('SCANNER_SIGNAL_NOT_FOUND');
    if (!strictAndMatched(card, selected)) throw new Error('SCANNER_AND_CONDITIONS_NOT_MAINTAINED');
    if (card.dataState !== 'ok') throw new Error(`SCANNER_DATA_${card.dataState.toUpperCase()}`);
    if (card.score < minimumScore) throw new Error('SCANNER_SCORE_BELOW_MINIMUM');
    if (card.confidence < minimumConfidence) throw new Error('SCANNER_CONFIDENCE_BELOW_MINIMUM');
    if (card.riskScore == null || card.riskScore > maximumRiskScore || card.riskLevel === 'HIGH') {
      throw new Error('SCANNER_RISK_BLOCKED');
    }

    const [quote, candles, minuteCandles, orderbookRaw, plans, orders] = await Promise.all([
      this.dependencies.getQuote(symbol),
      this.dependencies.getCandles(symbol, (timeframe === '1H' ? '60m' : timeframe) as Timeframe),
      this.dependencies.getCandles(symbol, '1m'),
      this.dependencies.getOrderbook(symbol),
      this.repository.listPlans(userId),
      this.repository.listOrders(userId),
    ]);
    const price = finite((quote as { price?: number }).price, 0);
    if (price <= 0) throw new Error('SCANNER_PRICE_INVALID');
    const orderbook = parseKiwoomTopOfBook(orderbookRaw as Record<string, unknown>);
    const exitPlan = buildLongExitPlan(price, candles);
    const quantity = Math.floor(requestedInvestmentKrw / price);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('SCANNER_ORDER_AMOUNT_TOO_SMALL');
    const estimatedKrw = Math.floor(quantity * price);
    const now = this.dependencies.now();
    const today = now.toISOString().slice(0, 10);
    const activeOrders = orders.filter((item) => activeOrderStates(item.state));
    const activePlans = plans.filter((item) => activePlanStates(item.state));
    const symbolExposureKrw = activePlans
      .filter((item) => item.exchange === 'kiwoom' && item.market === 'KR' && item.symbol === symbol)
      .reduce((sum, item) => sum + finite(item.estimatedKrw, 0), 0);
    const openPositionCount = new Set(activeOrders.map((item) => item.planId)).size;
    const dailyOrderCount = orders.filter((item) => item.createdAt.slice(0, 10) === today).length;
    const existingPlan = activePlans.find((item) => item.exchange === 'kiwoom' && item.market === 'KR' && item.symbol === symbol);
    const marketSnapshot: TradingMarketSnapshot = {
      observedAt: now.toISOString(),
      dataDelayMs: 0,
      oneMinuteMovePercent: previousCloseMove(minuteCandles),
      spreadPercent: orderbook.spreadPercent,
      orderbookGapPercent: orderbook.spreadPercent,
      halted: false,
      availableBalance: policy.totalCapitalKrw,
      accountValueKrw: policy.totalCapitalKrw,
      dailyPnlPercent: 0,
      assetExposurePercent: policy.totalCapitalKrw > 0
        ? (symbolExposureKrw / policy.totalCapitalKrw) * 100
        : 100,
      openPositionCount,
      dailyOrderCount,
      consecutiveLosses: 0,
      existingPositionSide: existingPlan?.side ?? null,
    };
    const conditionHash = planHash(selected);
    const bucket = Math.floor(now.getTime() / IDEMPOTENCY_BUCKET_MS);
    const signalId = `scanner:KR:${symbol}:${timeframe}:${conditionHash}:${bucket}`;
    const strategyId = `scanner-${timeframe.toLowerCase()}-${conditionHash}`;
    const reasons = [
      ...card.matched,
      `서버 재계산 AI 점수 ${card.score}`,
      `신뢰도 ${card.confidence}`,
      `최우선 호가 스프레드 ${orderbook.spreadPercent.toFixed(3)}%`,
      `지지선 ${Math.round(exitPlan.support)}`,
      `ATR ${Math.round(exitPlan.atr)}`,
    ].slice(0, 30);
    const planInput: TradingPlanInput = {
      exchange: 'kiwoom',
      accountMode: 'paper',
      strategyId,
      signalId,
      symbol,
      market: 'KR',
      side: 'buy',
      orderType: 'market',
      quantity,
      quoteAmount: null,
      limitPrice: null,
      estimatedKrw,
      stopPrice: exitPlan.stopPrice,
      targetPrices: exitPlan.targetPrices,
      splitRatios,
      leverage: null,
      marginMode: null,
      reduceOnly: false,
      invalidateAction: 'hold',
      signalReasons: reasons,
      signalWarnings: [],
      signalScore: card.score,
      signalConfidence: card.confidence,
      minimumSignalScore: minimumScore,
      minimumSignalConfidence: minimumConfidence,
      minimumRiskReward: exitPlan.riskReward,
      signalRiskReward: exitPlan.riskReward,
      signalCoreConditionsMaintained: true,
      signalExpiresAt: new Date(now.getTime() + SIGNAL_TTL_MS).toISOString(),
      marketSnapshot,
    };
    const approvalPolicy: TradingPolicy = {
      ...policy,
      mode: 'approval',
      automaticEnabled: false,
      exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
    };
    const result = await new TradeAutomationService(this.repository).createPlan(
      userId,
      planInput,
      approvalPolicy,
      false,
    );
    if (!result.plan) {
      throw new Error(`SCANNER_PLAN_RISK_BLOCKED:${result.decision.blockCodes.join(',')}`);
    }
    return {
      plan: result.plan,
      approval: result.approval,
      duplicate: result.duplicate,
      serverVerified: true,
      liveOrderEnabled: false,
      scanner: {
        market: 'KR' as const,
        symbol,
        timeframe,
        selectedConditions: selected,
        matchedConditions: card.matched,
        score: card.score,
        confidence: card.confidence,
        riskScore: card.riskScore,
        dataState: card.dataState,
        analyzedAt: card.analyzedAt,
      },
      orderbook: {
        ask: orderbook.ask,
        bid: orderbook.bid,
        spreadPercent: orderbook.spreadPercent,
        imbalanceRatio: orderbook.totalAskQuantity && orderbook.totalBidQuantity
          ? orderbook.totalBidQuantity / orderbook.totalAskQuantity
          : null,
      },
    };
  }
}

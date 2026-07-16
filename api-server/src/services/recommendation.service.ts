// AI 추천 엔진 (규칙 기반 — LLM 미연결 상태를 명시적으로 표시한다).
//
// 조건검색기와의 역할 구분:
//  - 조건검색기(SignalService.scan): 사용자가 지표를 직접 선택해 종목을 찾는 도구.
//  - 추천 엔진(이 파일): 시세·재무·뉴스·공시 실데이터를 종합해 앱이 최종 선별.
//
// 원칙:
//  - 가짜 데이터 금지: 샘플 재무(source==='sample')는 밸류에이션에 사용하지 않고
//    "미반영" 항목으로 표시한다. 목표가·손절가는 근거를 만들 수 없으면 null(산출 불가).
//  - 조건 미달 종목으로 30개를 채우지 않는다.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cached } from '../lib/cache';
import { CATALOG, type CatalogEntry } from '../data/catalog';
import { classifyAssetType } from '../data/asset-type';
import { MarketDataService } from './market-data.service';
import { FinancialService } from './financial.service';
import { buildContext } from './signal.service';
import { computeIndicators } from '../sample/indicators';
import { computeScanConditions, type SignalContext } from '../sample/accumulation';
import type { Candle } from '../sample/types';

export type RecoCategory = 'undervalued' | 'breakout';
export type DataQuality = 'sufficient' | 'partial' | 'insufficient' | 'stale';

export interface RecommendationRow {
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  category: RecoCategory;
  categoryLabel: string;
  price: number;
  changePercent: number;
  reasons: string[];        // 선정 근거 (실제 수치 포함)
  usedData: string[];       // 사용한 실제 데이터 항목
  missingData: string[];    // 데이터 부족(미반영) 항목
  risks: string[];          // 위험 경고
  overheated: boolean;
  financialStability: '안정' | '보통' | '불안정' | '판단 불가';
  newsRisk: '낮음' | '보통' | '높음' | '판단 불가';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  shortTermOutlook: string; // 규칙 기반 문장 (analysisMode 참조)
  midTermOutlook: string;
  opinion: '매수' | '관망' | '매도';
  targetPrice: number | null;   // null = 산출 불가
  targetBasis: string;          // 목표가 산출 근거
  stopLoss: number | null;      // null = 산출 불가
  stopBasis: string;
  score: number;                // 상승 가능성 점수 0-100
  generatedAt: string;
  dataUpdatedAt: string;        // 마지막 캔들/시세 기준 시각
  providers: string[];          // 실제 데이터 공급자
  dataQuality: DataQuality;
  previousGeneratedAt?: string; // 직전 추천 시각(반복 추천 추적)
  previousPrice?: number;
  changeSincePrevious?: number; // 직전 추천 대비 등락 %
}

export interface RecommendationResult {
  ok: boolean;
  provider: string;
  analysisMode: 'rule-based';
  aiConfigured: false;
  analysisDescription: string;
  market: 'KR' | 'US';
  fetchedAt: string;
  generatedAt: string;
  refreshIntervalMs: number;
  rows: RecommendationRow[];
  excludedCount: number;
  excludedBreakdown: Record<string, number>;
  dataQualityNote: string;
}

const POOL_LIMIT = 150;
const MAX_ROWS_PER_CATEGORY = 30;
const REFRESH_MS = 5 * 60 * 1000;
const STALE_DAYS = 7;
// 유동성 하한(20일 평균 거래대금): KR 10억원, US $5M — 이보다 작으면 제외.
const MIN_TRADING_VALUE = { KR: 1_000_000_000, US: 5_000_000 } as const;

const HISTORY_FILE = path.join('/tmp', 'reco-history.json');
let history: Record<string, { generatedAt: string; price: number }> | null = null;

async function loadHistory() {
  if (history) return history;
  try {
    history = JSON.parse(await fs.readFile(HISTORY_FILE, 'utf-8'));
  } catch {
    history = {};
  }
  return history!;
}

// 동시 요청에서 쓰기가 겹치지 않도록 직렬화 + 임시파일 원자적 교체.
let historyWriteChain: Promise<void> = Promise.resolve();

function saveHistory(): Promise<void> {
  historyWriteChain = historyWriteChain.then(async () => {
    if (!history) return;
    try {
      const tmp = `${HISTORY_FILE}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(history));
      await fs.rename(tmp, HISTORY_FILE);
    } catch {
      // history is best-effort
    }
  });
  return historyWriteChain;
}

function atr14(candles: Candle[]): number | null {
  const n = candles.length;
  if (n < 15) return null;
  let sum = 0;
  for (let i = n - 14; i < n; i++) {
    const prev = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev),
      Math.abs(candles[i].low - prev),
    );
    sum += tr;
  }
  return sum / 14;
}

function pctGain(candles: Candle[], bars: number): number | null {
  const n = candles.length;
  if (n <= bars) return null;
  const then = candles[n - 1 - bars].close;
  if (!then) return null;
  return ((candles[n - 1].close - then) / then) * 100;
}

function lastNumber(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] != null && Number.isFinite(values[i]!)) return values[i]!;
  }
  return null;
}

function candleDate(candle: Candle): Date | null {
  const raw = String(candle.time ?? '');
  if (/^\d{8}$/.test(raw)) {
    return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00+09:00`);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 통화 단위에 맞는 호가 반올림 (KRW 정수, USD 소수 2자리). */
function roundPrice(v: number, currency: 'KRW' | 'USD'): number {
  return currency === 'KRW' ? Math.round(v) : round2(v);
}

const DELIST_PATTERN = /관리종목|상장폐지|거래정지|투자주의|투자경고|투자위험/;
const OFFERING_PATTERN = /유상증자|CB|BW|전환사채|신주인수권|ATM|오퍼링|증자/i;

interface Analyzed {
  entry: CatalogEntry;
  candles: Candle[];
  price: number;
  changePercent: number;
  dataUpdatedAt: string;
  providers: string[];
  ctx: SignalContext;
  finSource: 'live' | 'sample' | 'none';
  fin: NonNullable<SignalContext['financials']> | null;
  rsi: number | null;
  macdHist: number | null;
  ma20: number | null;
  ma60: number | null;
  ma240: number | null;
  atr: number | null;
  gain5: number | null;
  gain20: number | null;
  avgVol20: number | null;
  avgTv20: number | null;
  lastVol: number;
  boxHigh: number | null;   // 직전 60봉(최근 5봉 제외) 고가
  boxLow: number | null;
  support20: number | null; // 최근 20봉 저가(손절 근거)
  boxConsolidation: boolean;
  overheated: boolean;
  overheatDetail: string | null;
  delistRisk: string | null;
  offeringRisk: string | null;
  newsRisk: '낮음' | '보통' | '높음' | '판단 불가';
  stale: boolean;
}

type ExcludeReason =
  | 'insufficient_data'
  | 'stale_data'
  | 'low_liquidity'
  | 'overheated'
  | 'delisting_risk'
  | 'not_qualified';

async function analyze(entry: CatalogEntry): Promise<{ a: Analyzed | null; exclude?: ExcludeReason }> {
  const assetType = classifyAssetType(entry.name, entry.market);
  if (assetType !== 'STOCK') return { a: null, exclude: 'not_qualified' };

  const [meta, quote, ctx, finRaw] = await Promise.all([
    MarketDataService.getCandlesMeta(entry.ticker, '1D' as any).catch(() => null),
    MarketDataService.getQuote(entry.ticker).catch(() => null),
    buildContext(entry).catch(() => ({ currency: entry.currency } as SignalContext)),
    FinancialService.getFinancials(entry.ticker).catch(() => null),
  ]);

  const candles = meta?.candles ?? [];
  if (!quote || candles.length < 60) return { a: null, exclude: 'insufficient_data' };

  const lastDate = candleDate(candles[candles.length - 1]);
  const stale = !lastDate || Date.now() - lastDate.getTime() > STALE_DAYS * 86_400_000;
  if (stale) return { a: null, exclude: 'stale_data' };

  const recent = candles.slice(-21, -1);
  const avgVol20 = recent.length ? recent.reduce((s, c) => s + c.volume, 0) / recent.length : null;
  const avgTv20 = recent.length ? recent.reduce((s, c) => s + c.volume * c.close, 0) / recent.length : null;
  const minTv = MIN_TRADING_VALUE[entry.market as 'KR' | 'US'] ?? MIN_TRADING_VALUE.US;
  if (avgTv20 == null || avgTv20 < minTv) return { a: null, exclude: 'low_liquidity' };

  const indicators = computeIndicators(candles);
  const cond = computeScanConditions(candles, indicators);
  const rsi = lastNumber(indicators.rsi);
  const gain5 = pctGain(candles, 5);
  const gain20 = pctGain(candles, 20);

  const overheatDetail =
    gain20 != null && gain20 > 60
      ? `최근 20거래일 +${round2(gain20)}% 급등`
      : gain5 != null && gain5 > 25
        ? `최근 5거래일 +${round2(gain5)}% 급등`
        : rsi != null && rsi > 78
          ? `RSI ${round2(rsi)} 과열`
          : null;

  const negatives = ctx.negativeEvents ?? [];
  const delistRisk = negatives.find((l) => DELIST_PATTERN.test(l)) ?? null;
  const offeringRisk = negatives.find((l) => OFFERING_PATTERN.test(l)) ?? null;

  const newsRisk: Analyzed['newsRisk'] =
    ctx.newsScore == null
      ? '판단 불가'
      : ctx.newsScore <= -40 || (ctx.newsNegative ?? 0) >= 5
        ? '높음'
        : ctx.newsScore < 0
          ? '보통'
          : '낮음';

  const n = candles.length;
  const boxSlice = candles.slice(Math.max(0, n - 65), n - 5);
  const boxHigh = boxSlice.length >= 30 ? Math.max(...boxSlice.map((c) => c.high)) : null;
  const boxLow = boxSlice.length >= 30 ? Math.min(...boxSlice.map((c) => c.low)) : null;
  const support20 = recent.length ? Math.min(...recent.map((c) => c.low)) : null;

  const fin = ctx.financials ?? null;
  const finSource: Analyzed['finSource'] =
    finRaw == null ? 'none' : finRaw.source === 'sample' ? 'sample' : 'live';

  return {
    a: {
      entry,
      candles,
      price: quote.price,
      changePercent: Number(quote.changePercent ?? 0),
      dataUpdatedAt: String((quote as any).updatedAt ?? lastDate?.toISOString() ?? new Date().toISOString()),
      providers: Array.from(
        new Set([meta?.provider ?? 'unknown', entry.market === 'KR' ? 'naver/dart' : 'yahoo/sec-edgar', 'google-news']),
      ),
      ctx,
      finSource,
      fin: finSource === 'live' ? fin : null,
      rsi,
      macdHist: lastNumber(indicators.macd.hist),
      ma20: lastNumber(indicators.ma20),
      ma60: lastNumber(indicators.ma60),
      ma240: lastNumber(indicators.ma240),
      atr: atr14(candles),
      gain5,
      gain20,
      avgVol20,
      avgTv20,
      lastVol: candles[n - 1].volume,
      boxHigh,
      boxLow,
      support20,
      boxConsolidation: Boolean(cond?.box_consolidation),
      overheated: overheatDetail != null,
      overheatDetail,
      delistRisk,
      offeringRisk,
      newsRisk,
      stale,
    },
  };
}

function baseRisks(a: Analyzed): string[] {
  const risks: string[] = [];
  if (a.overheatDetail) risks.push(`과열: ${a.overheatDetail}`);
  if (a.delistRisk) risks.push(`시장조치 위험: ${a.delistRisk}`);
  if (a.offeringRisk) risks.push(`희석 위험: ${a.offeringRisk}`);
  if (a.newsRisk === '높음') risks.push('최근 뉴스 부정적 비중 높음');
  if (a.fin && a.fin.debtRatio != null && a.fin.debtRatio > 200) {
    risks.push(`부채비율 ${round2(a.fin.debtRatio)}% (재무 부담)`);
  }
  // 급락 후 단순 기술적 반등 경고: 20일 -25% 이하인데 5일 +8% 이상 반등.
  if (a.gain20 != null && a.gain20 < -25 && a.gain5 != null && a.gain5 > 8) {
    risks.push(`급락 후 기술적 반등 구간 (20일 ${round2(a.gain20)}%, 5일 +${round2(a.gain5)}%) — 추세 확인 필요`);
  }
  return risks;
}

function financialStability(a: Analyzed): RecommendationRow['financialStability'] {
  if (!a.fin) return '판단 불가';
  const debt = a.fin.debtRatio;
  const roe = a.fin.roe;
  if (debt != null && debt > 250) return '불안정';
  if ((debt == null || debt <= 120) && roe != null && roe >= 8) return '안정';
  return '보통';
}

function buildUndervalued(a: Analyzed): RecommendationRow | null {
  const used: string[] = ['일봉(캔들)', '현재가/등락률', '거래량·거래대금'];
  const missing: string[] = [];
  const reasons: string[] = [];

  if (a.finSource !== 'live') {
    // 실제 재무 없이는 저평가 판단 자체를 하지 않는다 (샘플 재무 사용 금지).
    return null;
  }
  used.push(a.entry.market === 'KR' ? '재무비율(네이버/DART)' : '재무비율(SEC/Finnhub)');

  const fin = a.fin!;
  let valuationHits = 0;
  let valuationAvailable = 0;

  const perCap = a.entry.market === 'KR' ? 12 : 18;
  if (fin.per != null && fin.per > 0) {
    valuationAvailable++;
    if (fin.per < perCap) {
      valuationHits++;
      reasons.push(`PER ${round2(fin.per)}배 (기준 ${perCap}배 미만)`);
    }
  } else missing.push('PER');

  if (fin.pbr != null && fin.pbr > 0) {
    valuationAvailable++;
    if (fin.pbr < 1.5) {
      valuationHits++;
      reasons.push(`PBR ${round2(fin.pbr)}배 (1.5배 미만)`);
    }
  } else missing.push('PBR');

  if (fin.roe != null) {
    valuationAvailable++;
    if (fin.roe >= 8) {
      valuationHits++;
      reasons.push(`ROE ${round2(fin.roe)}% (8% 이상)`);
    }
  } else missing.push('ROE');

  if (fin.debtRatio != null) {
    if (fin.debtRatio <= 150) reasons.push(`부채비율 ${round2(fin.debtRatio)}% (150% 이하)`);
  } else missing.push('부채비율');

  const profitTrend = fin.profitGrowth?.filter((v) => Number.isFinite(v)) ?? [];
  if (profitTrend.length) {
    const avgG = profitTrend.reduce((s, v) => s + v, 0) / profitTrend.length;
    if (avgG > 0) reasons.push(`순이익 성장 평균 +${round2(avgG)}%`);
    used.push('연간 이익 추세');
  } else missing.push('이익 추세');

  // 가격 위치: 장기(240일) 이평 대비 낮은 구간.
  if (a.ma240 != null && a.ma240 > 0) {
    if (a.price <= a.ma240 * 1.05) reasons.push('가격이 240일 이동평균 부근/이하 (장기 저평가 구간)');
    used.push('240일 이동평균');
  } else missing.push('장기 이동평균');

  if (a.ctx.newsScore != null) used.push('뉴스 감성 점수');
  else missing.push('뉴스 데이터');

  // 최소 요건: 밸류에이션 지표 2개 이상 확보 + 2개 이상 충족.
  if (valuationAvailable < 2 || valuationHits < 2) return null;
  if (a.delistRisk) return null; // 상장폐지/관리종목 위험은 저평가 후보에서 제외
  if (a.overheated) return null;

  const risks = baseRisks(a);
  const stability = financialStability(a);
  if (stability === '불안정') risks.push('재무 불안정 — 저평가 후보에서 신중 검토 필요');

  // 목표가: 직전 박스 상단(저항) / 손절: 최근 20일 지지선. 근거 없으면 산출 불가.
  let targetPrice: number | null = null;
  let targetBasis = '산출 불가 (유효한 저항선 없음)';
  if (a.boxHigh != null && a.boxHigh > a.price) {
    targetPrice = roundPrice(a.boxHigh, a.entry.currency as 'KRW' | 'USD');
    targetBasis = '직전 60거래일 저항선(박스 상단)';
  }
  let stopLoss: number | null = null;
  let stopBasis = '산출 불가 (유효한 지지선 없음)';
  if (a.support20 != null && a.support20 < a.price) {
    stopLoss = roundPrice(a.support20, a.entry.currency as 'KRW' | 'USD');
    stopBasis = '최근 20거래일 지지선(저가)';
  } else if (a.atr != null) {
    stopLoss = roundPrice(a.price - 1.5 * a.atr, a.entry.currency as 'KRW' | 'USD');
    stopBasis = 'ATR(14) 1.5배 하단';
  }

  const score = Math.min(
    100,
    Math.round(
      valuationHits * 18 +
        (stability === '안정' ? 15 : stability === '보통' ? 7 : 0) +
        (a.newsRisk === '낮음' ? 10 : a.newsRisk === '보통' ? 4 : 0) +
        (profitTrend.length && profitTrend.reduce((s, v) => s + v, 0) > 0 ? 12 : 0) +
        (a.ma240 != null && a.price <= a.ma240 * 1.05 ? 10 : 0),
    ),
  );

  const dataQuality: DataQuality = missing.length === 0 ? 'sufficient' : missing.length <= 2 ? 'partial' : 'insufficient';
  if (dataQuality === 'insufficient') return null;

  return finalizeRow(a, 'undervalued', '저평가 후보', reasons, used, missing, risks, score, {
    targetPrice,
    targetBasis,
    stopLoss,
    stopBasis,
    shortTermOutlook: '단기 모멘텀보다 밸류에이션 회복에 무게 — 급등 신호는 아님',
    midTermOutlook: '재무비율과 이익 추세가 유지되면 중기 재평가 여지 (규칙 기반 판단)',
    opinion: score >= 70 && risks.length === 0 ? '매수' : '관망',
    dataQuality,
  });
}

function buildBreakout(a: Analyzed): RecommendationRow | null {
  const used: string[] = ['일봉(캔들)', '현재가/등락률', '거래량·거래대금', 'RSI', 'MACD', '이동평균선'];
  const missing: string[] = [];
  const reasons: string[] = [];

  if (a.overheated) return null; // 이미 과열이면 초기 돌파 아님
  if (a.delistRisk) return null;
  if (a.boxHigh == null || a.boxLow == null) return null;

  // 초기 돌파: 최근 5봉 내에 직전 박스 상단을 돌파했고, 그 이전에는 박스 안이었음.
  const n = a.candles.length;
  const last5 = a.candles.slice(n - 5);
  const brokeNow = a.price > a.boxHigh;
  const firstBreakIdx = last5.findIndex((c) => c.close > a.boxHigh!);
  if (!brokeNow || firstBreakIdx < 0) return null;
  const breakoutAge = 5 - firstBreakIdx; // 1(오늘)~5봉 전
  reasons.push(`직전 60거래일 저항선 돌파 (돌파 ${breakoutAge}거래일째 — 초기 단계)`);

  // 돌파 폭이 이미 과도하면(저항선 대비 +15% 초과) 초기 돌파로 보지 않는다.
  const extension = ((a.price - a.boxHigh) / a.boxHigh) * 100;
  if (extension > 15) return null;

  // 거래량 확인: 평소 대비 1.5배 이상.
  if (a.avgVol20 == null || a.avgVol20 <= 0) {
    missing.push('평균 거래량');
    return null;
  }
  const volRatio = a.lastVol / a.avgVol20;
  if (volRatio < 1.5) return null;
  reasons.push(`거래량 평소 대비 ${round2(volRatio)}배 증가`);

  if (a.boxConsolidation) reasons.push('돌파 전 장기 박스권 수렴 확인');

  if (a.rsi != null) {
    if (a.rsi >= 72) return null;
    reasons.push(`RSI ${round2(a.rsi)} (과열 아님)`);
  } else missing.push('RSI');

  if (a.macdHist != null) {
    if (a.macdHist > 0) reasons.push('MACD 히스토그램 양전환');
  } else missing.push('MACD');

  if (a.ma20 != null && a.ma60 != null) {
    if (a.ma20 > a.ma60 && a.price > a.ma20) reasons.push('20일>60일 이동평균 정배열 초기');
  } else missing.push('이동평균선');

  if (a.ctx.newsScore != null) {
    used.push('뉴스 감성 점수');
    if (a.ctx.newsScore > 20) reasons.push(`뉴스 감성 긍정 (${a.ctx.newsScore})`);
  } else missing.push('뉴스 데이터');
  if ((a.ctx.positiveEvents ?? []).length) {
    used.push('공시 이벤트');
    reasons.push(`긍정 공시: ${(a.ctx.positiveEvents ?? []).slice(0, 2).join(', ')}`);
  }

  // 손절 기준을 계산할 수 없으면 추천하지 않는다 (요구사항).
  let stopLoss: number | null = null;
  let stopBasis = '';
  if (a.boxHigh < a.price) {
    const retest = a.boxHigh * 0.99;
    const atrStop = a.atr != null ? a.price - 2 * a.atr : null;
    const stop = atrStop != null ? Math.max(retest, atrStop) : retest;
    stopLoss = roundPrice(stop, a.entry.currency as 'KRW' | 'USD');
    stopBasis = a.atr != null ? '돌파선 리테스트 하단과 ATR(14) 2배 중 높은 값' : '돌파한 저항선(리테스트) 하단';
  }
  if (stopLoss == null) return null;

  // 목표가: 박스 높이만큼의 측정 이동(measured move).
  const boxHeight = a.boxHigh - a.boxLow;
  let targetPrice: number | null = null;
  let targetBasis = '산출 불가 (박스 높이 산출 실패)';
  if (boxHeight > 0) {
    targetPrice = roundPrice(a.boxHigh + boxHeight, a.entry.currency as 'KRW' | 'USD');
    targetBasis = '박스권 높이 측정 이동 (돌파선 + 박스 높이)';
  }

  const risks = baseRisks(a);
  if (a.fin == null) risks.push(a.finSource === 'none' ? '재무 데이터 없음 — 기술적 신호 위주 후보' : '실제 재무 미확보(샘플 미사용) — 기술적 신호 위주 후보');

  const score = Math.min(
    100,
    Math.round(
      35 +
        Math.min(20, (volRatio - 1.5) * 10) +
        (a.boxConsolidation ? 10 : 0) +
        (a.macdHist != null && a.macdHist > 0 ? 10 : 0) +
        (a.ma20 != null && a.ma60 != null && a.ma20 > a.ma60 ? 10 : 0) +
        (a.ctx.newsScore != null && a.ctx.newsScore > 20 ? 8 : 0) +
        (breakoutAge <= 2 ? 7 : 0),
    ),
  );

  const dataQuality: DataQuality = missing.length === 0 ? 'sufficient' : missing.length <= 2 ? 'partial' : 'insufficient';
  if (dataQuality === 'insufficient') return null;

  return finalizeRow(a, 'breakout', '초기 추세돌파 후보', reasons, used, missing, risks, score, {
    targetPrice,
    targetBasis,
    stopLoss,
    stopBasis,
    shortTermOutlook: `돌파 ${breakoutAge}거래일째 — 거래량 유지 여부가 관건 (규칙 기반 판단)`,
    midTermOutlook: '돌파선 위 안착 시 추세 지속 여지, 이탈 시 손절 기준 준수 필요',
    opinion: score >= 70 && risks.length === 0 ? '매수' : '관망',
    dataQuality,
  });
}

function finalizeRow(
  a: Analyzed,
  category: RecoCategory,
  categoryLabel: string,
  reasons: string[],
  usedData: string[],
  missingData: string[],
  risks: string[],
  score: number,
  extra: Pick<
    RecommendationRow,
    'targetPrice' | 'targetBasis' | 'stopLoss' | 'stopBasis' | 'shortTermOutlook' | 'midTermOutlook' | 'opinion' | 'dataQuality'
  >,
): RecommendationRow {
  const riskLevel: RecommendationRow['riskLevel'] =
    risks.length === 0 ? 'LOW' : risks.length <= 2 ? 'MEDIUM' : 'HIGH';
  return {
    ticker: a.entry.ticker,
    name: a.entry.name,
    market: a.entry.market as 'KR' | 'US',
    currency: a.entry.currency as 'KRW' | 'USD',
    category,
    categoryLabel,
    price: a.price,
    changePercent: a.changePercent,
    reasons,
    usedData,
    missingData,
    risks,
    overheated: a.overheated,
    financialStability: financialStability(a),
    newsRisk: a.newsRisk,
    riskLevel,
    score,
    generatedAt: new Date().toISOString(),
    dataUpdatedAt: a.dataUpdatedAt,
    providers: a.providers,
    ...extra,
  };
}

async function getRecommendations(marketInput: string): Promise<RecommendationResult> {
  const market: 'KR' | 'US' = String(marketInput).toUpperCase() === 'US' ? 'US' : 'KR';

  return cached(`reco:v1:${market}`, REFRESH_MS, async () => {
    const pool = CATALOG.filter(
      (e) => e.market === market && classifyAssetType(e.name, e.market) === 'STOCK',
    ).slice(0, POOL_LIMIT);

    const excludedBreakdown: Record<string, number> = {};
    const analyzed: Analyzed[] = [];

    const settled = await Promise.all(pool.map((entry) => analyze(entry).catch(() => ({ a: null, exclude: 'insufficient_data' as ExcludeReason }))));
    for (const { a, exclude } of settled) {
      if (a) analyzed.push(a);
      else if (exclude && exclude !== 'not_qualified') {
        excludedBreakdown[exclude] = (excludedBreakdown[exclude] ?? 0) + 1;
      }
    }

    const hist = await loadHistory();
    const rows: RecommendationRow[] = [];

    for (const builder of [buildUndervalued, buildBreakout] as const) {
      const built = analyzed
        .map((a) => {
          try {
            return builder(a);
          } catch {
            return null;
          }
        })
        .filter((r): r is RecommendationRow => r !== null)
        .sort((x, y) => y.score - x.score)
        .slice(0, MAX_ROWS_PER_CATEGORY);
      rows.push(...built);
    }

    // 반복 추천 추적: 직전 추천 시각·가격과 그 이후 등락률을 함께 표시.
    const now = new Date().toISOString();
    for (const row of rows) {
      const key = `${row.market}:${row.ticker}:${row.category}`;
      const prev = hist[key];
      if (prev) {
        row.previousGeneratedAt = prev.generatedAt;
        row.previousPrice = prev.price;
        if (prev.price > 0) row.changeSincePrevious = round2(((row.price - prev.price) / prev.price) * 100);
      }
      hist[key] = { generatedAt: now, price: row.price };
    }
    void saveHistory();

    const overheatedExcluded = analyzed.filter((a) => a.overheated).length;
    if (overheatedExcluded) excludedBreakdown.overheated = overheatedExcluded;

    return {
      ok: true,
      provider: 'rule-based-engine',
      analysisMode: 'rule-based' as const,
      aiConfigured: false as const,
      analysisDescription:
        'LLM/AI API 미연결 상태입니다. 이 추천은 실제 시세·거래량·재무비율·뉴스 감성·공시 이벤트를 규칙 기반으로 종합한 결과이며, AI가 작성한 자연어 분석이 아닙니다.',
      market,
      fetchedAt: now,
      generatedAt: now,
      refreshIntervalMs: REFRESH_MS,
      rows,
      excludedCount: Object.values(excludedBreakdown).reduce((s, v) => s + v, 0),
      excludedBreakdown,
      dataQualityNote:
        '조건 미달 종목으로 개수를 채우지 않으며, 샘플(비실측) 재무는 저평가 판단에 사용하지 않습니다.',
    };
  });
}

export const RecommendationService = { getRecommendations };

/**
 * Telegram signal message v2 (owner-approved layout, 2026-10-15).
 *
 * One layout for all six rooms:
 *   title → key numbers → 📌 근거 → 🎯 계획 → 📊 검증 → 출처·시각
 * with a blank line between blocks and a source label on every evidence line.
 *
 * Pure presentation: no network, DB, broker or Bot API access. A message is
 * produced only for an actionable BUY/LONG/SHORT candidate whose price plan
 * and every evidence line are complete; otherwise the result is null and
 * nothing is sent ("매수신호 아님" and unverified items are never sent).
 */

export type SignalMessageMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type SignalMessageDirection = 'BUY' | 'LONG' | 'SHORT';

export type SignalMessageEvidence = {
  text: string;
  /** Where the fact came from, e.g. '검색기', '연구센터 조합', 'KRX 공시'. Required. */
  source: string;
};

export type SignalMessageInput = {
  market: SignalMessageMarket;
  symbol: string;
  name?: string | null;
  direction: SignalMessageDirection;
  strategy: string;
  timeframe: string;
  validationTier: 'RESEARCH_CANDIDATE' | 'FORWARD_VALIDATED' | 'CHAMPION';
  price?: number | null;
  entryZone: { from: number; to: number };
  stopLoss: number;
  targets: number[];
  utilityR?: number | null;
  evidence: SignalMessageEvidence[];
  research?: {
    validationTrades?: number | null;
    validationMeanReturn?: number | null; // decimal, 0.0069 = +0.69%
    validationWinRate?: number | null; // decimal
    holdoutTrades?: number | null;
    holdoutMeanReturn?: number | null;
    holdoutPeriod?: string | null;
  } | null;
  leverage?: { min: number; max: number; hardMaximum: number } | null;
  expiresAt?: string | null;
  observedAt: string;
  sourceLabel?: string;
};

export type SignalMessageButton = { text: string; url: string };
export type SignalMessageV2 = { title: string; details: string; buttons: SignalMessageButton[][] };

export const SIGNAL_SPLIT_V2 = Object.freeze({ buy: Object.freeze([30, 30, 40]), sell: Object.freeze([30, 30, 40]) });

const MARKET_LABEL: Record<SignalMessageMarket, string> = {
  KR_STOCK: '국내주식', US_STOCK: '해외주식', CRYPTO_SPOT: '코인현물', CRYPTO_FUTURES: '코인선물',
};

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function formatSignalPrice(value: number, market: SignalMessageMarket): string {
  if (market === 'KR_STOCK') return Math.round(value).toLocaleString('en-US');
  if (market === 'US_STOCK') return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const digits = value >= 1000 ? 0 : value >= 1 ? 2 : value >= 0.01 ? 4 : 8;
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function signedPercent(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function directionLabel(market: SignalMessageMarket, direction: SignalMessageDirection): string {
  if (market === 'CRYPTO_FUTURES') return direction === 'SHORT' ? '숏(SHORT)' : '롱(LONG)';
  return '매수';
}

function strategyLabel(strategy: string): string {
  const s = strategy.trim().toUpperCase();
  if (s === 'SCALPING') return '단타';
  if (s === 'SWING') return '스윙';
  if (s === 'MID_LONG' || s === 'POSITION') return '중장기';
  if (s === 'COMBINATION_RESEARCH') return '연구 조합';
  return '전략';
}

function timeframeLabel(timeframe: string): string {
  const t = timeframe.trim();
  if (t === '60m' || t === '1H') return '1시간봉';
  const minute = t.match(/^(\d+)m$/u);
  if (minute) return `${minute[1]}분봉`;
  const hour = t.match(/^(\d+)H$/u);
  if (hour) return `${hour[1]}시간봉`;
  if (t === '1D') return '일봉';
  return t;
}

function tierLabel(tier: SignalMessageInput['validationTier']): string {
  if (tier === 'CHAMPION') return '최상위 검증(Champion)';
  if (tier === 'FORWARD_VALIDATED') return '모의매매 검증 완료';
  return '연구 검증 · 실전(모의) 성과는 아직 없음';
}

export function kstLabel(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return `${Number(parts.month)}월 ${Number(parts.day)}일 ${parts.hour}:${parts.minute}`;
}

/** Signed move from the entry reference, positive = in the trade's favour. */
function movePercent(entry: number, price: number, direction: SignalMessageDirection): number {
  return direction === 'SHORT' ? ((entry - price) / entry) * 100 : ((price - entry) / entry) * 100;
}

/**
 * 1·2·3차 entry prices across the entry zone, best price last:
 * BUY/LONG fills from the top of the zone down; SHORT from the bottom up.
 * The 3rd tranche always stays on the safe side of the stop.
 */
export function entryTranchesV2(input: Pick<SignalMessageInput, 'entryZone' | 'stopLoss' | 'direction'>): number[] | null {
  const from = finitePositive(input.entryZone?.from);
  const to = finitePositive(input.entryZone?.to);
  const stop = finitePositive(input.stopLoss);
  if (from == null || to == null || stop == null) return null;
  const low = Math.min(from, to); const high = Math.max(from, to);
  const short = input.direction === 'SHORT';
  const prices = short ? [low, (low + high) / 2, high] : [high, (low + high) / 2, low];
  if (short ? prices[2] >= stop : prices[2] <= stop) return null;
  return prices;
}

function evidenceIsVerified(item: SignalMessageEvidence): boolean {
  return typeof item?.text === 'string' && item.text.trim().length > 0
    && typeof item?.source === 'string' && item.source.trim().length > 0
    && !/미확인|unknown|N\/A/iu.test(item.text);
}

/** Null means: do not send. */
export function renderSignalMessageV2(input: SignalMessageInput, options: { appBaseUrl?: string | null; nowMs?: number } = {}): SignalMessageV2 | null {
  const market = input.market;
  if (!MARKET_LABEL[market]) return null;
  if (market === 'CRYPTO_FUTURES' ? !['LONG', 'SHORT'].includes(input.direction) : input.direction !== 'BUY') return null;
  if (!/^[A-Za-z0-9.\-_/]{1,30}$/u.test(String(input.symbol ?? ''))) return null;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  if (input.expiresAt && !(Date.parse(input.expiresAt) > nowMs)) return null;
  const tranches = entryTranchesV2(input);
  const stop = finitePositive(input.stopLoss);
  const targets = (Array.isArray(input.targets) ? input.targets : []).map(finitePositive).filter((v): v is number => v != null).slice(0, 3);
  if (!tranches || stop == null || targets.length === 0) return null;
  const entryRef = (input.entryZone.from + input.entryZone.to) / 2;
  if (targets.some((target) => movePercent(entryRef, target, input.direction) <= 0)) return null;
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).filter(evidenceIsVerified).slice(0, 6);
  if (evidence.length === 0) return null;
  const observed = kstLabel(input.observedAt);
  if (!observed) return null;

  const fmt = (value: number) => formatSignalPrice(value, market);
  const name = input.name?.trim() ? `${input.name.trim()} (${input.symbol})` : input.symbol;
  const dot = input.direction === 'SHORT' ? '🔴' : '🟢';
  const title = `${dot} [${MARKET_LABEL[market]}] ${name} · ${directionLabel(market, input.direction)} 신호`;

  const stopMove = movePercent(entryRef, stop, input.direction);
  const firstTargetMove = movePercent(entryRef, targets[0], input.direction);
  const rewardRisk = Math.abs(stopMove) > 0 ? firstTargetMove / Math.abs(stopMove) : null;
  const price = finitePositive(input.price);

  const lines: string[] = [];
  lines.push(`${strategyLabel(input.strategy)} · ${timeframeLabel(input.timeframe)}`);
  lines.push('');
  if (price != null) lines.push(`💰 현재가 ${fmt(price)}`);
  lines.push(`진입 ${fmt(Math.min(input.entryZone.from, input.entryZone.to))} ~ ${fmt(Math.max(input.entryZone.from, input.entryZone.to))}`);
  lines.push(`목표 ${targets.map((t, i) => `${i + 1}차 ${fmt(t)} (${signedPercent(movePercent(entryRef, t, input.direction))})`).join(' / ')}`);
  lines.push(`손절 ${fmt(stop)} (${signedPercent(stopMove)})`);
  const keyExtras: string[] = [];
  if (rewardRisk != null && Number.isFinite(rewardRisk)) keyExtras.push(`손익비 1 : ${rewardRisk.toFixed(1)}`);
  if (typeof input.utilityR === 'number' && Number.isFinite(input.utilityR)) keyExtras.push(`비용 뺀 기대값 ${input.utilityR >= 0 ? '+' : ''}${input.utilityR.toFixed(2)}R`);
  if (keyExtras.length) lines.push(keyExtras.join(' · '));
  if (market === 'CRYPTO_FUTURES' && input.leverage) {
    lines.push(`레버리지 참고 ${input.leverage.min}~${input.leverage.max}배 (최대 ${input.leverage.hardMaximum}배)`);
  }

  lines.push('', '📌 근거');
  for (const item of evidence) lines.push(`· ${item.text.trim()} (${item.source.trim()})`);

  const buy = SIGNAL_SPLIT_V2.buy; const sell = SIGNAL_SPLIT_V2.sell;
  const verb = input.direction === 'SHORT' ? ['숏 진입', '숏 정리'] : ['매수', '매도'];
  lines.push('', '🎯 계획');
  lines.push(`· ${verb[0]} 1·2·3차 ${buy.join('/')}%: ${tranches.map(fmt).join(' → ')}`);
  lines.push(`· ${verb[1]} 1·2·3차 ${sell.slice(0, targets.length).join('/')}%: ${targets.map(fmt).join(' → ')}`);
  lines.push(`· 손절 ${fmt(stop)} 닿으면 전량 정리`);
  lines.push('· 1차 목표가 먼저 닿으면 남은 진입 주문 취소');
  lines.push('· 비중은 앱 주문창에서 바꿀 수 있어요');

  lines.push('', '📊 검증');
  lines.push(`· 단계: ${tierLabel(input.validationTier)}`);
  const r = input.research;
  if (r) {
    if (Number.isFinite(r.validationTrades) && Number.isFinite(r.validationMeanReturn)) {
      const win = Number.isFinite(r.validationWinRate) ? ` · 승률 ${Math.round(Number(r.validationWinRate) * 100)}%` : '';
      lines.push(`· 과거 검증 ${r.validationTrades}회 · 거래당 ${signedPercent(Number(r.validationMeanReturn) * 100, 2)}${win}`);
    }
    if (Number.isFinite(r.holdoutTrades) && Number.isFinite(r.holdoutMeanReturn)) {
      lines.push(`· 2026 봉인 데이터 확인 ${r.holdoutTrades}회 · 거래당 ${signedPercent(Number(r.holdoutMeanReturn) * 100, 2)}${r.holdoutPeriod ? ` (${r.holdoutPeriod})` : ''}`);
    }
  }
  lines.push('· 수수료·세금·슬리피지 반영 기준');

  lines.push('', `🕒 ${observed} 기준 · ${input.sourceLabel?.trim() || '신호검색기'}`);
  lines.push('🔒 알림만 보내요. 주문은 앱에서 직접 확인 후 진행돼요.');

  return { title, details: lines.join('\n'), buttons: signalButtonsV2(input, options.appBaseUrl) };
}

/** [🛒 구매] opens the app's order check (re-verified on current data); [📊 차트] the AI chart. */
export function signalButtonsV2(input: Pick<SignalMessageInput, 'market' | 'symbol' | 'direction' | 'timeframe' | 'strategy'>, appBaseUrl?: string | null): SignalMessageButton[][] {
  if (!appBaseUrl) return [];
  let base: URL;
  try { base = new URL(appBaseUrl); } catch { return []; }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return [];
  const market = input.market === 'KR_STOCK' ? 'KR' : input.market === 'US_STOCK' ? 'US' : input.market === 'CRYPTO_SPOT' ? 'UPBIT' : 'BITGET';
  const assetType = input.market === 'KR_STOCK' || input.market === 'US_STOCK' ? 'stock' : 'crypto';
  const order = new URL('/telegram-order', base);
  order.searchParams.set('market', market);
  order.searchParams.set('symbol', input.symbol);
  order.searchParams.set('timeframe', input.timeframe);
  order.searchParams.set('action', input.direction);
  order.searchParams.set('strategyMode', input.strategy.toLowerCase() === 'mid_long' ? 'position' : input.strategy.toLowerCase());
  order.searchParams.set('orderPreparation', '1');
  order.searchParams.set('source', 'telegram');
  const chart = new URL('/ai-chart', base);
  chart.searchParams.set('assetType', assetType);
  chart.searchParams.set('market', market);
  chart.searchParams.set('symbol', input.symbol);
  chart.searchParams.set('ticker', input.symbol);
  chart.searchParams.set('timeframe', input.timeframe);
  const buyText = input.direction === 'SHORT' ? '🛒 숏 주문' : input.direction === 'LONG' ? '🛒 롱 주문' : '🛒 구매';
  return [[{ text: buyText, url: order.toString() }, { text: '📊 차트', url: chart.toString() }]];
}

/** One line for a room with no new signal in the period. */
export function renderNoSignalLineV2(market: SignalMessageMarket, periodLabel: string, scannedCount?: number | null): string {
  const scanned = Number.isSafeInteger(scannedCount) && Number(scannedCount) > 0 ? ` (${Number(scannedCount).toLocaleString('en-US')}종목 확인)` : '';
  return `📭 ${MARKET_LABEL[market]} · ${periodLabel} 새 신호 없음${scanned}`;
}

/** Maps a Signal V3 snapshot row (with cycle signalPlan) to the message input. */
export function signalMessageInputFromV3Row(row: Record<string, any>): SignalMessageInput | null {
  const plan = row?.provenance?.signalPlan;
  if (!plan || !plan.entryZone) return null;
  const research = row?.provenance?.researchEvidence;
  const evidence: SignalMessageEvidence[] = [];
  if (research?.source === 'RESEARCH_COMBINATION_HOLDOUT_PASSED' && Array.isArray(research.labels)) {
    for (const label of research.labels.slice(0, 3)) evidence.push({ text: String(label), source: '연구센터 조합' });
  }
  for (const reason of Array.isArray(plan.reasons) ? plan.reasons.slice(0, 3) : []) {
    evidence.push({ text: String(reason), source: '검색기' });
  }
  const leverage = row?.leverage?.status === 'INDICATIVE_ONLY' && row.leverage.recommendedRange
    ? { min: row.leverage.recommendedRange.min, max: row.leverage.recommendedRange.max, hardMaximum: row.leverage.hardMaximum }
    : null;
  return {
    market: row.market,
    symbol: row.symbol,
    name: plan.name ?? null,
    direction: row.direction,
    strategy: row.strategy,
    timeframe: row.timeframe,
    validationTier: row.validationTier,
    price: plan.price ?? null,
    entryZone: plan.entryZone,
    stopLoss: plan.stopLoss,
    targets: plan.targets ?? [],
    utilityR: typeof row.utilityR === 'number' ? row.utilityR : null,
    evidence,
    research: research ? {
      validationTrades: research.validation?.trades ?? null,
      validationMeanReturn: research.validation?.meanReturn ?? null,
      validationWinRate: research.validation?.winRate ?? null,
      holdoutTrades: research.holdout?.trades ?? null,
      holdoutMeanReturn: research.holdout?.meanReturn ?? null,
      holdoutPeriod: research.holdout?.period ? `${research.holdout.period.start}~${research.holdout.period.end}` : null,
    } : null,
    leverage,
    expiresAt: row.provenance?.sourceExpiresAt ?? null,
    observedAt: row.sourceAsOf,
    sourceLabel: research ? '신호검색기 + 연구센터' : '신호검색기',
  };
}

import { classifyStock } from './stock-classifier';
import { translateMarketText } from './stock-display';
import {
  buildEvidenceAnalysis,
  evidenceLeadSummary,
  evidenceScore,
} from './evidence-analysis';

type AnyObj = Record<string, any>;

export interface AiInsightInput {
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  quote?: AnyObj | null;
  financials?: AnyObj | null;
  risk?: AnyObj | null;
  news?: AnyObj[] | null;
  filings?: AnyObj[] | null;
  candles?: AnyObj[] | null;
}

export interface AiInsightResult {
  score: number;
  opinion: '매수' | '보류' | '매도';
  opinionReason: string;
  gradeText: string;
  financialSummary: string[];
  chartSummary: string[];
  newsDisclosureSummary: string[];
  riskSummary: string[];
  disclosureAiSummary: string;
  newsAiSummary: string;
  catalystSummary: string;
  evidenceWarning: string;
  analysisBasis: 'deterministic-evidence';
  classification: ReturnType<typeof classifyStock>;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').replace(/%/g, '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function arr(value: unknown): AnyObj[] {
  return Array.isArray(value) ? value : [];
}

function latestFinancialRows(financials?: AnyObj | null) {
  return [
    ...arr(financials?.quarterly),
    ...arr(financials?.annual),
    ...arr(financials?.rows),
  ].filter(Boolean);
}

function latestRow(financials?: AnyObj | null) {
  return latestFinancialRows(financials)[0] ?? {};
}

function previousRow(financials?: AnyObj | null) {
  return latestFinancialRows(financials)[1] ?? {};
}

function growthText(label: string, current: number | null, previous: number | null) {
  if (current == null || previous == null || previous === 0) {
    return `${label} 데이터는 추가 확인이 필요합니다.`;
  }
  const growth = ((current - previous) / Math.abs(previous)) * 100;
  if (growth > 0) return `직전 비교기간 대비 ${label}이 ${growth.toFixed(1)}% 증가했습니다.`;
  if (growth < 0) return `직전 비교기간 대비 ${label}이 ${Math.abs(growth).toFixed(1)}% 감소했습니다.`;
  return `직전 비교기간 대비 ${label}은 큰 변화가 없습니다.`;
}

function ratioComment(label: string, value: number | null) {
  if (value == null) return `${label} 데이터는 추가 확인이 필요합니다.`;
  if (label === 'PER') {
    if (value <= 0) return 'PER은 적자 또는 산정불가 구간입니다.';
    if (value <= 10) return `PER ${value.toFixed(1)}배로 낮은 편입니다.`;
    if (value <= 25) return `PER ${value.toFixed(1)}배로 보통 수준입니다.`;
    if (value <= 40) return `PER ${value.toFixed(1)}배로 높은 편입니다.`;
    return `PER ${value.toFixed(1)}배로 매우 높은 편입니다.`;
  }
  if (label === 'PBR') {
    if (value <= 0) return 'PBR은 산정불가 구간입니다.';
    if (value <= 1) return `PBR ${value.toFixed(2)}배로 낮은 편입니다.`;
    if (value <= 3) return `PBR ${value.toFixed(2)}배로 보통 수준입니다.`;
    if (value <= 7) return `PBR ${value.toFixed(2)}배로 높은 편입니다.`;
    return `PBR ${value.toFixed(2)}배로 매우 높은 편입니다.`;
  }
  if (label === 'ROE') {
    if (value < 0) return `ROE ${value.toFixed(1)}%로 부진합니다.`;
    if (value < 5) return `ROE ${value.toFixed(1)}%로 낮은 편입니다.`;
    if (value < 15) return `ROE ${value.toFixed(1)}%로 보통 수준입니다.`;
    return `ROE ${value.toFixed(1)}%로 우수합니다.`;
  }
  return `${label} ${value}`;
}

function buildFinancialScore(financials?: AnyObj | null) {
  const latest = latestRow(financials);
  const prev = previousRow(financials);
  const ratios = financials?.ratios ?? {};
  let score = 12;
  const revenue = num(latest.revenue);
  const prevRevenue = num(prev.revenue);
  const operatingIncome = num(latest.operatingIncome);
  const netIncome = num(latest.netIncome);
  const debtRatio = num(ratios.debtRatio ?? latest.debtRatio);
  const roe = num(ratios.roe);

  if (revenue != null && prevRevenue != null && prevRevenue !== 0) {
    const growth = ((revenue - prevRevenue) / Math.abs(prevRevenue)) * 100;
    if (growth >= 20) score += 5;
    else if (growth > 0) score += 3;
    else score -= 2;
  }
  if (operatingIncome != null && operatingIncome > 0) score += 4;
  else if (operatingIncome != null && operatingIncome < 0) score -= 4;
  if (netIncome != null && netIncome > 0) score += 3;
  else if (netIncome != null && netIncome < 0) score -= 3;
  if (debtRatio != null && debtRatio <= 100) score += 3;
  else if (debtRatio != null && debtRatio > 200) score -= 4;
  if (roe != null && roe >= 15) score += 3;
  else if (roe != null && roe < 0) score -= 3;
  return Math.max(0, Math.min(25, score));
}

function buildValuationScore(financials?: AnyObj | null) {
  const ratios = financials?.ratios ?? {};
  const per = num(ratios.per);
  const pbr = num(ratios.pbr);
  const roe = num(ratios.roe);
  let score = 7;
  if (per != null && per > 0 && per <= 12) score += 3;
  else if (per != null && per >= 40) score -= 2;
  if (pbr != null && pbr > 0 && pbr <= 1.2) score += 3;
  else if (pbr != null && pbr >= 7) score -= 2;
  if (roe != null && roe >= 15) score += 2;
  else if (roe != null && roe < 0) score -= 2;
  return Math.max(0, Math.min(15, score));
}

function buildChartScore(input: AiInsightInput, evidence: ReturnType<typeof buildEvidenceAnalysis>) {
  const price = evidence.price;
  let score = 12;
  const change = price.changePercent ?? 0;
  if (change >= 3) score += 4;
  else if (change > 0) score += 2;
  else if (change <= -5) score -= 4;
  else if (change < 0) score -= 2;

  if (price.regime === 'strong-uptrend') score += 6;
  else if (price.regime === 'uptrend') score += 3;
  else if (price.regime === 'strong-downtrend') score -= 6;
  else if (price.regime === 'downtrend') score -= 3;
  if (price.breakout === 'up') score += 2;
  else if (price.breakout === 'down') score -= 2;
  if (change >= 15) score -= 4;
  if (price.rangePercent != null && price.rangePercent >= 7) score -= 2;
  return Math.max(0, Math.min(25, score));
}

function buildNewsDisclosureScore(evidence: ReturnType<typeof buildEvidenceAnalysis>) {
  const raw = evidenceScore(evidence.news) + evidenceScore(evidence.filings);
  return Math.max(0, Math.min(20, 10 + Math.round(raw / 2)));
}

function buildStabilityScore(input: AiInsightInput) {
  const marketCap = num(input.quote?.marketCap);
  let score = 7;
  if (input.currency === 'USD') {
    if (marketCap != null && marketCap >= 10_000_000_000) score += 7;
    else if (marketCap != null && marketCap < 770_000) score -= 7;
  } else {
    if (marketCap != null && marketCap >= 5_000_000_000_000) score += 7;
    else if (marketCap != null && marketCap < 1_000_000_000) score -= 7;
  }
  return Math.max(0, Math.min(15, score));
}

function gradeText(score: number) {
  if (score >= 80) return '매우 우수';
  if (score >= 65) return '양호';
  if (score >= 50) return '보통';
  if (score >= 35) return '주의';
  return '고위험';
}

function opinion(score: number, classificationLabel: string) {
  if (classificationLabel === '잡주' && score < 55) return '매도' as const;
  if (score >= 70) return '매수' as const;
  if (score <= 42) return '매도' as const;
  return '보류' as const;
}

function opinionReason(score: number, opinionValue: '매수' | '보류' | '매도', evidenceWarning: string) {
  const prefix = `규칙·근거 기반 종합점수 ${score}점입니다.`;
  if (opinionValue === '매수') {
    return `${prefix} 재무·가격·이벤트 흐름이 상대적으로 양호합니다. 추격매수보다 지지선과 손절 기준을 정한 분할 접근이 안전합니다. ${evidenceWarning}`;
  }
  if (opinionValue === '매도') {
    return `${prefix} 현재 확인된 리스크가 수익 기대보다 큽니다. 지지선 이탈, 악재성 공시, 재무 부담 여부를 우선 확인해야 합니다. ${evidenceWarning}`;
  }
  return `${prefix} 방향성이 엇갈립니다. 가격 추세와 뉴스·공시 재료가 같은 방향으로 확인되는지 더 지켜볼 필요가 있습니다. ${evidenceWarning}`;
}

function regimeText(regime: ReturnType<typeof buildEvidenceAnalysis>['price']['regime']) {
  if (regime === 'strong-uptrend') return '20일선과 중기선 정렬상 상승 추세 우위입니다.';
  if (regime === 'uptrend') return '단기 가격은 20일선 위로 상승 우위입니다.';
  if (regime === 'strong-downtrend') return '20일선과 중기선 정렬상 하락 추세 우위입니다.';
  if (regime === 'downtrend') return '단기 가격은 20일선 아래로 약세 우위입니다.';
  if (regime === 'mixed') return '단기·중기 추세가 엇갈리는 혼조 구간입니다.';
  return '추세 판정에 필요한 캔들 데이터가 부족합니다.';
}

export function buildAiInsights(input: AiInsightInput): AiInsightResult {
  const financials = input.financials;
  const latest = latestRow(financials);
  const prev = previousRow(financials);
  const ratios = financials?.ratios ?? {};
  const evidence = buildEvidenceAnalysis({
    quote: input.quote,
    news: input.news,
    filings: input.filings,
    candles: input.candles,
  });

  const financialScore = buildFinancialScore(financials);
  const valuationScore = buildValuationScore(financials);
  const chartScore = buildChartScore(input, evidence);
  const newsScore = buildNewsDisclosureScore(evidence);
  const stabilityScore = buildStabilityScore(input);
  const score = clamp(financialScore + valuationScore + chartScore + newsScore + stabilityScore);

  const classification = classifyStock({
    ticker: input.ticker,
    name: input.name,
    aiScore: score,
    score,
    market: input.market,
    currency: input.currency,
    changePercent: input.quote?.changePercent,
    marketCap: input.quote?.marketCap,
    per: ratios.per,
    pbr: ratios.pbr,
    roe: ratios.roe,
    debtRatio: ratios.debtRatio,
    revenueGrowth: financials?.growth?.revenue?.[0],
    operatingIncome: latest.operatingIncome,
    netIncome: latest.netIncome,
    equity: latest.equity,
    debt: latest.debt,
    news: (input.news ?? []).map((item) => `${item.title ?? ''} ${item.summary ?? ''}`),
    disclosures: (input.filings ?? []).map((item) =>
      `${item.title ?? ''} ${item.description ?? ''} ${item.summary ?? ''} ${item.eventLabels ?? ''}`,
    ),
  });

  const finalOpinion = opinion(score, classification.label);
  const revenue = num(latest.revenue);
  const prevRevenue = num(prev.revenue);
  const operatingIncome = num(latest.operatingIncome);
  const netIncome = num(latest.netIncome);
  const debtRatio = num(ratios.debtRatio ?? latest.debtRatio);

  const financialSummary = [
    growthText('매출', revenue, prevRevenue),
    operatingIncome == null
      ? '영업이익 데이터는 추가 확인이 필요합니다.'
      : operatingIncome > 0 ? '영업이익은 흑자입니다.' : '영업이익은 적자라 수익성 개선이 필요합니다.',
    netIncome == null
      ? '순이익 데이터는 추가 확인이 필요합니다.'
      : netIncome > 0 ? '순이익은 흑자입니다.' : '순이익은 적자라 주의가 필요합니다.',
    debtRatio == null
      ? '부채비율 데이터는 추가 확인이 필요합니다.'
      : debtRatio <= 100
        ? `부채비율은 ${debtRatio.toFixed(1)}%로 안정적인 편입니다.`
        : debtRatio <= 200
          ? `부채비율은 ${debtRatio.toFixed(1)}%로 보통 수준입니다.`
          : `부채비율은 ${debtRatio.toFixed(1)}%로 높은 편입니다.`,
    ratioComment('PER', num(ratios.per)),
    ratioComment('PBR', num(ratios.pbr)),
    ratioComment('ROE', num(ratios.roe)),
  ].slice(0, 6);

  const price = evidence.price;
  const chartSummary = [
    price.changePercent == null
      ? '오늘 등락률 데이터는 추가 확인이 필요합니다.'
      : price.changePercent > 0
        ? `오늘 등락률은 +${price.changePercent.toFixed(2)}%입니다.`
        : price.changePercent < 0
          ? `오늘 등락률은 ${price.changePercent.toFixed(2)}%입니다.`
          : '오늘 주가는 보합권입니다.',
    regimeText(price.regime),
    price.volumeRatio == null
      ? '최근 평균 대비 거래량 비교 데이터가 부족합니다.'
      : `최근 거래량은 직전 평균의 ${price.volumeRatio.toFixed(1)}배입니다.`,
    price.momentum5 == null
      ? '5봉 모멘텀 계산 데이터가 부족합니다.'
      : `5봉 가격 모멘텀은 ${price.momentum5 >= 0 ? '+' : ''}${price.momentum5.toFixed(1)}%입니다.`,
    price.breakout === 'up'
      ? '최근 가격대 상단을 종가로 돌파한 상태입니다.'
      : price.breakout === 'down'
        ? '최근 가격대 하단을 종가로 이탈한 상태입니다.'
        : price.breakout === 'none'
          ? '최근 가격대 안에서 움직이고 있어 확정 돌파 신호는 없습니다.'
          : '돌파 판정에 필요한 데이터가 부족합니다.',
    evidence.catalystSummary,
  ];

  const newsLead = evidenceLeadSummary(evidence.news, '최근 관련 뉴스 데이터가 부족합니다.');
  const filingLead = evidenceLeadSummary(evidence.filings, '최근 확인된 공시 데이터가 부족합니다.');
  const newsDisclosureSummary = [
    `뉴스 분석 · ${newsLead}`,
    `공시 분석 · ${filingLead}`,
    `가격 원인 후보 · ${evidence.catalystSummary}`,
    `근거 한계 · ${evidence.evidenceWarning}`,
  ].map(translateMarketText);

  const riskSummary = [
    classification.delistingWarning
      ? '상장폐지 경고 조건이 확인되어 매우 주의가 필요합니다.'
      : '현재 수집된 데이터에서 명확한 상장폐지 경고 조건은 확인되지 않았습니다.',
    classification.riskCaption,
    evidence.filings.some((item) => item.tags.includes('희석위험'))
      ? '최근 공시 분류에서 유상증자·전환증권 등 희석 가능성 관련 신호가 있어 세부 조건 확인이 필요합니다.'
      : '현재 수집된 공시 분류에서는 뚜렷한 희석 위험 신호가 확인되지 않았습니다.',
    price.rangePercent != null && price.rangePercent >= 7
      ? `최근 평균 일중 변동폭이 약 ${price.rangePercent.toFixed(1)}%로 큰 편입니다.`
      : '가격 변동성은 현재 데이터 범위에서 극단적 경고 구간으로 분류되지 않았습니다.',
    evidence.evidenceWarning,
  ];

  return {
    score,
    opinion: finalOpinion,
    opinionReason: translateMarketText(opinionReason(score, finalOpinion, evidence.evidenceWarning)),
    gradeText: gradeText(score),
    financialSummary,
    chartSummary: chartSummary.map(translateMarketText),
    newsDisclosureSummary,
    riskSummary: riskSummary.map(translateMarketText),
    disclosureAiSummary: translateMarketText(filingLead),
    newsAiSummary: translateMarketText(newsLead),
    catalystSummary: translateMarketText(evidence.catalystSummary),
    evidenceWarning: translateMarketText(evidence.evidenceWarning),
    analysisBasis: 'deterministic-evidence',
    classification,
  };
}

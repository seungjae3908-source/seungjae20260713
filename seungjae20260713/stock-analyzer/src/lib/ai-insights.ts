import { classifyStock } from './stock-classifier';
import {
  eventLabelKo,
  summarizeText,
  translateMarketText,
} from './stock-display';

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
  classification: ReturnType<typeof classifyStock>;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').replace(/%/g, ''));

    if (Number.isFinite(parsed)) return parsed;
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
  const rows = [
    ...arr(financials?.quarterly),
    ...arr(financials?.annual),
    ...arr(financials?.rows),
  ];

  return rows.filter(Boolean);
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

  if (growth > 0) {
    return `전분기 대비 ${label}이 ${growth.toFixed(1)}% 증가했습니다.`;
  }

  if (growth < 0) {
    return `전분기 대비 ${label}이 ${Math.abs(growth).toFixed(1)}% 감소했습니다.`;
  }

  return `전분기 대비 ${label}은 큰 변화가 없습니다.`;
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

function latestClose(candles?: AnyObj[] | null) {
  const list = arr(candles);
  const last = list[list.length - 1];

  return num(last?.close);
}

function average(values: number[]) {
  if (!values.length) return null;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function movingAverage(candles: AnyObj[] | null | undefined, days: number) {
  const closes = arr(candles)
    .map((candle) => num(candle.close))
    .filter((value): value is number => value != null);

  return average(closes.slice(-days));
}

function newsToneScore(news: AnyObj[]) {
  let score = 0;

  for (const item of news) {
    const text = `${item.title ?? ''} ${item.summary ?? ''} ${item.tone ?? ''}`.toLowerCase();

    if (/positive|호재|승인|계약|수주|실적 개선|흑자/.test(text)) score += 1;
    if (/negative|악재|소송|실패|희석|offering|delisting|상장폐지/.test(text)) score -= 1;
  }

  return score;
}

function filingRiskScore(filings: AnyObj[]) {
  let score = 0;

  for (const item of filings) {
    const text = `${item.title ?? ''} ${item.description ?? ''} ${item.form ?? ''} ${
      item.events ?? ''
    } ${item.eventLabels ?? ''}`.toLowerCase();

    if (/contract|계약|수주|approval|승인/.test(text)) score += 1;
    if (/offering|atm|유상증자|전환사채|희석/.test(text)) score -= 2;
    if (/delisting|상장폐지|deficiency|거래정지|관리종목/.test(text)) score -= 4;
  }

  return score;
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

function buildChartScore(input: AiInsightInput) {
  const change = num(input.quote?.changePercent) ?? 0;
  const candles = input.candles ?? [];
  const close = latestClose(candles);
  const ma20 = movingAverage(candles, 20);
  const ma60 = movingAverage(candles, 60);

  let score = 12;

  if (change >= 3) score += 4;
  else if (change > 0) score += 2;
  else if (change <= -5) score -= 4;
  else if (change < 0) score -= 2;

  if (close != null && ma20 != null && close > ma20) score += 4;
  if (close != null && ma60 != null && close > ma60) score += 3;
  if (change >= 15) score -= 4;

  return Math.max(0, Math.min(25, score));
}

function buildNewsDisclosureScore(input: AiInsightInput) {
  const news = input.news ?? [];
  const filings = input.filings ?? [];

  let score = 10;

  score += newsToneScore(news) * 2;
  score += filingRiskScore(filings) * 2;

  return Math.max(0, Math.min(20, score));
}

function buildStabilityScore(input: AiInsightInput) {
  const marketCap = num(input.quote?.marketCap);
  const currency = input.currency;

  let score = 7;

  if (currency === 'USD') {
    if (marketCap != null && marketCap >= 10_000_000_000) score += 7;
    else if (marketCap != null && marketCap < 770_000) score -= 7;
  } else {
    if (marketCap != null && marketCap >= 5_0000_0000_0000) score += 7;
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
  if (classificationLabel === '잡주' && score < 55) return '매도';
  if (score >= 70) return '매수';
  if (score <= 42) return '매도';

  return '보류';
}

function opinionReason(score: number, opinionValue: '매수' | '보류' | '매도') {
  if (opinionValue === '매수') {
    return `AI 종합점수 ${score}점으로 재무·차트·뉴스 흐름이 상대적으로 양호합니다. 다만 추격매수보다 지지선과 손절 기준을 정한 분할 접근이 안전합니다.`;
  }

  if (opinionValue === '매도') {
    return `AI 종합점수 ${score}점으로 리스크가 수익 기대보다 큽니다. 지지선 이탈, 악재성 공시, 재무 부담 여부를 우선 확인해야 합니다.`;
  }

  return `AI 종합점수 ${score}점으로 방향성이 애매합니다. 재무나 시총은 버틸 수 있어도 차트 모멘텀 또는 뉴스·공시 재료가 부족해 관망이 적절합니다.`;
}

export function buildAiInsights(input: AiInsightInput): AiInsightResult {
  const financials = input.financials;
  const latest = latestRow(financials);
  const prev = previousRow(financials);
  const ratios = financials?.ratios ?? {};

  const financialScore = buildFinancialScore(financials);
  const valuationScore = buildValuationScore(financials);
  const chartScore = buildChartScore(input);
  const newsScore = buildNewsDisclosureScore(input);
  const stabilityScore = buildStabilityScore(input);

  const score = clamp(
    financialScore + valuationScore + chartScore + newsScore + stabilityScore,
  );

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
    disclosures: (input.filings ?? []).map(
      (item) =>
        `${item.title ?? ''} ${item.description ?? ''} ${item.summary ?? ''} ${
          item.eventLabels ?? ''
        }`,
    ),
  });

  const finalOpinion = opinion(score, classification.label);

  const revenue = num(latest.revenue);
  const prevRevenue = num(prev.revenue);
  const operatingIncome = num(latest.operatingIncome);
  const netIncome = num(latest.netIncome);
  const debtRatio = num(ratios.debtRatio ?? latest.debtRatio);

  const close = latestClose(input.candles);
  const ma20 = movingAverage(input.candles, 20);
  const ma60 = movingAverage(input.candles, 60);
  const previousCandles = arr(input.candles).slice(0, -1);
  const previousClose = latestClose(previousCandles);
  const previousMa20 = movingAverage(previousCandles, 20);
  const previousMa60 = movingAverage(previousCandles, 60);

  const financialSummary = [
    growthText('매출', revenue, prevRevenue),
    operatingIncome == null
      ? '영업이익 데이터는 추가 확인이 필요합니다.'
      : operatingIncome > 0
        ? '영업이익은 흑자입니다.'
        : '영업이익은 적자라 수익성 개선이 필요합니다.',
    netIncome == null
      ? '순이익 데이터는 추가 확인이 필요합니다.'
      : netIncome > 0
        ? '순이익은 흑자입니다.'
        : '순이익은 적자라 주의가 필요합니다.',
    debtRatio == null
      ? '부채비율 데이터는 추가 확인이 필요합니다.'
      : debtRatio <= 100
        ? `부채비율은 ${debtRatio.toFixed(1)}%로 안정적입니다.`
        : debtRatio <= 200
          ? `부채비율은 ${debtRatio.toFixed(1)}%로 보통 수준입니다.`
          : `부채비율은 ${debtRatio.toFixed(1)}%로 높은 편입니다.`,
    ratioComment('PER', num(ratios.per)),
    ratioComment('PBR', num(ratios.pbr)),
    ratioComment('ROE', num(ratios.roe)),
  ].slice(0, 6);

  const chartSummary: string[] = [];
  if (previousClose != null && previousMa20 != null && close != null && ma20 != null) {
    if (previousClose <= previousMa20 && close > ma20) chartSummary.push('20일선을 상향 돌파하는 차트 신호가 새로 발생했습니다.');
    if (previousClose >= previousMa20 && close < ma20) chartSummary.push('20일선을 하향 이탈하는 차트 신호가 새로 발생했습니다.');
  }
  if (previousClose != null && previousMa60 != null && close != null && ma60 != null) {
    if (previousClose <= previousMa60 && close > ma60) chartSummary.push('60일선을 상향 돌파하는 차트 신호가 새로 발생했습니다.');
    if (previousClose >= previousMa60 && close < ma60) chartSummary.push('60일선을 하향 이탈하는 차트 신호가 새로 발생했습니다.');
  }
  if (chartSummary.length === 0) chartSummary.push('현재 봉에서 새로 발생한 이동평균 돌파·이탈 신호는 없습니다.');

  const filingScore = filingRiskScore(input.filings ?? []);
  const newsTone = newsToneScore(input.news ?? []);

  const newsDisclosureSummary = [
    (input.news ?? []).length
      ? newsTone > 0
        ? '최근 뉴스 흐름은 긍정적인 내용이 더 많습니다.'
        : newsTone < 0
          ? '최근 뉴스에는 주의가 필요한 악재성 내용이 있습니다.'
          : '최근 뉴스는 중립적인 흐름입니다.'
      : '최근 관련 뉴스 데이터가 부족합니다.',
    (input.filings ?? []).length
      ? filingScore > 0
        ? '최근 공시는 계약·승인 등 긍정적 이벤트가 일부 확인됩니다.'
        : filingScore < 0
          ? '최근 공시에는 희석 또는 상장 관련 리스크가 포함될 수 있습니다.'
          : '최근 공시는 중립적인 내용이 중심입니다.'
      : '최근 확인된 공시 데이터가 부족합니다.',
  ];

  const riskSummary = [
    classification.delistingWarning
      ? '상장폐지 경고 조건이 확인되어 매우 주의가 필요합니다.'
      : '명확한 상장폐지 경고 조건은 확인되지 않았습니다.',
    classification.riskCaption,
    classification.label === '잡주'
      ? '고위험 종목으로 분류되어 비중 조절과 손절 기준이 중요합니다.'
      : '분류상 극단적 고위험 종목은 아닙니다.',
  ];

  const filings = input.filings ?? [];
  const news = input.news ?? [];

  const disclosureAiSummary =
    filings.length === 0
      ? '최근 확인된 공시가 부족합니다.'
      : filingScore > 0
        ? `최근 공시는 ${eventLabelKo(
            filings[0]?.eventLabels?.[0] ?? filings[0]?.title ?? filings[0]?.form,
          )} 중심으로 긍정적입니다. ${summarizeText(
            filings[0]?.translatedSummary ?? filings[0]?.summary ?? filings[0]?.description,
            '',
          )}`
        : filingScore < 0
          ? `최근 공시에는 리스크 확인이 필요합니다. ${summarizeText(
              filings[0]?.translatedSummary ??
                filings[0]?.summary ??
                filings[0]?.description ??
                filings[0]?.title,
              '',
            )}`
          : `최근 공시는 중립적인 내용입니다. ${summarizeText(
              filings[0]?.translatedSummary ??
                filings[0]?.summary ??
                filings[0]?.description ??
                filings[0]?.title,
              '',
            )}`;

  const newsAiSummary =
    news.length === 0
      ? '최근 관련 뉴스가 부족합니다.'
      : newsTone > 0
        ? `최근 뉴스는 긍정적 흐름입니다. ${summarizeText(
            news[0]?.translatedSummary ?? news[0]?.summary ?? news[0]?.title,
            '',
          )}`
        : newsTone < 0
          ? `최근 뉴스에는 주의할 내용이 있습니다. ${summarizeText(
              news[0]?.translatedSummary ?? news[0]?.summary ?? news[0]?.title,
              '',
            )}`
          : `최근 뉴스는 중립적인 흐름입니다. ${summarizeText(
              news[0]?.translatedSummary ?? news[0]?.summary ?? news[0]?.title,
              '',
            )}`;

  return {
    score,
    opinion: finalOpinion,
    opinionReason: opinionReason(score, finalOpinion),
    gradeText: gradeText(score),
    financialSummary,
    chartSummary,
    newsDisclosureSummary: newsDisclosureSummary.map(translateMarketText),
    riskSummary,
    disclosureAiSummary: translateMarketText(disclosureAiSummary),
    newsAiSummary: translateMarketText(newsAiSummary),
    classification,
  };
}

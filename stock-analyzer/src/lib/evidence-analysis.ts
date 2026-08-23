type AnyObj = Record<string, any>;

export type EvidenceBasis =
  | 'provider-summary'
  | 'filing-metadata'
  | 'title-only';

export interface EvidenceAssessment {
  basis: EvidenceBasis;
  basisLabel: string;
  title: string;
  summary: string;
  tone: 'positive' | 'negative' | 'neutral';
  score: number;
  materiality: 'high' | 'medium' | 'low';
  tags: string[];
  warning: string | null;
}

export interface PriceContext {
  changePercent: number | null;
  volumeRatio: number | null;
  momentum5: number | null;
  rangePercent: number | null;
  ma20: number | null;
  ma60: number | null;
  close: number | null;
  regime: 'strong-uptrend' | 'uptrend' | 'mixed' | 'downtrend' | 'strong-downtrend' | 'insufficient';
  breakout: 'up' | 'down' | 'none' | 'insufficient';
}

export interface EvidenceAnalysisInput {
  quote?: AnyObj | null;
  news?: AnyObj[] | null;
  filings?: AnyObj[] | null;
  candles?: AnyObj[] | null;
}

export interface EvidenceAnalysisResult {
  news: EvidenceAssessment[];
  filings: EvidenceAssessment[];
  price: PriceContext;
  catalystSummary: string;
  evidenceWarning: string;
}

const POSITIVE = [
  /수주|공급계약|계약 체결|승인|허가|흑자|실적 개선|사상 최대|상향|증액|배당 확대|자사주 취득/i,
  /beat|beats|approval|approved|contract|award|profit|record|upgrade|buyback/i,
];
const NEGATIVE = [
  /유상증자|전환사채|신주|희석|상장폐지|거래정지|관리종목|소송|횡령|배임|리콜|적자|하향|감소|손실|부진/i,
  /offering|dilution|convertible|delisting|suspension|lawsuit|probe|recall|loss|downgrade|miss/i,
];
const HIGH_RISK = /상장폐지|거래정지|관리종목|횡령|배임|delisting|suspension|deficiency/i;
const DILUTION = /유상증자|전환사채|신주|희석|offering|dilution|convertible|atm\b|s-1|s-3|424b/i;
const MATERIAL_POSITIVE = /단일판매|공급계약|수주|승인|허가|자사주 취득|배당 확대|contract|approval|buyback/i;
const EARNINGS = /실적|매출|영업이익|순이익|흑자|적자|earnings|revenue|operating income|net income/i;

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/,/g, '').replace(/%/g, '').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function meaningfulSummary(item: AnyObj): string {
  const candidate = firstText(
    item.translatedSummary,
    item.summary,
    item.description,
    item.excerpt,
  );
  if (!candidate) return '';
  if (/^제출인\s*:/i.test(candidate)) return '';
  if (candidate.length < 24) return '';
  return candidate;
}

function evidenceBasis(item: AnyObj, kind: 'news' | 'filing'): EvidenceBasis {
  const summary = meaningfulSummary(item);
  if (summary) {
    if (kind === 'news') return 'provider-summary';
    return 'filing-metadata';
  }
  return 'title-only';
}

function basisLabel(basis: EvidenceBasis): string {
  if (basis === 'provider-summary') return '제공처 요약 기반';
  if (basis === 'filing-metadata') return '공시 메타데이터 기반';
  return '제목·분류정보 기반';
}

function compact(value: string, max = 150): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function classifyEvidence(item: AnyObj, kind: 'news' | 'filing'): EvidenceAssessment {
  const title = firstText(
    item.translatedTitle,
    item.title,
    item.headline,
    item.report_nm,
    item.report,
    item.form,
  ) || (kind === 'news' ? '뉴스 제목 확인 필요' : '공시 제목 확인 필요');
  const summary = meaningfulSummary(item);
  const combined = [
    title,
    summary,
    text(item.form),
    text(item.events),
    Array.isArray(item.eventLabels) ? item.eventLabels.join(' ') : text(item.eventLabels),
    text(item.sentiment),
    text(item.tone),
  ].filter(Boolean).join(' ');

  let positive = 0;
  let negative = 0;
  for (const pattern of POSITIVE) if (pattern.test(combined)) positive += 1;
  for (const pattern of NEGATIVE) if (pattern.test(combined)) negative += 1;

  if (/positive/i.test(text(item.sentiment)) || /positive/i.test(text(item.tone))) positive += 1;
  if (/negative/i.test(text(item.sentiment)) || /negative/i.test(text(item.tone))) negative += 1;

  let score = positive * 2 - negative * 2;
  const tags: string[] = [];
  if (DILUTION.test(combined)) {
    score -= 3;
    tags.push('희석위험');
  }
  if (HIGH_RISK.test(combined)) {
    score -= 5;
    tags.push('상장/거래위험');
  }
  if (MATERIAL_POSITIVE.test(combined)) {
    score += 2;
    tags.push('주요이벤트');
  }
  if (EARNINGS.test(combined)) tags.push('실적');
  if (/소송|lawsuit|litigation/i.test(combined)) tags.push('법적위험');

  score = Math.max(-10, Math.min(10, score));
  const tone = score >= 2 ? 'positive' : score <= -2 ? 'negative' : 'neutral';
  const abs = Math.abs(score);
  const materiality = HIGH_RISK.test(combined) || abs >= 6
    ? 'high'
    : abs >= 3 || tags.length > 0
      ? 'medium'
      : 'low';
  const basis = evidenceBasis(item, kind);
  const warning = basis === 'title-only'
    ? '본문을 읽은 결과가 아니라 제목·분류정보만으로 판단했습니다.'
    : kind === 'news'
      ? '기사 전체 원문이 아니라 제공처가 전달한 요약문을 근거로 분석했습니다.'
      : '공시 원문 전체가 아니라 현재 API가 제공한 공시 메타데이터를 근거로 분석했습니다.';

  return {
    basis,
    basisLabel: basisLabel(basis),
    title,
    summary: compact(summary || title),
    tone,
    score,
    materiality,
    tags: [...new Set(tags)],
    warning,
  };
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function candleRows(candles?: AnyObj[] | null) {
  return (Array.isArray(candles) ? candles : [])
    .map((item) => ({
      close: finite(item.close),
      high: finite(item.high),
      low: finite(item.low),
      volume: finite(item.volume),
    }))
    .filter((item): item is { close: number; high: number; low: number; volume: number | null } =>
      item.close != null && item.high != null && item.low != null,
    );
}

export function buildPriceContext(
  quote?: AnyObj | null,
  candles?: AnyObj[] | null,
): PriceContext {
  const rows = candleRows(candles);
  const latest = rows.at(-1) ?? null;
  const close = latest?.close ?? finite(quote?.price) ?? finite(quote?.currentPrice);
  const changePercent = finite(quote?.changePercent) ?? finite(quote?.changeRate) ?? null;

  const ma = (period: number) => {
    const closes = rows.slice(-period).map((row) => row.close);
    return closes.length >= Math.min(period, 5) ? average(closes) : null;
  };
  const ma20 = ma(20);
  const ma60 = rows.length >= 20 ? ma(60) : null;

  const recentForVolume = rows.slice(-21);
  const latestVolume = latest?.volume ?? null;
  const priorVolumes = recentForVolume.slice(0, -1)
    .map((row) => row.volume)
    .filter((value): value is number => value != null && value > 0);
  const avgVolume = average(priorVolumes.slice(-20));
  const volumeRatio = latestVolume != null && avgVolume != null && avgVolume > 0
    ? latestVolume / avgVolume
    : finite(quote?.volumeRatio);

  const fifth = rows.length >= 6 ? rows[rows.length - 6] : null;
  const momentum5 = latest && fifth && fifth.close > 0
    ? ((latest.close / fifth.close) - 1) * 100
    : null;

  const rangeRows = rows.slice(-14);
  const rangePercent = rangeRows.length
    ? average(rangeRows.map((row) => ((row.high - row.low) / Math.max(row.close, 1e-9)) * 100))
    : null;

  let regime: PriceContext['regime'] = 'insufficient';
  if (close != null && ma20 != null) {
    if (ma60 != null) {
      if (close > ma20 && ma20 > ma60) regime = 'strong-uptrend';
      else if (close < ma20 && ma20 < ma60) regime = 'strong-downtrend';
      else if (close > ma20) regime = 'uptrend';
      else if (close < ma20) regime = 'downtrend';
      else regime = 'mixed';
    } else {
      regime = close > ma20 ? 'uptrend' : close < ma20 ? 'downtrend' : 'mixed';
    }
  }

  let breakout: PriceContext['breakout'] = 'insufficient';
  if (latest && rows.length >= 11) {
    const prior = rows.slice(-21, -1);
    const priorHigh = Math.max(...prior.map((row) => row.high));
    const priorLow = Math.min(...prior.map((row) => row.low));
    breakout = latest.close > priorHigh ? 'up' : latest.close < priorLow ? 'down' : 'none';
  }

  return {
    changePercent,
    volumeRatio,
    momentum5,
    rangePercent,
    ma20,
    ma60,
    close,
    regime,
    breakout,
  };
}

function directionWord(value: number | null): string {
  if (value == null) return '등락률 확인 불가';
  if (value > 0) return `+${value.toFixed(2)}% 상승`;
  if (value < 0) return `${value.toFixed(2)}% 하락`;
  return '보합';
}

function strongestCandidate(items: EvidenceAssessment[]) {
  return [...items].sort((a, b) => {
    const materiality = { high: 3, medium: 2, low: 1 } as const;
    const m = materiality[b.materiality] - materiality[a.materiality];
    if (m !== 0) return m;
    return Math.abs(b.score) - Math.abs(a.score);
  })[0] ?? null;
}

export function buildEvidenceAnalysis(input: EvidenceAnalysisInput): EvidenceAnalysisResult {
  const news = (input.news ?? []).slice(0, 12).map((item) => classifyEvidence(item, 'news'));
  const filings = (input.filings ?? []).slice(0, 12).map((item) => classifyEvidence(item, 'filing'));
  const price = buildPriceContext(input.quote, input.candles);
  const candidate = strongestCandidate([...filings, ...news]);

  const volumeText = price.volumeRatio != null
    ? `거래량은 최근 평균의 ${price.volumeRatio.toFixed(1)}배`
    : '거래량 비교 데이터는 부족';
  const priceText = `현재 가격은 ${directionWord(price.changePercent)}했고, ${volumeText}입니다.`;

  let catalystSummary = `${priceText} 가격 움직임의 직접 원인을 확정할 근거는 아직 부족합니다.`;
  if (candidate && candidate.materiality !== 'low') {
    const alignment = price.changePercent == null || candidate.tone === 'neutral'
      ? '방향성 연결은 확인이 더 필요합니다.'
      : (price.changePercent > 0 && candidate.tone === 'positive') ||
          (price.changePercent < 0 && candidate.tone === 'negative')
        ? '가격 방향과 이벤트 방향이 일치해 원인 후보로 볼 수 있습니다.'
        : '가격 방향과 이벤트 방향이 엇갈려 단독 원인으로 보기 어렵습니다.';
    catalystSummary = `${priceText} 최신 주요 이벤트는 “${compact(candidate.title, 72)}”이며 ${candidate.basisLabel}입니다. ${alignment} 인과관계는 확정하지 않습니다.`;
  }

  const weakEvidence = [...news, ...filings].filter((item) => item.basis === 'title-only').length;
  const total = news.length + filings.length;
  const evidenceWarning = total === 0
    ? '뉴스·공시 근거 데이터가 없어 이벤트 분석을 보류합니다.'
    : weakEvidence === total
      ? '현재 이벤트 분석은 모두 제목·분류정보 기반이며 원문 전체 분석이 아닙니다.'
      : weakEvidence > 0
        ? `일부(${weakEvidence}/${total}) 이벤트는 제목·분류정보만 있어 해석 신뢰도가 낮습니다.`
        : '현재 분석은 제공처 요약 또는 공시 메타데이터를 사용하며 원문 전체 분석과 구분합니다.';

  return { news, filings, price, catalystSummary, evidenceWarning };
}

export function evidenceScore(items: EvidenceAssessment[]): number {
  return items.reduce((sum, item) => {
    const weight = item.materiality === 'high' ? 1.5 : item.materiality === 'medium' ? 1 : 0.5;
    return sum + item.score * weight;
  }, 0);
}

export function evidenceLeadSummary(
  items: EvidenceAssessment[],
  emptyMessage: string,
): string {
  const lead = strongestCandidate(items);
  if (!lead) return emptyMessage;
  const tone = lead.tone === 'positive' ? '긍정' : lead.tone === 'negative' ? '부정/주의' : '중립';
  const tags = lead.tags.length ? ` · ${lead.tags.join('·')}` : '';
  return `${lead.basisLabel} · ${tone}${tags} · ${compact(lead.summary, 130)}`;
}

export type AnalysisMarket = 'KR' | 'US';
export type AnalysisSector =
  | 'quantum'
  | 'semiconductor'
  | 'biotech'
  | 'ai'
  | 'automotive'
  | 'financial'
  | 'general';
export type EvidenceStatus = 'confirmed' | 'likely' | 'unconfirmed' | 'refuted';
export type CorporateEventType =
  | 'development_failure'
  | 'development_delay'
  | 'performance_miss'
  | 'contract_win'
  | 'contract_loss'
  | 'earnings_beat'
  | 'earnings_miss'
  | 'guidance_raise'
  | 'guidance_cut'
  | 'dilution'
  | 'leadership_change'
  | 'regulation'
  | 'product_launch'
  | 'clinical_success'
  | 'clinical_failure'
  | 'general_positive'
  | 'general_negative';

export type ScoreDimension =
  | 'technology'
  | 'business'
  | 'growth'
  | 'financial'
  | 'momentum'
  | 'catalyst';

export type ImpactDimension = ScoreDimension | 'risk';
export type AnalysisMark = '◎' | '○' | '△' | '—';
export type TrendDirection = 'up' | 'flat' | 'down' | 'unknown';

type AnyRecord = Record<string, unknown>;

export interface StockAnalysisInput {
  ticker: string;
  name: string;
  market: AnalysisMarket;
  currency: string;
  quote?: AnyRecord | null;
  profile?: AnyRecord | null;
  financials?: AnyRecord | null;
  news?: AnyRecord[] | null;
  disclosures?: AnyRecord[] | null;
  specialEvents?: AnyRecord[] | null;
  asOf?: string;
}

export interface AnalysisEvidence {
  id: string;
  title: string;
  summary: string | null;
  source: string;
  sourceType: 'disclosure' | 'news' | 'signal';
  url: string | null;
  occurredAt: string | null;
  reliability: number;
  official: boolean;
}

export interface AnalysisEvent {
  id: string;
  type: CorporateEventType;
  title: string;
  status: EvidenceStatus;
  severity: number;
  materiality: number;
  reliability: number;
  occurredAt: string | null;
  impacts: Partial<Record<ImpactDimension, number>>;
  evidenceIds: string[];
  explanation: string;
}

export interface DimensionResult {
  key: ScoreDimension;
  label: string;
  score: number;
  reasons: string[];
}

export interface FinancialInterpretation {
  revenueTrend: TrendDirection;
  operatingIncomeTrend: TrendDirection;
  netIncomeTrend: TrendDirection;
  cashStatus: '양호' | '보통' | '주의' | '자료 부족';
  revenueText: string;
  operatingIncomeText: string;
  cashText: string;
  summary: string;
}

export interface PriceContext {
  price: number | null;
  high52: number | null;
  low52: number | null;
  drawdownFromHigh: number | null;
  positionInRange: number | null;
  recentReason: string;
  pricedIn: string;
}

export interface TimingView {
  chase: '주의' | '확인 후 접근' | '과열 아님' | '판단 보류';
  observationLow: number | null;
  observationHigh: number | null;
  confirmationPrice: number | null;
  confirmationText: string;
}

export interface PeerComparisonRow {
  metric: string;
  company: AnalysisMark;
  peers: Array<{ name: string; value: AnalysisMark | '자료 필요' }>;
}

export interface StockAnalysisSnapshot {
  version: 1;
  id: string;
  generatedAt: string;
  ticker: string;
  market: AnalysisMarket;
  sector: AnalysisSector;
  sectorLabel: string;
  overallScore: number;
  verdict: string;
  shortTermOutlook: string;
  riskScore: number;
  riskLevel: '낮음' | '보통' | '높음' | '매우 높음';
  confidence: number;
  oneLine: string;
  dimensions: DimensionResult[];
  strengths: string[];
  weaknesses: string[];
  businessStage: string;
  revenueStatus: string;
  growthPotential: string;
  validationNeeded: string[];
  events: AnalysisEvent[];
  evidence: AnalysisEvidence[];
  financial: FinancialInterpretation;
  priceContext: PriceContext;
  upsideFactors: string[];
  downsideFactors: string[];
  timing: TimingView;
  peerNames: string[];
  peerComparison: PeerComparisonRow[];
  missingData: string[];
  dataSources: string[];
}

interface SectorModule {
  label: string;
  keywords: RegExp;
  metricAliases: Array<{ label: string; keys: string[] }>;
  comparison: Array<{ metric: string; dimension: ScoreDimension }>;
  peers: string[];
  coreValidation: string[];
}

interface EventRule {
  type: CorporateEventType;
  pattern: RegExp;
  severity: number;
  materiality: number;
  impacts: Partial<Record<ImpactDimension, number>>;
  explanation: string;
}

const DIMENSION_LABELS: Record<ScoreDimension, string> = {
  technology: '기술력',
  business: '사업성',
  growth: '성장성',
  financial: '재무건전성',
  momentum: '주가 흐름',
  catalyst: '촉매·이벤트',
};

const SECTOR_MODULES: Record<AnalysisSector, SectorModule> = {
  quantum: {
    label: '양자컴퓨팅',
    keywords: /quantum|qubit|양자|초전도|이온트랩|quantum computing/i,
    metricAliases: [
      { label: '큐비트 규모', keys: ['qubits', 'qubitCount', 'physicalQubits'] },
      { label: '게이트 정확도', keys: ['gateFidelity', 'fidelity', 'twoQubitFidelity'] },
      { label: '코히어런스', keys: ['coherence', 'coherenceTime'] },
      { label: '오류 정정', keys: ['errorCorrection', 'logicalQubits', 'qec'] },
      { label: '확장성', keys: ['scalability', 'modularArchitecture', 'roadmap'] },
      { label: '클라우드 접근', keys: ['cloudAccess', 'cloudAvailability'] },
    ],
    comparison: [
      { metric: '기술 성숙도', dimension: 'technology' },
      { metric: '상용화', dimension: 'business' },
      { metric: '확장성', dimension: 'growth' },
    ],
    peers: ['IBM', 'Google', 'IonQ'],
    coreValidation: ['큐비트·게이트 정확도', '오류 정정 로드맵', '실제 계약과 매출 전환'],
  },
  semiconductor: {
    label: '반도체',
    keywords: /semiconductor|chip|foundry|fabless|반도체|파운드리|메모리|웨이퍼/i,
    metricAliases: [
      { label: '공정', keys: ['processNode', 'nodeNm', 'process'] },
      { label: '수율', keys: ['yield', 'yieldRate'] },
      { label: '고객사', keys: ['customers', 'customerCount', 'majorCustomers'] },
      { label: '재고', keys: ['inventory', 'inventoryDays'] },
      { label: '설비투자', keys: ['capex', 'capitalExpenditure'] },
    ],
    comparison: [
      { metric: '공정 경쟁력', dimension: 'technology' },
      { metric: '고객·매출화', dimension: 'business' },
      { metric: '수율·확장성', dimension: 'growth' },
    ],
    peers: ['업종 선두사', '주요 경쟁사', '동일 공정사'],
    coreValidation: ['공정과 수율', '고객사 집중도', '재고와 CAPEX'],
  },
  biotech: {
    label: '바이오·제약',
    keywords: /biotech|pharma|clinical|drug|바이오|제약|임상|신약|치료제/i,
    metricAliases: [
      { label: '임상 단계', keys: ['clinicalPhase', 'phase', 'trialPhase'] },
      { label: '임상 상태', keys: ['trialStatus', 'clinicalStatus'] },
      { label: '파이프라인', keys: ['pipeline', 'pipelineCount'] },
      { label: '현금 런웨이', keys: ['cashRunway', 'runwayMonths'] },
      { label: '기술이전', keys: ['licensingDeals', 'partnerships'] },
    ],
    comparison: [
      { metric: '임상 진척도', dimension: 'technology' },
      { metric: '사업화 가능성', dimension: 'business' },
      { metric: '파이프라인', dimension: 'growth' },
    ],
    peers: ['동일 적응증 선두사', '동일 임상 단계', '기술 플랫폼 경쟁사'],
    coreValidation: ['임상 단계와 1차 지표', '현금 소진 기간', '증자·기술이전 가능성'],
  },
  ai: {
    label: 'AI·소프트웨어',
    keywords: /artificial intelligence|machine learning|generative ai|software|인공지능|생성형|소프트웨어|ai\b/i,
    metricAliases: [
      { label: '모델 성능', keys: ['modelPerformance', 'benchmark', 'accuracy'] },
      { label: 'GPU 확보', keys: ['gpuCapacity', 'gpuCount', 'computeCapacity'] },
      { label: '데이터 경쟁력', keys: ['dataMoat', 'proprietaryData'] },
      { label: '반복 매출', keys: ['arr', 'recurringRevenue'] },
      { label: '사용자 성장', keys: ['users', 'activeUsers', 'userGrowth'] },
    ],
    comparison: [
      { metric: '제품·모델 경쟁력', dimension: 'technology' },
      { metric: '반복 매출', dimension: 'business' },
      { metric: '데이터·확장성', dimension: 'growth' },
    ],
    peers: ['제품 선두사', '플랫폼 경쟁사', '동일 고객군 업체'],
    coreValidation: ['모델·제품 성능', 'GPU와 데이터 우위', '반복 매출과 고객 유지율'],
  },
  automotive: {
    label: '자동차·모빌리티',
    keywords: /automotive|vehicle|mobility|ev\b|자동차|전기차|모빌리티|완성차/i,
    metricAliases: [
      { label: '판매량', keys: ['deliveries', 'salesVolume', 'vehicleSales'] },
      { label: '영업이익률', keys: ['operatingMargin', 'autoMargin'] },
      { label: '신차', keys: ['newModels', 'launches'] },
      { label: '전기차 비중', keys: ['evMix', 'evShare'] },
    ],
    comparison: [
      { metric: '제품 경쟁력', dimension: 'technology' },
      { metric: '판매·마진', dimension: 'business' },
      { metric: '신차·전동화', dimension: 'growth' },
    ],
    peers: ['동일 차급 경쟁사', '전기차 선두사', '지역 점유율 경쟁사'],
    coreValidation: ['판매량과 인센티브', '영업이익률', '신차·전기차 경쟁력'],
  },
  financial: {
    label: '금융',
    keywords: /bank|financial|insurance|brokerage|은행|금융|보험|증권|카드/i,
    metricAliases: [
      { label: '순이자마진', keys: ['nim', 'netInterestMargin'] },
      { label: '연체율', keys: ['delinquencyRate', 'nplRatio'] },
      { label: '충당금', keys: ['provisions', 'creditLossProvision'] },
      { label: '자본비율', keys: ['capitalRatio', 'cet1'] },
    ],
    comparison: [
      { metric: '수익 구조', dimension: 'business' },
      { metric: '자산 건전성', dimension: 'financial' },
      { metric: '자본 여력', dimension: 'growth' },
    ],
    peers: ['동일 업권 선두사', '동일 규모 금융사', '지역 경쟁사'],
    coreValidation: ['순이자마진', '연체율과 충당금', '자본비율'],
  },
  general: {
    label: '일반 산업',
    keywords: /$^/,
    metricAliases: [
      { label: '핵심 제품', keys: ['products', 'coreProduct'] },
      { label: '시장 점유율', keys: ['marketShare'] },
      { label: '고객 기반', keys: ['customers', 'customerCount'] },
      { label: '생산 능력', keys: ['capacity', 'productionCapacity'] },
    ],
    comparison: [
      { metric: '제품 경쟁력', dimension: 'technology' },
      { metric: '사업화', dimension: 'business' },
      { metric: '성장 여력', dimension: 'growth' },
    ],
    peers: ['업종 선두사', '직접 경쟁사', '유사 규모 기업'],
    coreValidation: ['핵심 제품 경쟁력', '매출과 수익성', '시장 점유율'],
  },
};

const EVENT_RULES: EventRule[] = [
  {
    type: 'clinical_failure',
    pattern: /임상.{0,12}(실패|중단)|주평가지표.{0,8}(미달|실패)|clinical.{0,15}(fail|halt)|missed.{0,8}endpoint/i,
    severity: 1,
    materiality: 1,
    impacts: { technology: -18, business: -18, growth: -24, financial: -8, momentum: -14, catalyst: -25, risk: 24 },
    explanation: '핵심 임상 실패는 기술·사업화 가정과 자금조달 위험을 동시에 훼손할 수 있습니다.',
  },
  {
    type: 'development_failure',
    pattern: /개발.{0,12}(실패|중단|포기)|성능.{0,10}(미달|실패)|시험.{0,10}(실패|중단)|development.{0,15}(fail|halt)|test.{0,10}fail/i,
    severity: 0.95,
    materiality: 0.95,
    impacts: { technology: -17, business: -12, growth: -18, financial: -5, momentum: -12, catalyst: -20, risk: 20 },
    explanation: '개발 실패는 기존 기술 로드맵과 성장 가정을 다시 검증하게 만듭니다.',
  },
  {
    type: 'contract_loss',
    pattern: /계약.{0,10}(해지|취소|종료)|수주.{0,8}(취소|철회)|contract.{0,12}(terminat|cancel|lost)/i,
    severity: 0.8,
    materiality: 0.85,
    impacts: { business: -16, growth: -12, financial: -8, momentum: -10, catalyst: -15, risk: 13 },
    explanation: '계약 취소·해지는 매출 가시성과 고객 검증을 약화시킵니다.',
  },
  {
    type: 'development_delay',
    pattern: /개발.{0,12}(지연|연기)|일정.{0,10}(지연|연기)|출시.{0,10}(지연|연기)|delay|postpone|reschedule/i,
    severity: 0.55,
    materiality: 0.7,
    impacts: { technology: -5, business: -6, growth: -8, financial: -3, momentum: -5, catalyst: -9, risk: 8 },
    explanation: '일정 지연은 실패와 다르지만 매출 전환 시점과 신뢰도를 낮출 수 있습니다.',
  },
  {
    type: 'dilution',
    pattern: /유상증자|전환사채|신주.{0,8}발행|주식.{0,8}공모|증자|at-the-market|public offering|private placement|dilution/i,
    severity: 0.75,
    materiality: 0.8,
    impacts: { financial: -4, momentum: -10, catalyst: -8, risk: 15 },
    explanation: '신주·전환증권 발행은 자금 확보에 도움이 되지만 기존 주주의 희석 위험을 높입니다.',
  },
  {
    type: 'earnings_miss',
    pattern: /실적.{0,10}(부진|하회|쇼크)|적자.{0,8}(확대|전환)|매출.{0,8}(감소|하락)|earnings.{0,10}miss|revenue.{0,10}(miss|decline)/i,
    severity: 0.65,
    materiality: 0.8,
    impacts: { business: -8, growth: -7, financial: -12, momentum: -8, catalyst: -9, risk: 10 },
    explanation: '실적 부진은 성장 속도와 현금 소진 가정을 보수적으로 조정하게 만듭니다.',
  },
  {
    type: 'guidance_cut',
    pattern: /가이던스.{0,8}(하향|철회)|전망.{0,8}(하향|철회)|guidance.{0,10}(cut|lower|withdraw)/i,
    severity: 0.7,
    materiality: 0.85,
    impacts: { business: -9, growth: -12, financial: -8, momentum: -9, catalyst: -10, risk: 11 },
    explanation: '가이던스 하향은 경영진의 단기 가시성이 약해졌다는 신호입니다.',
  },
  {
    type: 'performance_miss',
    pattern: /목표.{0,8}(미달|실패)|성능.{0,8}(미달|하회)|정확도.{0,8}(미달|하회)|performance.{0,10}(miss|below)/i,
    severity: 0.65,
    materiality: 0.75,
    impacts: { technology: -10, business: -5, growth: -7, momentum: -6, catalyst: -10, risk: 10 },
    explanation: '핵심 성능 목표 미달은 기술 경쟁력과 로드맵 신뢰도를 낮춥니다.',
  },
  {
    type: 'clinical_success',
    pattern: /임상.{0,12}(성공|충족)|주평가지표.{0,8}(달성|충족)|clinical.{0,15}(success|met)|met.{0,8}endpoint/i,
    severity: 0.9,
    materiality: 0.95,
    impacts: { technology: 15, business: 13, growth: 18, financial: 4, momentum: 12, catalyst: 20, risk: -12 },
    explanation: '임상 성공은 기술 검증과 사업화 가능성을 동시에 높입니다.',
  },
  {
    type: 'contract_win',
    pattern: /수주|계약.{0,8}체결|공급.{0,8}계약|사업자.{0,8}선정|파트너십|strategic partnership|contract.{0,8}(award|win)|selected.{0,8}vendor/i,
    severity: 0.7,
    materiality: 0.8,
    impacts: { business: 14, growth: 10, financial: 5, momentum: 7, catalyst: 13, risk: -5 },
    explanation: '신규 계약은 고객 검증과 향후 매출 가시성을 높이는 촉매입니다.',
  },
  {
    type: 'earnings_beat',
    pattern: /실적.{0,10}(상회|호조)|흑자.{0,8}전환|매출.{0,8}(증가|성장)|earnings.{0,10}beat|revenue.{0,10}(beat|growth)/i,
    severity: 0.65,
    materiality: 0.75,
    impacts: { business: 8, growth: 7, financial: 10, momentum: 7, catalyst: 8, risk: -5 },
    explanation: '실적 개선은 사업화와 현금흐름 가정의 신뢰도를 높입니다.',
  },
  {
    type: 'guidance_raise',
    pattern: /가이던스.{0,8}(상향|제시)|전망.{0,8}상향|guidance.{0,10}(raise|increase)/i,
    severity: 0.65,
    materiality: 0.75,
    impacts: { business: 7, growth: 10, financial: 6, momentum: 7, catalyst: 9, risk: -4 },
    explanation: '가이던스 상향은 단기 실적 가시성과 경영진 확신을 높입니다.',
  },
  {
    type: 'product_launch',
    pattern: /신제품|신규.{0,8}(출시|공개)|상용화|양산.{0,8}시작|product.{0,10}launch|commercial.{0,10}launch/i,
    severity: 0.55,
    materiality: 0.65,
    impacts: { technology: 5, business: 7, growth: 7, momentum: 4, catalyst: 8, risk: -2 },
    explanation: '제품 출시·상용화는 기술을 실제 고객과 매출로 전환하는 단계입니다.',
  },
  {
    type: 'leadership_change',
    pattern: /대표이사.{0,8}(변경|사임)|ceo.{0,8}(resign|appoint|change)|경영진.{0,8}(교체|변경)/i,
    severity: 0.35,
    materiality: 0.45,
    impacts: { business: -2, momentum: -2, catalyst: -2, risk: 4 },
    explanation: '경영진 변경은 전략 연속성과 실행력을 추가 확인하게 만듭니다.',
  },
  {
    type: 'regulation',
    pattern: /규제|승인|허가|제재|investigation|regulation|approval|license/i,
    severity: 0.4,
    materiality: 0.6,
    impacts: { business: -1, growth: -1, catalyst: -1, risk: 3 },
    explanation: '규제·허가 이벤트는 방향과 확정 여부에 따라 사업 일정에 영향을 줄 수 있습니다.',
  },
  {
    type: 'general_positive',
    pattern: /호재|성과|개선|돌파|최고치|positive|improve|milestone/i,
    severity: 0.3,
    materiality: 0.4,
    impacts: { technology: 2, business: 2, growth: 3, momentum: 3, catalyst: 4, risk: -1 },
    explanation: '긍정 이벤트지만 공식 수치와 지속성을 추가 확인해야 합니다.',
  },
  {
    type: 'general_negative',
    pattern: /악재|우려|위험|감소|하락|소송|negative|concern|risk|lawsuit/i,
    severity: 0.3,
    materiality: 0.4,
    impacts: { business: -2, growth: -2, momentum: -3, catalyst: -3, risk: 3 },
    explanation: '부정 이벤트의 실제 재무·사업 영향과 공식 확인 여부를 점검해야 합니다.',
  },
];

function record(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function rows(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((row): row is AnyRecord => Boolean(row && typeof row === 'object')) : [];
}

function text(value: unknown): string | null {
  const result = String(value ?? '').trim();
  return result || null;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(clamp(value));
}

function normalizedTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/정정|첨부정정|기재정정|update|updated/g, '')
    .replace(/[^0-9a-z가-힣]/g, '')
    .slice(0, 160);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function dateValue(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

function sourceMeta(source: string, sourceType: AnalysisEvidence['sourceType']) {
  const official = sourceType === 'disclosure' || /dart|sec|공시|거래소|company|기업|ir|investor relations|보도자료/i.test(source);
  const reputable = /reuters|bloomberg|연합뉴스|매일경제|한국경제|wsj|cnbc|financial times/i.test(source);
  return {
    official,
    reliability: official ? 0.95 : reputable ? 0.8 : sourceType === 'news' ? 0.65 : 0.55,
  };
}

function evidenceFromRow(row: AnyRecord, sourceType: AnalysisEvidence['sourceType']): AnalysisEvidence | null {
  const title = text(row.title ?? row.report ?? row.description ?? row.form);
  if (!title) return null;
  const source = text(row.source ?? row.provider ?? row.publisher) ?? (sourceType === 'disclosure' ? '공식 공시' : '출처 미표시');
  const meta = sourceMeta(source, sourceType);
  const occurredAt = dateValue(row.sourceAt ?? row.publishedAt ?? row.date ?? row.filingDate ?? row.detectedAt);
  return {
    id: `evd-${hashText(`${sourceType}:${title}:${occurredAt ?? ''}:${source}`)}`,
    title,
    summary: text(row.summary ?? row.content ?? row.note),
    source,
    sourceType,
    url: text(row.url ?? row.link),
    occurredAt,
    reliability: meta.reliability,
    official: meta.official,
  };
}

function collectEvidence(input: StockAnalysisInput): AnalysisEvidence[] {
  const sourceRows: ReadonlyArray<readonly [AnyRecord, AnalysisEvidence['sourceType']]> = [
    ...rows(input.news).map((row) => [row, 'news'] as const),
    ...rows(input.disclosures).map((row) => [row, 'disclosure'] as const),
    ...rows(input.specialEvents).map((row) => [row, text(row.kind) === 'disclosure' ? 'disclosure' : text(row.kind) === 'signal' ? 'signal' : 'news'] as const),
  ];
  const unique = new Map<string, AnalysisEvidence>();
  for (const [row, sourceType] of sourceRows) {
    const evidence = evidenceFromRow(row, sourceType);
    if (!evidence) continue;
    const day = evidence.occurredAt?.slice(0, 10) ?? '';
    const key = `${normalizedTitle(evidence.title)}:${day}`;
    const current = unique.get(key);
    if (!current || evidence.reliability > current.reliability) unique.set(key, evidence);
  }
  return [...unique.values()].sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')));
}

function statusForEvidence(evidence: AnalysisEvidence): EvidenceStatus {
  if (evidence.official) return 'confirmed';
  if (evidence.reliability >= 0.78) return 'likely';
  return 'unconfirmed';
}

function scaleImpact(value: number, evidence: AnalysisEvidence, rule: EventRule): number {
  const statusFactor = evidence.official ? 1 : evidence.reliability >= 0.78 ? 0.78 : 0.52;
  return Math.round(value * rule.severity * rule.materiality * statusFactor);
}

function classifyEvents(evidence: AnalysisEvidence[]): AnalysisEvent[] {
  const grouped = new Map<string, AnalysisEvent>();
  for (const item of evidence) {
    const body = `${item.title} ${item.summary ?? ''}`;
    const rule = EVENT_RULES.find((candidate) => candidate.pattern.test(body));
    if (!rule) continue;
    const impacts = Object.fromEntries(
      Object.entries(rule.impacts).map(([key, value]) => [key, scaleImpact(Number(value), item, rule)]),
    ) as Partial<Record<ImpactDimension, number>>;
    const key = `${rule.type}:${normalizedTitle(item.title)}`;
    const event: AnalysisEvent = {
      id: `evt-${hashText(key)}`,
      type: rule.type,
      title: item.title,
      status: statusForEvidence(item),
      severity: rule.severity,
      materiality: rule.materiality,
      reliability: item.reliability,
      occurredAt: item.occurredAt,
      impacts,
      evidenceIds: [item.id],
      explanation: rule.explanation,
    };
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, event);
      continue;
    }
    current.evidenceIds = [...new Set([...current.evidenceIds, item.id])];
    if (event.reliability > current.reliability) {
      current.reliability = event.reliability;
      current.status = event.status;
      current.occurredAt = event.occurredAt;
      current.impacts = event.impacts;
    }
  }
  return [...grouped.values()]
    .sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')))
    .slice(0, 12);
}

function detectSector(input: StockAnalysisInput): AnalysisSector {
  const profile = record(input.profile);
  const haystack = [input.name, input.ticker, profile.industry, profile.sector, profile.description, profile.businessSummary]
    .map((value) => text(value) ?? '')
    .join(' ');
  const sectors: AnalysisSector[] = ['quantum', 'semiconductor', 'biotech', 'ai', 'automotive', 'financial'];
  return sectors.find((sector) => SECTOR_MODULES[sector].keywords.test(haystack)) ?? 'general';
}

function valueAtPath(objects: AnyRecord[], keys: string[]): unknown {
  for (const object of objects) {
    for (const key of keys) {
      if (object[key] != null && object[key] !== '') return object[key];
      const metrics = record(object.metrics);
      if (metrics[key] != null && metrics[key] !== '') return metrics[key];
    }
  }
  return null;
}

function financialRoot(input: StockAnalysisInput) {
  const root = record(input.financials);
  const nested = record(root.financials);
  return Object.keys(nested).length ? { root, data: nested } : { root, data: root };
}

function financialRows(input: StockAnalysisInput): AnyRecord[] {
  const { data } = financialRoot(input);
  return rows(data.quarterly ?? data.quarters ?? data.annual ?? data.yearly);
}

function ratioData(input: StockAnalysisInput): AnyRecord {
  const { root, data } = financialRoot(input);
  return record(data.ratios ?? root.ratios);
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function trend(current: number | null, previous: number | null): TrendDirection {
  const change = percentChange(current, previous);
  if (change == null) return 'unknown';
  if (change >= 5) return 'up';
  if (change <= -5) return 'down';
  return 'flat';
}

function trendText(direction: TrendDirection, positiveLabel: string, negativeLabel: string): string {
  if (direction === 'up') return `▲ ${positiveLabel}`;
  if (direction === 'down') return `▼ ${negativeLabel}`;
  if (direction === 'flat') return '→ 큰 변화 없음';
  return '자료 부족';
}

function buildFinancialInterpretation(input: StockAnalysisInput): FinancialInterpretation {
  const finance = financialRows(input);
  const latest = finance[0] ?? {};
  const previous = finance[1] ?? {};
  const revenue = finite(latest.revenue ?? latest.sales);
  const previousRevenue = finite(previous.revenue ?? previous.sales);
  const operatingIncome = finite(latest.operatingIncome ?? latest.operatingProfit);
  const previousOperatingIncome = finite(previous.operatingIncome ?? previous.operatingProfit);
  const netIncome = finite(latest.netIncome ?? latest.profit);
  const previousNetIncome = finite(previous.netIncome ?? previous.profit);
  const cash = finite(latest.cash ?? latest.cashAndEquivalents ?? latest.currentAssets);
  const operatingCashFlow = finite(latest.operatingCashFlow ?? latest.cashFlowFromOperations);
  const revenueTrend = trend(revenue, previousRevenue);
  const operatingIncomeTrend = trend(operatingIncome, previousOperatingIncome);
  const netIncomeTrend = trend(netIncome, previousNetIncome);
  const cashStatus: FinancialInterpretation['cashStatus'] = cash == null
    ? '자료 부족'
    : operatingCashFlow != null && operatingCashFlow < 0 && cash < Math.abs(operatingCashFlow)
      ? '주의'
      : operatingCashFlow != null && cash >= Math.abs(operatingCashFlow) * 2
        ? '양호'
        : '보통';
  const lossStage = operatingIncome != null && operatingIncome < 0;
  const summary = revenue == null && operatingIncome == null
    ? '재무 원자료가 부족해 수익성과 현금 소진 속도를 확정하기 어렵습니다.'
    : lossStage
      ? `매출 흐름은 ${revenueTrend === 'up' ? '개선 중' : revenueTrend === 'down' ? '둔화 중' : '추가 확인이 필요'}이며 영업적자가 이어져 수익화와 현금 소진 속도를 함께 확인해야 합니다.`
      : operatingIncome != null && operatingIncome > 0
        ? '영업흑자를 기록하고 있어 성장의 질과 현금흐름 지속성을 확인할 단계입니다.'
        : '매출 성장과 영업수익성의 방향을 추가 분기 데이터로 확인해야 합니다.';
  return {
    revenueTrend,
    operatingIncomeTrend,
    netIncomeTrend,
    cashStatus,
    revenueText: trendText(revenueTrend, '매출 증가', '매출 감소'),
    operatingIncomeText: trendText(operatingIncomeTrend, '영업이익 개선', '영업이익 악화'),
    cashText: cashStatus === '자료 부족' ? '현금 자료 부족' : `현금 여력 ${cashStatus}`,
    summary,
  };
}

function mark(score: number): AnalysisMark {
  if (score >= 75) return '◎';
  if (score >= 58) return '○';
  if (score >= 42) return '△';
  return '—';
}

function scoreLabel(score: number): string {
  if (score >= 75) return '매우 양호';
  if (score >= 62) return '양호';
  if (score >= 48) return '중립';
  if (score >= 35) return '주의';
  return '취약';
}

function eventImpact(events: AnalysisEvent[], dimension: ImpactDimension): number {
  return events.reduce((sum, event) => sum + Number(event.impacts[dimension] ?? 0), 0);
}

function buildDimensions(input: StockAnalysisInput, sector: AnalysisSector, events: AnalysisEvent[]) {
  const module = SECTOR_MODULES[sector];
  const profile = record(input.profile);
  const quote = record(input.quote);
  const finance = financialRows(input);
  const latest = finance[0] ?? {};
  const previous = finance[1] ?? {};
  const ratios = ratioData(input);
  const metricObjects = [profile, record(profile.technology), record(profile.metrics), record(input.financials)];
  const availableSectorMetrics = module.metricAliases.filter((metric) => valueAtPath(metricObjects, metric.keys) != null);
  const revenue = finite(latest.revenue ?? latest.sales);
  const previousRevenue = finite(previous.revenue ?? previous.sales);
  const operatingIncome = finite(latest.operatingIncome ?? latest.operatingProfit);
  const netIncome = finite(latest.netIncome ?? latest.profit);
  const operatingCashFlow = finite(latest.operatingCashFlow ?? latest.cashFlowFromOperations);
  const debtRatio = finite(ratios.debtRatio ?? ratios.debtToEquity);
  const changePercent = finite(quote.changePercent);
  const high52 = finite(quote.high52 ?? quote.high52Week ?? quote.yearHigh ?? quote.fiftyTwoWeekHigh);
  const low52 = finite(quote.low52 ?? quote.low52Week ?? quote.yearLow ?? quote.fiftyTwoWeekLow);
  const price = finite(quote.price);
  const rangePosition = price != null && high52 != null && low52 != null && high52 > low52 ? (price - low52) / (high52 - low52) : null;
  const revenueGrowth = percentChange(revenue, previousRevenue);

  const technologyBase = 46 + Math.min(24, availableSectorMetrics.length * 4) + (profile.description || profile.businessSummary ? 4 : 0);
  const businessBase = 43 + (revenue != null && revenue > 0 ? 9 : 0) + (operatingIncome != null && operatingIncome > 0 ? 8 : 0) + (revenueGrowth != null && revenueGrowth > 10 ? 5 : 0);
  const growthBase = 46 + (revenueGrowth == null ? 0 : clamp(revenueGrowth / 4, -12, 14)) + Math.min(8, availableSectorMetrics.length * 1.5);
  const financialBase = 48 + (operatingIncome == null ? 0 : operatingIncome > 0 ? 10 : -8) + (netIncome == null ? 0 : netIncome > 0 ? 5 : -5) + (operatingCashFlow == null ? 0 : operatingCashFlow > 0 ? 7 : -7) + (debtRatio == null ? 0 : debtRatio < 100 ? 5 : debtRatio > 250 ? -8 : 0);
  const momentumBase = 50 + (changePercent == null ? 0 : clamp(changePercent * 1.5, -15, 15)) + (rangePosition == null ? 0 : rangePosition > 0.85 ? -3 : rangePosition < 0.25 ? 2 : 0);
  const catalystBase = 50 + eventImpact(events, 'catalyst');

  const raw: Record<ScoreDimension, number> = {
    technology: technologyBase + eventImpact(events, 'technology'),
    business: businessBase + eventImpact(events, 'business'),
    growth: growthBase + eventImpact(events, 'growth'),
    financial: financialBase + eventImpact(events, 'financial'),
    momentum: momentumBase + eventImpact(events, 'momentum'),
    catalyst: catalystBase,
  };

  const reasons: Record<ScoreDimension, string[]> = {
    technology: [
      availableSectorMetrics.length > 0 ? `${availableSectorMetrics.map((metric) => metric.label).slice(0, 3).join('·')} 자료 반영` : `${module.label} 핵심 기술지표 자료 부족`,
      eventImpact(events, 'technology') !== 0 ? `기술 이벤트 영향 ${eventImpact(events, 'technology') > 0 ? '+' : ''}${eventImpact(events, 'technology')}점` : '확정 기술 이벤트 없음',
    ],
    business: [
      revenue != null && revenue > 0 ? '실제 매출 확인' : '매출 자료 또는 상용화 검증 필요',
      eventImpact(events, 'business') !== 0 ? `계약·사업 이벤트 영향 ${eventImpact(events, 'business') > 0 ? '+' : ''}${eventImpact(events, 'business')}점` : '사업 이벤트 영향 중립',
    ],
    growth: [
      revenueGrowth == null ? '비교 가능한 매출 추세 부족' : `매출 증감 ${revenueGrowth.toFixed(1)}%`,
      eventImpact(events, 'growth') !== 0 ? `성장 이벤트 영향 ${eventImpact(events, 'growth') > 0 ? '+' : ''}${eventImpact(events, 'growth')}점` : '성장 이벤트 영향 중립',
    ],
    financial: [
      operatingIncome == null ? '영업이익 자료 부족' : operatingIncome > 0 ? '영업흑자' : '영업적자',
      operatingCashFlow == null ? '영업현금흐름 자료 부족' : operatingCashFlow > 0 ? '영업현금흐름 양호' : '현금 소진 확인 필요',
    ],
    momentum: [
      changePercent == null ? '등락률 자료 부족' : `당일 등락 ${changePercent.toFixed(2)}%`,
      rangePosition == null ? '52주 위치 자료 부족' : `52주 가격범위 ${(rangePosition * 100).toFixed(0)}% 위치`,
    ],
    catalyst: [
      events.length > 0 ? `최근 분류 이벤트 ${events.length}건` : '분류 가능한 최근 이벤트 없음',
      `이벤트 순영향 ${eventImpact(events, 'catalyst') > 0 ? '+' : ''}${eventImpact(events, 'catalyst')}점`,
    ],
  };

  const dimensions = (Object.keys(raw) as ScoreDimension[]).map((key) => ({
    key,
    label: DIMENSION_LABELS[key],
    score: round(raw[key]),
    reasons: reasons[key],
  }));
  return { dimensions, availableSectorMetrics, finance, revenueGrowth };
}

function dimensionScore(dimensions: DimensionResult[], key: ScoreDimension): number {
  return dimensions.find((dimension) => dimension.key === key)?.score ?? 50;
}

function buildPriceContext(input: StockAnalysisInput, events: AnalysisEvent[]): PriceContext {
  const quote = record(input.quote);
  const price = finite(quote.price);
  const high52 = finite(quote.high52 ?? quote.high52Week ?? quote.yearHigh ?? quote.fiftyTwoWeekHigh);
  const low52 = finite(quote.low52 ?? quote.low52Week ?? quote.yearLow ?? quote.fiftyTwoWeekLow);
  const changePercent = finite(quote.changePercent);
  const drawdownFromHigh = price != null && high52 != null && high52 > 0 ? ((price - high52) / high52) * 100 : null;
  const positionInRange = price != null && high52 != null && low52 != null && high52 > low52 ? ((price - low52) / (high52 - low52)) * 100 : null;
  const recent = events[0];
  const negativeRecent = recent && Number(recent.impacts.risk ?? 0) > 0;
  const positiveRecent = recent && Number(recent.impacts.catalyst ?? 0) > 0;
  const pricedIn = negativeRecent && changePercent != null && changePercent <= -8
    ? '부정 이벤트가 단기 주가에 일부 반영됐을 가능성이 있습니다.'
    : positiveRecent && changePercent != null && changePercent >= 8
      ? '긍정 기대가 단기 주가에 선반영됐을 가능성이 있습니다.'
      : '이벤트의 주가 반영 정도를 단정할 자료가 부족합니다.';
  return {
    price,
    high52,
    low52,
    drawdownFromHigh,
    positionInRange,
    recentReason: recent ? `${recent.title} (${recent.status === 'confirmed' ? '공식 확인' : recent.status === 'likely' ? '가능성 높음' : '미확인'})` : '분류 가능한 최근 이벤트 없음',
    pricedIn,
  };
}

function riskLevel(score: number): StockAnalysisSnapshot['riskLevel'] {
  if (score >= 75) return '매우 높음';
  if (score >= 58) return '높음';
  if (score >= 40) return '보통';
  return '낮음';
}

function verdict(score: number): string {
  if (score >= 75) return '긍정';
  if (score >= 62) return '다소 긍정';
  if (score >= 48) return '중립';
  if (score >= 35) return '주의';
  return '부정';
}

function shortTermOutlook(dimensions: DimensionResult[], risk: number): string {
  const momentum = dimensionScore(dimensions, 'momentum');
  const catalyst = dimensionScore(dimensions, 'catalyst');
  const score = momentum * 0.55 + catalyst * 0.45 - Math.max(0, risk - 55) * 0.25;
  if (score >= 68) return '상승 우위';
  if (score >= 55) return '중립~상승';
  if (score >= 43) return '중립';
  if (score >= 32) return '중립~하락';
  return '하락 우위';
}

function unique(items: Array<string | null | undefined>, limit = 6): string[] {
  return [...new Set(items.map((item) => text(item)).filter((item): item is string => Boolean(item)))].slice(0, limit);
}

function buildTiming(input: StockAnalysisInput, risk: number, priceContext: PriceContext): TimingView {
  const quote = record(input.quote);
  const price = priceContext.price;
  const changePercent = finite(quote.changePercent);
  const support = finite(quote.support ?? quote.supportPrice ?? quote.low);
  const resistance = finite(quote.resistance ?? quote.resistancePrice ?? quote.high);
  const overheated = (changePercent != null && changePercent >= 7) || (priceContext.positionInRange != null && priceContext.positionInRange >= 88);
  const chase: TimingView['chase'] = price == null
    ? '판단 보류'
    : overheated || risk >= 65
      ? '주의'
      : risk >= 50
        ? '확인 후 접근'
        : '과열 아님';
  const observationLow = price == null ? null : support != null && support > 0 && support <= price ? support : price * (risk >= 65 ? 0.9 : 0.94);
  const observationHigh = price == null ? null : price * (overheated ? 0.97 : 1);
  const confirmationPrice = price == null ? null : resistance != null && resistance >= price ? resistance : price * 1.03;
  return {
    chase,
    observationLow,
    observationHigh,
    confirmationPrice,
    confirmationText: confirmationPrice == null
      ? '확인 가격을 계산할 시세 자료가 부족합니다.'
      : '거래량을 동반한 확인 가격 돌파와 핵심 이벤트의 공식 확인이 필요합니다.',
  };
}

function buildPeerComparison(module: SectorModule, dimensions: DimensionResult[], profile: AnyRecord): PeerComparisonRow[] {
  const provided = rows(profile.peerComparisons ?? profile.competitorComparison);
  return module.comparison.map(({ metric, dimension }) => ({
    metric,
    company: mark(dimensionScore(dimensions, dimension)),
    peers: module.peers.map((peer) => {
      const peerRow = provided.find((row) => text(row.name) === peer);
      const value = finite(peerRow?.[dimension] ?? peerRow?.score);
      return { name: peer, value: value == null ? '자료 필요' : mark(value) };
    }),
  }));
}

function oneLineSummary(sector: AnalysisSector, dimensions: DimensionResult[], risk: number, events: AnalysisEvent[]): string {
  const module = SECTOR_MODULES[sector];
  const strongest = [...dimensions].sort((left, right) => right.score - left.score)[0];
  const weakest = [...dimensions].sort((left, right) => left.score - right.score)[0];
  const negative = events.find((event) => Number(event.impacts.risk ?? 0) >= 5);
  if (sector === 'quantum') {
    const base = dimensionScore(dimensions, 'technology') >= 58
      ? '양자 기술 개발 역량은 확인되지만 상용화·수익성과 로드맵 이행 검증이 필요한 단계입니다.'
      : '양자 기술 기대보다 핵심 성능·확장성·상용화 검증이 우선인 단계입니다.';
    return negative ? `${base} 최근 ${negative.title} 영향은 보수적으로 반영했습니다.` : base;
  }
  const base = `${module.label} 기준으로 ${strongest.label}은 상대적으로 ${scoreLabel(strongest.score)}하지만 ${weakest.label} 보완과 ${risk >= 60 ? '높은 위험 관리' : '추가 데이터 확인'}가 필요합니다.`;
  return negative ? `${base} 최근 부정 이벤트도 반영했습니다.` : base;
}

function businessStage(finance: AnyRecord[]): string {
  const latest = finance[0] ?? {};
  const revenue = finite(latest.revenue ?? latest.sales);
  const operatingIncome = finite(latest.operatingIncome ?? latest.operatingProfit);
  if (revenue == null || revenue <= 0) return '연구·검증 단계';
  if (operatingIncome == null || operatingIncome < 0) return '초기 상용화·성장 투자 단계';
  return '상용화·수익화 단계';
}

function confidenceScore(input: StockAnalysisInput, evidence: AnalysisEvidence[], sectorMetricCount: number, missingData: string[]): number {
  const datasets = [input.quote, input.profile, input.financials, input.news, input.disclosures].filter((item) => item != null).length;
  const officialCount = evidence.filter((item) => item.official).length;
  return round(24 + datasets * 9 + Math.min(20, officialCount * 4) + Math.min(12, sectorMetricCount * 3) - Math.min(24, missingData.length * 3));
}

function dataSources(input: StockAnalysisInput, evidence: AnalysisEvidence[]): string[] {
  const quote = record(input.quote);
  const financials = record(input.financials);
  return unique([
    text(quote.source ?? quote.provider),
    text(financials.source ?? financials.provider),
    ...evidence.map((item) => item.source),
  ], 8);
}

export function buildStockAnalysis(input: StockAnalysisInput): StockAnalysisSnapshot {
  const generatedAt = input.asOf ?? new Date().toISOString();
  const sector = detectSector(input);
  const module = SECTOR_MODULES[sector];
  const evidence = collectEvidence(input);
  const events = classifyEvents(evidence);
  const { dimensions, availableSectorMetrics, finance, revenueGrowth } = buildDimensions(input, sector, events);
  const risk = round(
    42
      + eventImpact(events, 'risk')
      + (dimensionScore(dimensions, 'financial') < 40 ? 10 : 0)
      + (dimensionScore(dimensions, 'technology') < 40 ? 7 : 0)
      + (evidence.length === 0 ? 6 : 0),
  );
  const positiveAverage =
    dimensionScore(dimensions, 'technology') * 0.22
    + dimensionScore(dimensions, 'business') * 0.18
    + dimensionScore(dimensions, 'growth') * 0.18
    + dimensionScore(dimensions, 'financial') * 0.18
    + dimensionScore(dimensions, 'momentum') * 0.12
    + dimensionScore(dimensions, 'catalyst') * 0.12;
  const overallScore = round(positiveAverage - Math.max(0, risk - 50) * 0.28);
  const financial = buildFinancialInterpretation(input);
  const priceContext = buildPriceContext(input, events);
  const profile = record(input.profile);
  const latest = finance[0] ?? {};
  const revenue = finite(latest.revenue ?? latest.sales);
  const operatingIncome = finite(latest.operatingIncome ?? latest.operatingProfit);
  const missingData = unique([
    input.quote ? null : '현재가·등락 데이터',
    input.profile ? null : '기업·업종 정보',
    finance.length >= 2 ? null : '비교 가능한 2개 이상 재무기간',
    evidence.length > 0 ? null : '최근 뉴스·공시 이벤트',
    availableSectorMetrics.length > 0 ? null : `${module.label} 핵심 기술지표`,
    priceContext.high52 != null && priceContext.low52 != null ? null : '52주 고가·저가',
    rows(profile.peerComparisons ?? profile.competitorComparison).length > 0 ? null : '경쟁사 최신 정량 비교자료',
  ], 10);
  const confidence = confidenceScore(input, evidence, availableSectorMetrics.length, missingData);
  const strongest = [...dimensions].sort((left, right) => right.score - left.score);
  const weakest = [...dimensions].sort((left, right) => left.score - right.score);
  const strengths = unique([
    strongest[0]?.score >= 55 ? `${strongest[0].label} ${scoreLabel(strongest[0].score)}` : null,
    strongest[1]?.score >= 58 ? `${strongest[1].label} ${scoreLabel(strongest[1].score)}` : null,
    ...events.filter((event) => Number(event.impacts.catalyst ?? 0) > 0).map((event) => event.title),
    revenueGrowth != null && revenueGrowth > 10 ? `매출 ${revenueGrowth.toFixed(1)}% 성장` : null,
  ], 4);
  const weaknesses = unique([
    weakest[0]?.score < 50 ? `${weakest[0].label} ${scoreLabel(weakest[0].score)}` : null,
    weakest[1]?.score < 45 ? `${weakest[1].label} ${scoreLabel(weakest[1].score)}` : null,
    ...events.filter((event) => Number(event.impacts.risk ?? 0) > 0).map((event) => event.title),
    operatingIncome != null && operatingIncome < 0 ? '영업적자 지속' : null,
  ], 4);
  const upsideFactors = unique([
    ...events.filter((event) => Number(event.impacts.catalyst ?? 0) > 0).map((event) => event.title),
    dimensionScore(dimensions, 'technology') >= 60 ? '핵심 기술지표 개선 또는 공식 검증' : null,
    dimensionScore(dimensions, 'business') >= 58 ? '계약·고객 확대와 매출 전환' : '신규 계약과 실제 매출 전환',
    dimensionScore(dimensions, 'growth') >= 58 ? '시장 성장과 점유율 확대' : null,
  ], 4);
  const downsideFactors = unique([
    ...events.filter((event) => Number(event.impacts.risk ?? 0) > 0).map((event) => event.title),
    dimensionScore(dimensions, 'financial') < 48 ? '적자·현금 소진 또는 추가 자금조달' : null,
    dimensionScore(dimensions, 'technology') < 50 ? '개발 실패·성능 목표 미달' : '핵심 로드맵 지연',
    '경쟁 심화와 기대 선반영',
  ], 5);
  const validationNeeded = unique([
    ...module.coreValidation,
    ...missingData,
    events.some((event) => event.status === 'unconfirmed') ? '미확인 이벤트의 공식 공시 여부' : null,
  ], 6);
  const stage = businessStage(finance);
  const revenueStatus = revenue == null ? '자료 부족' : revenue <= 0 ? '매출 미확인' : revenueGrowth == null ? '매출 발생·추세 확인 필요' : revenueGrowth > 10 ? '성장 중' : revenueGrowth < -5 ? '감소 중' : '정체·완만';
  const growthPotential = dimensionScore(dimensions, 'growth') >= 68 ? '높음' : dimensionScore(dimensions, 'growth') >= 50 ? '보통' : '낮음·검증 필요';
  const timing = buildTiming(input, risk, priceContext);
  const snapshotCore = `${input.market}:${input.ticker}:${generatedAt}:${overallScore}:${risk}:${events.map((event) => event.id).join(',')}`;

  return {
    version: 1,
    id: `analysis-${hashText(snapshotCore)}`,
    generatedAt,
    ticker: input.ticker.toUpperCase(),
    market: input.market,
    sector,
    sectorLabel: module.label,
    overallScore,
    verdict: verdict(overallScore),
    shortTermOutlook: shortTermOutlook(dimensions, risk),
    riskScore: risk,
    riskLevel: riskLevel(risk),
    confidence,
    oneLine: oneLineSummary(sector, dimensions, risk, events),
    dimensions,
    strengths: strengths.length ? strengths : ['확정 강점 데이터 추가 확인 필요'],
    weaknesses: weaknesses.length ? weaknesses : ['핵심 약점 데이터 추가 확인 필요'],
    businessStage: stage,
    revenueStatus,
    growthPotential,
    validationNeeded,
    events,
    evidence,
    financial,
    priceContext,
    upsideFactors: upsideFactors.length ? upsideFactors : ['신규 계약·실적 개선 등 확정 촉매 필요'],
    downsideFactors,
    timing,
    peerNames: module.peers,
    peerComparison: buildPeerComparison(module, dimensions, profile),
    missingData,
    dataSources: dataSources(input, evidence),
  };
}

export function compareAnalysisSnapshots(previous: StockAnalysisSnapshot | null, current: StockAnalysisSnapshot) {
  if (!previous) return null;
  const changes: string[] = [];
  const scoreDelta = current.overallScore - previous.overallScore;
  const riskDelta = current.riskScore - previous.riskScore;
  if (Math.abs(scoreDelta) >= 1) changes.push(`종합점수 ${scoreDelta > 0 ? '+' : ''}${scoreDelta}점`);
  if (current.verdict !== previous.verdict) changes.push(`종합판단 ${previous.verdict} → ${current.verdict}`);
  if (current.shortTermOutlook !== previous.shortTermOutlook) changes.push(`단기전망 ${previous.shortTermOutlook} → ${current.shortTermOutlook}`);
  if (Math.abs(riskDelta) >= 1) changes.push(`위험도 ${riskDelta > 0 ? '+' : ''}${riskDelta}점`);
  const previousEvents = new Set(previous.events.map((event) => event.id));
  const newEvents = current.events.filter((event) => !previousEvents.has(event.id));
  return {
    changed: changes.length > 0 || newEvents.length > 0,
    scoreDelta,
    riskDelta,
    changes,
    newEvents,
  };
}

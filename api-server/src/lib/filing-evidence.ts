import type { EventType } from './filing-classify';

export type RegulatorySource = 'DART' | 'SEC_EDGAR';
export type PublishedAtPrecision = 'DATE_ONLY';
export type RevisionStatus = 'ORIGINAL' | 'CORRECTION' | 'CANCELLATION' | 'AMENDMENT';
export type DisclosureImportance = 'CRITICAL' | 'IMPORTANT' | 'INFO';
export type MaterialEventType =
  | 'EARNINGS'
  | 'CAPITAL_RAISE'
  | 'CAPITAL_REDUCTION'
  | 'BUYBACK'
  | 'DIVIDEND'
  | 'M_AND_A'
  | 'CONTROLLING_SHAREHOLDER'
  | 'LAWSUIT'
  | 'AUDIT_OPINION'
  | 'TRADING_SUSPENSION'
  | 'DELISTING'
  | 'SUPPLY_CONTRACT';

export interface FilingEvidence {
  source: RegulatorySource;
  sourceLabel: 'DART' | 'SEC EDGAR';
  sourceProvenance: 'DIRECT_REGULATORY_PROVIDER';
  publishedAt: string | null;
  publishedAtPrecision: PublishedAtPrecision;
  collectedAt: string;
  collectionProvenance: 'SERVICE_ASSEMBLY_TIME';
  revisionStatus: RevisionStatus;
  relationProvenance: 'TITLE_OR_FORM_RULE';
  materialEventTypes: MaterialEventType[];
  materialEventLabels: string[];
  importance: DisclosureImportance;
  importanceProvenance: 'DETERMINISTIC_EVENT_TYPE_RULE';
  importanceReasons: string[];
  classificationProvenance: 'DETERMINISTIC_RULE';
  marketImpactStatus: 'UNVERIFIED';
}

const MATERIAL_EVENT_LABELS: Record<MaterialEventType, string> = {
  EARNINGS: '실적/정기보고',
  CAPITAL_RAISE: '증자/자금조달',
  CAPITAL_REDUCTION: '감자/주식병합',
  BUYBACK: '자사주',
  DIVIDEND: '배당',
  M_AND_A: 'M&A/합병·분할',
  CONTROLLING_SHAREHOLDER: '최대주주/지배권',
  LAWSUIT: '소송',
  AUDIT_OPINION: '감사의견',
  TRADING_SUSPENSION: '거래정지',
  DELISTING: '상장폐지',
  SUPPLY_CONTRACT: '공급계약',
};

const CRITICAL_EVENTS = new Set<MaterialEventType>([
  'TRADING_SUSPENSION',
  'DELISTING',
  'AUDIT_OPINION',
]);

function includesAny(text: string, values: string[]) {
  const lower = text.toLowerCase();
  return values.some((value) => lower.includes(value.toLowerCase()));
}

export function normalizeDisclosureGroupKey(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\/a\b/g, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/정정|첨부정정|기재정정|취소|철회/g, '')
    .replace(/[^0-9a-z가-힣]/g, '');
}

function revisionStatusFor(source: RegulatorySource, title: string, form?: string): RevisionStatus {
  if (source === 'DART') {
    if (/취소|철회/.test(title)) return 'CANCELLATION';
    if (/정정|첨부정정|기재정정/.test(title)) return 'CORRECTION';
    return 'ORIGINAL';
  }
  const normalizedForm = String(form ?? '').toUpperCase();
  if (/\/A$/.test(normalizedForm) || /amendment|amended/.test(title.toLowerCase())) return 'AMENDMENT';
  return 'ORIGINAL';
}

function materialEventsFor(text: string, events: EventType[]): MaterialEventType[] {
  const found = new Set<MaterialEventType>();
  const hasEvent = (...values: EventType[]) => values.some((value) => events.includes(value));

  if (includesAny(text, ['사업보고서', '분기보고서', '반기보고서', '10-k', '10-q', 'earnings', 'results'])) found.add('EARNINGS');
  if (hasEvent('ATM', 'OFFERING', 'RIGHTS_OFFERING', 'CB', 'BW') || includesAny(text, ['유상증자', '공모', '증권신고서', 'offering', 'prospectus', 'convertible', 'warrant'])) found.add('CAPITAL_RAISE');
  if (hasEvent('REVERSE_SPLIT') || includesAny(text, ['감자', '주식병합', 'reverse split'])) found.add('CAPITAL_REDUCTION');
  if (includesAny(text, ['자기주식', '자사주', 'share repurchase', 'stock repurchase', 'buyback'])) found.add('BUYBACK');
  if (hasEvent('DIVIDEND') || includesAny(text, ['배당', 'dividend'])) found.add('DIVIDEND');
  if (includesAny(text, ['합병', '분할', '영업양수도', '인수', 'merger', 'acquisition', 'tender offer'])) found.add('M_AND_A');
  if (includesAny(text, ['최대주주', '지배주주', 'controlling shareholder', 'beneficial ownership', '13d', '13g'])) found.add('CONTROLLING_SHAREHOLDER');
  if (includesAny(text, ['소송', 'litigation', 'lawsuit'])) found.add('LAWSUIT');
  if (includesAny(text, ['감사의견', '의견거절', '계속기업', 'going concern', 'qualified opinion', 'adverse opinion'])) found.add('AUDIT_OPINION');
  if (includesAny(text, ['거래정지', 'trading suspension', 'trading halt', 'halt of trading'])) found.add('TRADING_SUSPENSION');
  if (hasEvent('DELISTING') || includesAny(text, ['상장폐지', 'delist'])) found.add('DELISTING');
  if (hasEvent('SUPPLY_CONTRACT') || includesAny(text, ['공급계약', '단일판매', '수주', 'supply contract', 'supply agreement'])) found.add('SUPPLY_CONTRACT');

  return [...found];
}

function importanceFor(materialEvents: MaterialEventType[]) {
  const reasons = materialEvents.map((event) => MATERIAL_EVENT_LABELS[event]);
  if (materialEvents.some((event) => CRITICAL_EVENTS.has(event))) {
    return { importance: 'CRITICAL' as const, reasons };
  }
  if (materialEvents.length > 0) {
    return { importance: 'IMPORTANT' as const, reasons };
  }
  return { importance: 'INFO' as const, reasons: ['중요 이벤트 규칙 해당 없음'] };
}

export function buildFilingEvidence(input: {
  source: RegulatorySource;
  title: string;
  date: string;
  collectedAt: string;
  events: EventType[];
  form?: string;
}): FilingEvidence {
  const materialEventTypes = materialEventsFor(`${input.form ?? ''} ${input.title}`, input.events);
  const importance = importanceFor(materialEventTypes);
  const publishedAt = String(input.date ?? '').trim() || null;

  return {
    source: input.source,
    sourceLabel: input.source === 'DART' ? 'DART' : 'SEC EDGAR',
    sourceProvenance: 'DIRECT_REGULATORY_PROVIDER',
    publishedAt,
    publishedAtPrecision: 'DATE_ONLY',
    collectedAt: input.collectedAt,
    collectionProvenance: 'SERVICE_ASSEMBLY_TIME',
    revisionStatus: revisionStatusFor(input.source, input.title, input.form),
    relationProvenance: 'TITLE_OR_FORM_RULE',
    materialEventTypes,
    materialEventLabels: materialEventTypes.map((event) => MATERIAL_EVENT_LABELS[event]),
    importance: importance.importance,
    importanceProvenance: 'DETERMINISTIC_EVENT_TYPE_RULE',
    importanceReasons: importance.reasons,
    classificationProvenance: 'DETERMINISTIC_RULE',
    marketImpactStatus: 'UNVERIFIED',
  };
}

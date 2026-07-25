// Disclosure / filing classification engine.
//
// Rule-based classifier that tags a regulatory filing (US SEC form + doc
// description, or KR DART report name) with:
//   1. a sentiment  — positive (호재) / negative (악재) / neutral (중립)
//   2. detected event types — the corporate actions investors care about most
//      (ATM, offering, reverse split, CB, BW, rights offering, dividend,
//       supply contract).
//
// Rules are used (not an LLM call) because regulatory filing names/forms are
// highly structured: keyword/form matching is deterministic, instant, and free,
// which is exactly what you want for classifying disclosure feeds.

export type Sentiment = 'positive' | 'negative' | 'neutral';

export type EventType =
  | 'ATM'
  | 'OFFERING'
  | 'REVERSE_SPLIT'
  | 'CB'
  | 'BW'
  | 'RIGHTS_OFFERING'
  | 'DELISTING'
  | 'DIVIDEND'
  | 'SUPPLY_CONTRACT';

export interface Classification {
  sentiment: Sentiment;
  events: EventType[];
  eventLabels: string[]; // Korean chips for the UI
}

// Korean display label per event type.
export const EVENT_LABEL_KO: Record<EventType, string> = {
  ATM: '희석 리스크',
  OFFERING: '희석',
  REVERSE_SPLIT: '감자/병합',
  CB: '전환사채(CB) 희석',
  BW: '신주인수권부사채(BW) 희석',
  RIGHTS_OFFERING: '유상증자 희석',
  DELISTING: '상장폐지 주의',
  DIVIDEND: '배당',
  SUPPLY_CONTRACT: '공급계약',
};

// Dilutive / structurally negative events.
const NEGATIVE_EVENTS: EventType[] = [
  'ATM',
  'OFFERING',
  'REVERSE_SPLIT',
  'CB',
  'BW',
  'RIGHTS_OFFERING',
  'DELISTING',
];
// Shareholder-friendly / business-positive events.
const POSITIVE_EVENTS: EventType[] = ['DIVIDEND', 'SUPPLY_CONTRACT'];

function sentimentFor(events: EventType[]): Sentiment {
  if (events.some((e) => NEGATIVE_EVENTS.includes(e))) return 'negative';
  if (events.some((e) => POSITIVE_EVENTS.includes(e))) return 'positive';
  return 'neutral';
}

function finalize(events: EventType[]): Classification {
  const unique = [...new Set(events)];
  return {
    sentiment: sentimentFor(unique),
    events: unique,
    eventLabels: unique.map((e) => EVENT_LABEL_KO[e]),
  };
}

// ---------------------------------------------------------------------------
// Risk-event classification (recency-aware structured risk model, req #14/#15/#19)
//
// A regulatory event is mapped to a coarse RiskEventType only when it carries a
// genuine risk signal. Routine filings return null so callers can skip them and
// avoid emitting an event for every mundane disclosure.
// ---------------------------------------------------------------------------
export type RiskEventKind =
  | 'DELISTING'
  | 'TRADING_SUSPENSION'
  | 'DILUTION'
  | 'CONVERTIBLE_BOND'
  | 'CAPITAL_IMPAIRMENT'
  | 'GOING_CONCERN'
  | 'OTHER';

// Korean display label per risk-event kind (UI chip).
export const RISK_EVENT_LABEL_KO: Record<RiskEventKind, string> = {
  DELISTING: '상장폐지 위험',
  TRADING_SUSPENSION: '거래정지',
  DILUTION: '지분 희석',
  CONVERTIBLE_BOND: '전환사채(CB) 희석',
  CAPITAL_IMPAIRMENT: '자본잠식',
  GOING_CONCERN: '존속능력 불확실성',
  OTHER: '주요 이벤트',
};

// Detect a risk-event kind from free text (report name / form + description).
// Returns null when no material risk signal is present (routine filing).
export function classifyRiskEvent(text: string): RiskEventKind | null {
  const t = text.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => t.includes(w.toLowerCase()));

  // Delisting / management-issue (관리종목) / listing-eligibility review.
  if (has('상장폐지', '관리종목', '상장적격성', 'delist')) return 'DELISTING';
  // Trading suspension.
  if (has('거래정지', 'trading suspension', 'trading halt', 'halt of trading'))
    return 'TRADING_SUSPENSION';
  // Going concern / audit opinion refusal.
  if (
    has(
      'going concern',
      '계속기업',
      '감사의견거절',
      '감사의견 거절',
      '의견거절',
      'qualified opinion',
      'adverse opinion',
    )
  )
    return 'GOING_CONCERN';
  // Capital impairment (자본잠식).
  if (has('자본잠식', 'capital impairment')) return 'CAPITAL_IMPAIRMENT';
  // Convertible bond / warrant-bond (structural dilution).
  if (
    has('전환사채', '신주인수권부사채', 'convertible', 'warrant bond')
  )
    return 'CONVERTIBLE_BOND';
  // Broad dilution: equity offerings, rights issues, capital reduction, ATM.
  if (
    has(
      '유상증자',
      '주주배정',
      '제3자배정',
      '무상증자',
      '감자',
      'rights offering',
      'at-the-market',
      'offering',
      'prospectus',
      'reverse stock split',
      'reverse split',
    )
  )
    return 'DILUTION';

  return null;
}

// KR — classify from a DART report name (한글).
export function classifyKr(reportName: string): Classification {
  const t = reportName;
  const events: EventType[] = [];

  if (t.includes('유상증자')) events.push('RIGHTS_OFFERING');
  if (t.includes('전환사채')) events.push('CB');
  if (t.includes('신주인수권부사채')) events.push('BW');
  if (t.includes('감자') || t.includes('주식병합') || t.includes('액면병합'))
    events.push('REVERSE_SPLIT');
  if (t.includes('배당')) events.push('DIVIDEND');
  if (
    t.includes('공급계약') ||
    t.includes('단일판매') ||
    t.includes('수주')
  )
    events.push('SUPPLY_CONTRACT');
  if (t.includes('공모') || t.includes('모집')) events.push('OFFERING');
  if (/ATM/i.test(t)) events.push('ATM');
  if (t.includes('상장폐지') || t.includes('관리종목') || t.includes('상장적격성'))
    events.push('DELISTING');

  return finalize(events);
}

// US — classify from a SEC form type + primary document description.
export function classifyUs(form: string, description: string): Classification {
  const f = form.toUpperCase();
  const d = description.toLowerCase();
  const events: EventType[] = [];

  const offeringForm = /^(S-1|S-3|F-1|F-3|424B)/.test(f);

  if (/at-the-market|\batm\b/.test(d) || f === '424B5') events.push('ATM');
  if (/reverse (stock )?split/.test(d)) events.push('REVERSE_SPLIT');
  if (/rights offering/.test(d)) events.push('RIGHTS_OFFERING');
  if (/convertible/.test(d)) events.push('CB');
  if (/warrant/.test(d)) events.push('BW');
  if (/dividend/.test(d)) events.push('DIVIDEND');
  if (/supply (agreement|contract)/.test(d)) events.push('SUPPLY_CONTRACT');
  if (offeringForm || /\boffering\b|prospectus/.test(d))
    events.push('OFFERING');
  // Form 25 / 25-NSE = delisting notification.
  if (/^25(-NSE)?$/.test(f) || /delist/.test(d)) events.push('DELISTING');

  return finalize(events);
}

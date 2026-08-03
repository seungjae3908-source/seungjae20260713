// RiskAnalysisService — deterministic, evidence-driven risk model.
//
// There is NO randomness: every stock defaults to LOW risk (~5/100) and a score
// is only raised when the LIVE regulatory-filing feed (SEC EDGAR / DART)
// contains a real event that justifies it (dilution, delisting, heavy material
// events). A blue-chip therefore never shows a delisting/HIGH risk without a
// real filing to back it. The overall score is the average of the per-item
// scores. If the live feed can't be loaded, risk degrades to the LOW default.
import { getCatalogEntry, type Market } from '../data/catalog';
import {
  FilingService,
  type FilingItem,
  type DisclosureItem,
} from './filing.service';
import {
  classifyRiskEvent,
  RISK_EVENT_LABEL_KO,
  type EventType,
  type RiskEventKind,
} from '../lib/filing-classify';
import type {
  RiskAnalysis,
  RiskEvent,
  RiskEventStatus,
  RiskItem,
  RiskLevel,
} from '../sample/types';

export interface RiskResult extends RiskAnalysis {
  filings: FilingItem[];
  disclosures: DisclosureItem[];
  feedAvailable: boolean;
}

const DELISTING_KEYWORDS = [
  '상장폐지',
  '관리종목',
  '거래정지',
  '감사의견거절',
  '감사의견 거절',
  '자본잠식',
  '횡령',
  '배임',
  'delisting',
  'going concern',
];

const DILUTION_EVENTS = new Set<EventType>([
  'OFFERING',
  'ATM',
  'RIGHTS_OFFERING',
  'CB',
  'BW',
]);

function clamp(n: number): number {
  return Math.max(5, Math.min(90, Math.round(n)));
}

function levelFor(score: number): RiskLevel {
  if (score >= 67) return 'HIGH';
  if (score >= 34) return 'MEDIUM';
  return 'LOW';
}

function mk(label: string, score: number, explanation: string): RiskItem {
  return { label, score, level: levelFor(score), explanation };
}

function hasKeyword(text: string, words: string[]): boolean {
  const l = text.toLowerCase();
  return words.some((w) => l.includes(w.toLowerCase()));
}

function buildKrItems(ds: DisclosureItem[]): RiskItem[] {
  const dilution = ds.filter((d) =>
    d.events.some((e) => DILUTION_EVENTS.has(e)),
  ).length;
  const delisting = ds.filter((d) =>
    hasKeyword(`${d.report} ${d.description}`, DELISTING_KEYWORDS),
  ).length;

  return [
    mk(
      '자본 희석 (증자·CB·BW)',
      dilution ? clamp(30 + dilution * 15) : 8,
      dilution
        ? `최근 1년 희석성 자본조달(유상증자·전환사채 등) 공시 ${dilution}건이 감지되었습니다.`
        : '최근 1년 희석성 자본조달 관련 공시가 확인되지 않았습니다.',
    ),
    mk(
      '상장폐지·관리종목',
      delisting ? clamp(60 + delisting * 15) : 5,
      delisting
        ? `상장폐지·관리종목·거래정지 관련 공시 ${delisting}건이 감지되었습니다.`
        : '최근 공시에서 상장폐지·관리종목·거래정지·감사의견 거절 신호가 확인되지 않았습니다.',
    ),
    mk(
      // Informational only: disclosure VOLUME is not itself a risk event, so it
      // is capped in the LOW band and never drives a blue-chip to HIGH.
      '공시·이벤트 활동성',
      Math.min(20, 5 + Math.floor(ds.length / 25)),
      `최근 1년 DART 공시 ${ds.length}건을 분석했습니다.`,
    ),
  ];
}

function buildUsItems(fs: FilingItem[]): RiskItem[] {
  const offering = fs.filter(
    (f) =>
      /S-1|S-3|424B|F-1|F-3/i.test(f.form) ||
      f.events.some((e) => DILUTION_EVENTS.has(e)),
  ).length;
  const delisting = fs.filter(
    (f) => /^25(-NSE)?$/i.test(f.form) || hasKeyword(f.description, DELISTING_KEYWORDS),
  ).length;
  const eightK = fs.filter((f) => /^8-K/i.test(f.form)).length;

  return [
    mk(
      '희석성 자본조달 (S-1/S-3/424B)',
      offering ? clamp(28 + offering * 12) : 8,
      offering
        ? `최근 공모·일괄신고(S-1/S-3/424B) 관련 공시 ${offering}건이 감지되었습니다.`
        : '최근 공모 관련 증권신고서가 확인되지 않았습니다.',
    ),
    mk(
      '상장폐지 (Form 25)',
      delisting ? clamp(60 + delisting * 20) : 5,
      delisting
        ? `상장폐지(Form 25) 관련 공시 ${delisting}건이 감지되었습니다.`
        : '최근 상장폐지(Form 25) 공시가 확인되지 않았습니다.',
    ),
    mk(
      // Informational only: 8-K frequency alone is not a risk event and is
      // capped in the LOW band so a blue-chip is never HIGH without a real event.
      '중대 경영사항 (8-K 빈도)',
      Math.min(20, 5 + Math.max(0, eightK - 6) * 2),
      `최근 1년 8-K(주요 경영사항) 공시 ${eightK}건을 분석했습니다.`,
    ),
  ];
}

function overallExplanation(
  market: Market,
  items: RiskItem[],
  count: number,
  feedOk: boolean,
): string {
  const src = market === 'US' ? 'SEC EDGAR' : 'DART';
  if (!feedOk) {
    return '실시간 공시 피드를 불러오지 못해 기본(낮음) 위험도로 표시합니다. 잠시 후 다시 시도해 주세요.';
  }
  const top = [...items].sort((a, b) => b.score - a.score)[0];
  if (!top || top.level === 'LOW') {
    return `실시간 ${src} 공시 ${count}건을 분석한 결과, 특별한 위험 신호가 감지되지 않아 위험도는 '낮음'입니다.`;
  }
  return `실시간 ${src} 공시 ${count}건 분석 결과, '${top.label}' 항목의 위험도가 가장 높습니다.`;
}

// Per-kind base risk level for a detected event (before recency downgrade).
function levelForKind(kind: RiskEventKind): RiskLevel {
  switch (kind) {
    case 'DELISTING':
    case 'TRADING_SUSPENSION':
    case 'GOING_CONCERN':
    case 'CAPITAL_IMPAIRMENT':
      return 'HIGH';
    case 'DILUTION':
    case 'CONVERTIBLE_BOND':
      return 'MEDIUM';
    default:
      return 'LOW';
  }
}

// Map an internal RiskEventKind to the frontend RiskEventType (identical union).
function eventTypeFor(kind: RiskEventKind): RiskEvent['type'] {
  return kind;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Recency status from a filing date vs. the REAL current date (req #15/#19):
//   CURRENT    -> within ~90 days
//   WATCH      -> ~90–365 days ago
//   HISTORICAL -> older than 365 days OR date unknown
function statusForDate(date: Date | null, now: Date): RiskEventStatus {
  if (!date || Number.isNaN(date.getTime())) return 'HISTORICAL';
  const ageDays = Math.floor((now.getTime() - date.getTime()) / DAY_MS);
  if (ageDays < 0) return 'CURRENT'; // future-dated (rare) treated as current
  if (ageDays <= 90) return 'CURRENT';
  if (ageDays <= 365) return 'WATCH';
  return 'HISTORICAL';
}

// Parse a YYYY-MM-DD (or YYYYMMDD) string into a Date, or null when unknown.
function parseDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const iso = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A later filing of the same kind that supersedes/cancels an earlier one marks
// the earlier one IGNORED (resolved). Cancellation keywords also force IGNORED.
const RESOLVED_KEYWORDS = ['정정', '철회', '취소', '중단', 'withdrawn', 'terminated', 'cancel'];

function isResolvedText(text: string): boolean {
  const l = text.toLowerCase();
  return RESOLVED_KEYWORDS.some((w) => l.includes(w.toLowerCase()));
}

interface RawRiskSource {
  text: string; // classification input (report/form + description)
  title: string; // human-readable report name
  summary: string;
  date: string;
  url: string | null;
  source: RiskEvent['source'];
}

// Build recency-aware RiskEvent[] from a normalized list of filing/disclosure
// sources. Only entries carrying a real risk signal become events.
function buildRiskEvents(sources: RawRiskSource[], now: Date): RiskEvent[] {
  const events: RiskEvent[] = [];
  // Track the most-recent CURRENT/WATCH event per kind so an older duplicate of
  // the same kind is downgraded to IGNORED (superseded).
  const latestByKind = new Map<RiskEventKind, number>();

  sources.forEach((s, index) => {
    const kind = classifyRiskEvent(s.text);
    if (!kind) return; // routine filing — no event emitted

    const date = parseDate(s.date);
    const resolved = isResolvedText(s.text);
    const status: RiskEventStatus = resolved
      ? 'IGNORED'
      : statusForDate(date, now);

    // Supersession: if an earlier, active event of the same kind already exists,
    // the older one is IGNORED (a later filing supersedes it).
    const seen = latestByKind.get(kind);
    if (
      !resolved &&
      seen !== undefined &&
      date &&
      status !== 'HISTORICAL'
    ) {
      // Newer active events keep their status; the previously-seen older one was
      // pushed first, so mark that earlier event IGNORED.
      const prior = events[seen];
      const priorDate = parseDate(prior.date);
      if (priorDate && date.getTime() > priorDate.getTime()) {
        prior.status = 'IGNORED';
        prior.level = 'LOW';
        prior.isResolved = true;
        prior.isRecent = false;
      }
    }
    if (!resolved && (status === 'CURRENT' || status === 'WATCH')) {
      latestByKind.set(kind, events.length);
    }

    events.push({
      id: `${s.source}-${s.date || 'nodate'}-${index}`,
      type: eventTypeFor(kind),
      label: RISK_EVENT_LABEL_KO[kind],
      status,
      level: status === 'IGNORED' || status === 'HISTORICAL'
        ? 'LOW'
        : levelForKind(kind),
      date: date ? s.date : null,
      title: s.title,
      summary: s.summary,
      source: s.source,
      url: s.url,
      isRecent: status === 'CURRENT',
      isResolved: status === 'IGNORED',
    });
  });

  return events;
}

// Normalize KR disclosures into risk-event sources (title = DART report name).
function krRiskSources(ds: DisclosureItem[]): RawRiskSource[] {
  return ds.map((d) => ({
    text: `${d.report} ${d.description}`,
    title: d.report,
    summary: d.description || d.report,
    date: d.date,
    url: d.url || null,
    source: 'DART',
  }));
}

// Normalize US filings into risk-event sources (title = "${form} · ${description}").
function usRiskSources(fs: FilingItem[]): RawRiskSource[] {
  return fs.map((f) => ({
    text: `${f.form} ${f.description}`,
    title: `${f.form} · ${f.description}`,
    summary: `${f.form} 공시: ${f.description}`,
    date: f.date,
    url: f.url || null,
    source: 'SEC',
  }));
}

export const RiskAnalysisService = {
  async getRisk(ticker: string): Promise<RiskResult | null> {
    const entry = getCatalogEntry(ticker);
    if (!entry) return null;

    let filings: FilingItem[] = [];
    let disclosures: DisclosureItem[] = [];
    let feedOk = false;
    try {
      const feed = await FilingService.getFilings(ticker);
      if (feed) {
        filings = feed.filings;
        disclosures = feed.disclosures;
        feedOk = true;
      }
    } catch (err) {
      console.error('risk filing feed unavailable:', err);
    }

    const items =
      entry.market === 'US' ? buildUsItems(filings) : buildKrItems(disclosures);

    const overallScore = items.length
      ? Math.round(items.reduce((s, i) => s + i.score, 0) / items.length)
      : 5;
    const overallLevel = levelFor(overallScore);
    const count = filings.length + disclosures.length;

    // Recency-aware structured risk events from the LIVE feed (req #14/#15/#19).
    // Degrades to [] when the feed failed — never fabricated.
    const now = new Date();
    const events: RiskEvent[] = feedOk
      ? buildRiskEvents(
          entry.market === 'US'
            ? usRiskSources(filings)
            : krRiskSources(disclosures),
          now,
        )
      : [];

    return {
      market: entry.market,
      items,
      events,
      overallScore,
      overallLevel,
      explanation: overallExplanation(entry.market, items, count, feedOk),
      filings,
      disclosures,
      feedAvailable: feedOk,
    };
  },
};

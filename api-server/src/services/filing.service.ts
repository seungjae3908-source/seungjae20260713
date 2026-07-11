// FilingService — live regulatory-filing feed.
//
// US  -> SEC EDGAR filing history (real document URLs)
// KR  -> DART recent disclosures (real document viewer URLs)
//
// Each item is classified (sentiment + detected corporate-action events) so the
// UI can surface 호재/악재/중립 and event chips. There is NO sample fallback:
// on provider failure the error propagates so the caller can respond honestly.
import { getCatalogEntry } from '../data/catalog';
import { getFilings as getSecFilings } from '../providers/sec-edgar';
import { getDisclosures as getDartDisclosures } from '../providers/dart';
import {
  classifyKr,
  classifyUs,
  type Sentiment,
  type EventType,
} from '../lib/filing-classify';

export interface FilingItem {
  form: string;
  date: string;
  description: string;
  url: string;
  sentiment: Sentiment;
  events: EventType[];
  eventLabels: string[];
}

export interface DisclosureItem {
  report: string;
  date: string;
  description: string;
  url: string;
  sentiment: Sentiment;
  events: EventType[];
  eventLabels: string[];
}

export interface FilingResult {
  market: 'US' | 'KR';
  filings: FilingItem[];
  disclosures: DisclosureItem[];
}

// Human-readable Korean description for common SEC form types.
const US_FORM_DESC: Record<string, string> = {
  '10-K': '연간 사업보고서',
  '10-Q': '분기 보고서',
  '8-K': '주요 경영사항 공시',
  'S-1': '증권신고서 (공모)',
  'S-3': '일괄신고서',
  'F-1': '외국기업 증권신고서',
  'F-3': '외국기업 일괄신고서',
  '424B5': '증권설명서 (오퍼링/ATM)',
  '424B3': '증권설명서',
  '424B4': '증권설명서',
  DEF14A: '주주총회 소집공고',
  SC13D: '지분 5% 이상 보유 공시',
  SC13G: '지분 보유 공시',
  '4': '내부자 지분변동',
  '3': '내부자 지분 최초보고',
  '13F-HR': '기관 보유내역',
};

function usDescription(form: string, providerDesc: string): string {
  return US_FORM_DESC[form.toUpperCase()] ?? providerDesc ?? form;
}

// Format YYYYMMDD (DART) -> YYYY-MM-DD.
function fmtKrDate(d: string): string {
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
}

export const FilingService = {
  async getFilings(ticker: string): Promise<FilingResult | null> {
    const entry = getCatalogEntry(ticker);
    if (!entry) return null;

    if (entry.market === 'US') {
      const raw = await getSecFilings(entry.ticker);
      // SEC full-text search page for this ticker — a valid fallback link when a
      // specific filing has no accession-based document URL.
      const secFallback = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(
        entry.ticker,
      )}&type=&dateb=&owner=include&count=40`;
      const filings: FilingItem[] = raw.map((f) => {
        const c = classifyUs(f.form, f.description);
        return {
          form: f.form,
          date: f.date,
          description: usDescription(f.form, f.description),
          url: f.url || secFallback,
          sentiment: c.sentiment,
          events: c.events,
          eventLabels: c.eventLabels,
        };
      });
      return { market: 'US', filings, disclosures: [] };
    }

    // KR — ticker is the 6-digit stock code.
    const raw = await getDartDisclosures(entry.ticker);
    // DART company search page — valid fallback if a receipt URL is missing.
    const dartFallback = `https://dart.fss.or.kr/dsab007/main.do?textCrpNm=${encodeURIComponent(
      entry.name,
    )}`;
    const disclosures: DisclosureItem[] = raw.map((d) => {
      const c = classifyKr(d.reportName);
      return {
        report: d.reportName,
        date: fmtKrDate(d.date),
        description: `제출: ${d.filer}`,
        url: d.url || dartFallback,
        sentiment: c.sentiment,
        events: c.events,
        eventLabels: c.eventLabels,
      };
    });
    return { market: 'KR', filings: [], disclosures };
  },
};

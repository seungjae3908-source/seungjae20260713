import { getCatalogEntry } from '../data/catalog';
import { getFilings as getSecFilings } from '../providers/sec-edgar';
import { getDisclosures as getDartDisclosures } from '../providers/dart';
import { classifyKr, classifyUs, type Sentiment, type EventType } from '../lib/filing-classify';

interface CommonItem { date: string; url: string; sentiment: Sentiment; events: EventType[]; eventLabels: string[]; relatedCount?: number }
export interface FilingItem extends CommonItem { form: string; description: string }
export interface DisclosureItem extends CommonItem { report: string; description: string }
export interface FilingResult { market: 'US' | 'KR'; filings: FilingItem[]; disclosures: DisclosureItem[] }

const US_FORM_DESC: Record<string, string> = {
  '10-K': '연간 사업보고서', '10-Q': '분기 보고서', '8-K': '주요 경영사항 공시',
  'S-1': '증권신고서(공모)', 'S-3': '선반등록 신고서', 'F-1': '외국기업 증권신고서',
  'F-3': '외국기업 선반등록', '424B5': '증권설명서', '424B3': '증권설명서',
  '424B4': '증권설명서', DEF14A: '주주총회 소집공고', SC13D: '지분 5% 이상 보유 공시',
  SC13G: '지분 보유 공시', '4': '임원 지분변동', '3': '임원 지분 최초보고', '13F-HR': '기관 보유내역',
};

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)|[^0-9a-z가-힣]/g, '').replace(/정정|첨부정정|기재정정/g, '');
}
function dedupe<T extends CommonItem>(items: T[], titleOf: (item: T) => string, limit: number | null): T[] {
  const merged = new Map<string, T>();
  for (const item of [...items].sort((a, b) => b.date.localeCompare(a.date))) {
    const key = normalizeTitle(titleOf(item));
    const current = merged.get(key);
    if (current) current.relatedCount = (current.relatedCount ?? 1) + 1;
    else merged.set(key, { ...item, relatedCount: 1 });
  }
  const rows = [...merged.values()];
  return limit == null ? rows : rows.slice(0, limit);
}
function krDate(value: string) { return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value; }

export const FilingService = {
  async getFilings(ticker: string, options: { allHistory?: boolean } = {}): Promise<FilingResult | null> {
    const entry = getCatalogEntry(ticker);
    if (!entry) return null;
    if (entry.market === 'US') {
      const raw = await getSecFilings(entry.ticker);
      const filings = raw.map((row) => {
        const classification = classifyUs(row.form, row.description);
        return { form: row.form, date: row.date, description: US_FORM_DESC[row.form.toUpperCase()] ?? row.description ?? row.form, url: row.url, sentiment: classification.sentiment, events: classification.events, eventLabels: classification.eventLabels };
      });
      return { market: 'US', filings: dedupe(filings, (row) => `${row.form}${row.description}`, options.allHistory ? null : 5), disclosures: [] };
    }
    const raw = await getDartDisclosures(entry.ticker);
    const disclosures = raw.map((row) => {
      const classification = classifyKr(row.reportName);
      return { report: row.reportName, date: krDate(row.date), description: `제출인: ${row.filer}`, url: row.url, sentiment: classification.sentiment, events: classification.events, eventLabels: classification.eventLabels };
    });
    return { market: 'KR', filings: [], disclosures: dedupe(disclosures, (row) => row.report, options.allHistory ? null : 5) };
  },
};

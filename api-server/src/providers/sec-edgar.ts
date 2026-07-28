// SEC EDGAR provider (US): detects capital-structure / going-concern risk
// signals from a company's recent filing history. Free, no API key, but SEC
// requires a descriptive User-Agent.
// Docs: https://www.sec.gov/os/accessing-edgar-data
import { SEC_USER_AGENT } from '../lib/config';
import { ProviderError } from '../lib/errors';
import { fetchJson } from '../lib/http';
import { cached, TTL } from '../lib/cache';
import type { FinancialRow } from '../sample/types';

const HEADERS = {
  'User-Agent': SEC_USER_AGENT,
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, deflate',
};

interface TickerMapEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

async function getCikByTicker(ticker: string): Promise<string> {
  // Map 인스턴스는 Supabase jsonb 캐시에 저장하면 일반 객체로 바뀌어
  // 재시작 뒤 map.get 오류가 발생할 수 있습니다. JSON으로 안전하게 저장되는
  // Record를 사용하고, 이전의 손상된 캐시를 피하려고 키 버전을 올립니다.
  const byTicker = await cached<Record<string, string>>(
    'sec:tickermap:v2',
    TTL.mapping,
    async () => {
      const data = await fetchJson<Record<string, TickerMapEntry>>(
        'https://www.sec.gov/files/company_tickers.json',
        { provider: 'sec-edgar', headers: HEADERS },
      );
      const lookup: Record<string, string> = {};
      for (const key of Object.keys(data)) {
        const entry = data[key];
        if (!entry?.ticker) continue;
        lookup[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, '0');
      }
      return lookup;
    },
  );
  const cik = byTicker[ticker.toUpperCase()];
  if (!cik) {
    throw new ProviderError('UNAVAILABLE', 'sec-edgar', `no CIK for ${ticker}`);
  }
  return cik;
}

interface Submissions {
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      accessionNumber?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
    };
  };
}

export interface SecFiling {
  form: string;
  date: string; // YYYY-MM-DD
  description: string;
  url: string; // real EDGAR document URL
}

// Real EDGAR document URL for a filing.
function edgarDocUrl(
  cik: string,
  accession: string,
  primaryDoc: string,
): string {
  // Without an accession number we cannot build a valid document URL. Return
  // empty rather than fabricating a broken path (callers surface "no link").
  if (!accession) return '';
  const cikNum = String(Number(cik)); // strip leading zeros
  const acc = accession.replace(/-/g, '');
  if (primaryDoc) {
    return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${primaryDoc}`;
  }
  // Fall back to the filing index directory when there's no primary document.
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/`;
}

// Latest individual filings (real filing history) with real document URLs.
export async function getFilings(
  ticker: string,
  limit = 20,
): Promise<SecFiling[]> {
  const cik = await getCikByTicker(ticker);
  return cached(`sec:filinglist:${cik}`, TTL.risk, async () => {
    const data = await fetchJson<Submissions>(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { provider: 'sec-edgar', headers: HEADERS },
    );
    const recent = data.filings?.recent;
    const forms = recent?.form ?? [];
    const dates = recent?.filingDate ?? [];
    const accessions = recent?.accessionNumber ?? [];
    const docs = recent?.primaryDocument ?? [];
    const descs = recent?.primaryDocDescription ?? [];

    const out: SecFiling[] = [];
    for (let i = 0; i < forms.length && out.length < limit; i++) {
      const form = forms[i] ?? '';
      if (!form) continue;
      out.push({
        form,
        date: dates[i] ?? '',
        description: descs[i] ?? '',
        url: edgarDocUrl(cik, accessions[i] ?? '', docs[i] ?? ''),
      });
    }
    return out;
  });
}

// XBRL company facts 요약: 전체 JSON(수 MB)에서 주요 지표의 최신값만 추린다.
export interface CompanyFactsSummary {
  entityName: string;
  cik: string;
  facts: Array<{
    key: string;
    label: string;
    unit: string;
    value: number;
    end: string; // 기준일 (기간 종료일)
    fy?: string | number;
    fp?: string;
    form?: string;
  }>;
}

const FACT_KEYS: Array<{ key: string; label: string }> = [
  { key: 'RevenueFromContractWithCustomerExcludingAssessedTax', label: '매출액' },
  { key: 'Revenues', label: '매출액' },
  { key: 'NetIncomeLoss', label: '순이익' },
  { key: 'Assets', label: '총자산' },
  { key: 'Liabilities', label: '총부채' },
  { key: 'StockholdersEquity', label: '자본총계' },
  { key: 'EarningsPerShareDiluted', label: '희석 EPS' },
  { key: 'CommonStockSharesOutstanding', label: '발행주식수' },
  { key: 'CashAndCashEquivalentsAtCarryingValue', label: '현금및현금성자산' },
];

export async function getCompanyFactsSummary(
  ticker: string,
): Promise<CompanyFactsSummary> {
  const cik = await getCikByTicker(ticker);
  return cached(`sec:companyfacts:${cik}`, TTL.risk, async () => {
    const data = await fetchJson<{
      entityName?: string;
      facts?: Record<string, Record<string, { units?: Record<string, Array<{ val?: number; end?: string; fy?: number; fp?: string; form?: string }>> }>>;
    }>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      provider: 'sec-edgar',
      headers: HEADERS,
    });
    const gaap = data.facts?.['us-gaap'] ?? {};
    const out: CompanyFactsSummary = {
      entityName: data.entityName ?? ticker,
      cik,
      facts: [],
    };
    const seenLabels = new Set<string>();
    for (const { key, label } of FACT_KEYS) {
      if (seenLabels.has(label)) continue;
      const units = gaap[key]?.units;
      if (!units) continue;
      const unitName = Object.keys(units)[0];
      const rows = units[unitName] ?? [];
      // 기준일(end) 최신 항목을 고른다 — 오래된 값을 최신처럼 표시하지 않는다.
      const latest = [...rows]
        .filter((r) => typeof r.val === 'number' && r.end)
        .sort((a, b) => String(b.end).localeCompare(String(a.end)))[0];
      if (!latest) continue;
      seenLabels.add(label);
      out.facts.push({
        key,
        label,
        unit: unitName,
        value: latest.val as number,
        end: latest.end as string,
        fy: latest.fy,
        fp: latest.fp,
        form: latest.form,
      });
    }
    return out;
  });
}

export async function getRiskAnalysis(
  ticker: string,
): Promise<{
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  events: string[];
  filings: SecFiling[];
}> {
  const filings = await getFilings(ticker, 40);
  const text = filings
    .map((f) => `${f.form} ${f.description}`.toLowerCase())
    .join(' ');
  const events: string[] = [];
  if (/s-1|s-3|424b|prospectus/.test(text)) events.push('증자·신주발행 관련 공시');
  if (/8-k/.test(text)) events.push('중요 경영사항 공시(8-K)');
  if (/10-k/.test(text)) events.push('연차보고서(10-K)');
  if (/10-q/.test(text)) events.push('분기보고서(10-Q)');
  const dilutionCount = filings.filter((f) => /s-1|s-3|424b/i.test(`${f.form} ${f.description}`)).length;
  const riskLevel = dilutionCount >= 3 ? 'high' : dilutionCount >= 1 ? 'medium' : 'low';
  const summary =
    riskLevel === 'high'
      ? '최근 증자·신주발행 관련 공시가 반복되어 희석 위험을 주의해야 합니다.'
      : riskLevel === 'medium'
        ? '최근 증자·신주발행 관련 공시가 있어 희석 가능성을 확인해야 합니다.'
        : '최근 공시에서 반복적인 증자·희석 신호가 두드러지지 않습니다.';
  return { riskLevel, summary, events, filings };
}

export function mapFactsToFinancialRows(summary: CompanyFactsSummary): FinancialRow[] {
  return summary.facts.map((fact) => ({
    label: fact.label,
    value: fact.value,
    unit: fact.unit,
    period: fact.end,
  }));
}

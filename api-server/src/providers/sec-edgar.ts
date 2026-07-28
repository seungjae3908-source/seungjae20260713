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
  // Map instances do not survive JSON-backed caches. Store a plain record so
  // the lookup remains valid after a process restart or persistent cache hit.
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
  date: string;
  description: string;
  url: string;
}

function edgarDocUrl(
  cik: string,
  accession: string,
  primaryDoc: string,
): string {
  if (!accession) return '';
  const cikNum = String(Number(cik));
  const acc = accession.replace(/-/g, '');
  if (primaryDoc) {
    return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${primaryDoc}`;
  }
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/`;
}

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
    for (let index = 0; index < forms.length && out.length < limit; index += 1) {
      const form = forms[index] ?? '';
      if (!form) continue;
      out.push({
        form,
        date: dates[index] ?? '',
        description: descs[index] ?? '',
        url: edgarDocUrl(cik, accessions[index] ?? '', docs[index] ?? ''),
      });
    }
    return out;
  });
}

export interface CompanyFactsSummary {
  entityName: string;
  cik: string;
  facts: Array<{
    key: string;
    label: string;
    unit: string;
    value: number;
    end: string;
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
      facts?: Record<
        string,
        Record<
          string,
          {
            units?: Record<
              string,
              Array<{
                val?: number;
                end?: string;
                fy?: number;
                fp?: string;
                form?: string;
              }>
            >;
          }
        >
      >;
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
      const latest = [...rows]
        .filter((row) => typeof row.val === 'number' && row.end)
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

export interface FilingCounts {
  offering: number;
  reverseSplit: number;
  delisting: number;
  eightK: number;
  totalRecent: number;
}

export async function getFilingCounts(ticker: string): Promise<FilingCounts> {
  const cik = await getCikByTicker(ticker);
  return cached(`sec:filings:${cik}`, TTL.risk, async () => {
    const data = await fetchJson<Submissions>(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { provider: 'sec-edgar', headers: HEADERS },
    );
    const forms = data.filings?.recent?.form ?? [];
    const dates = data.filings?.recent?.filingDate ?? [];
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;

    const counts: FilingCounts = {
      offering: 0,
      reverseSplit: 0,
      delisting: 0,
      eightK: 0,
      totalRecent: 0,
    };

    for (let index = 0; index < forms.length; index += 1) {
      const form = (forms[index] ?? '').toUpperCase();
      const date = dates[index] ? new Date(dates[index]).getTime() : 0;
      if (date < cutoff) continue;
      counts.totalRecent += 1;
      if (/^(?:S-1|S-3|424B)/.test(form)) counts.offering += 1;
      if (form === '25' || form === '25-NSE') counts.delisting += 1;
      if (form.startsWith('8-K')) counts.eightK += 1;
    }

    counts.reverseSplit =
      counts.offering >= 2 && counts.eightK >= 6 ? 1 : 0;
    return counts;
  });
}

export interface FinancialsRaw {
  annual: FinancialRow[];
  quarterly: FinancialRow[];
  latest: {
    equity: number;
    liabilities: number;
    netIncome: number;
    cash: number;
  };
}

const CAPITAL_TAGS = [
  'CommonStockValue',
  'CommonStocksIncludingAdditionalPaidInCapital',
];

interface XbrlPoint {
  start?: string;
  end: string;
  val: number;
  form?: string;
}

interface XbrlConcept {
  units?: Record<string, XbrlPoint[]>;
}

function daysBetween(start: string, end: string): number {
  return Math.abs(
    (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
  );
}

async function concept(cik: string, tag: string): Promise<XbrlPoint[]> {
  try {
    const data = await fetchJson<XbrlConcept>(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`,
      { provider: 'sec-edgar', headers: HEADERS },
    );
    const units = data.units ?? {};
    const unit = Object.keys(units)[0];
    return unit ? units[unit] : [];
  } catch {
    return [];
  }
}

async function firstConcept(cik: string, tags: string[]): Promise<XbrlPoint[]> {
  for (const tag of tags) {
    const points = await concept(cik, tag);
    if (points.length > 0) return points;
  }
  return [];
}

function annualFlow(points: XbrlPoint[]): Map<string, number> {
  const byYear = new Map<string, number>();
  for (const point of points) {
    if (point.form !== '10-K' || !point.start) continue;
    const duration = daysBetween(point.start, point.end);
    if (duration < 300 || duration > 400) continue;
    byYear.set(point.end.slice(0, 4), point.val);
  }
  return byYear;
}

function instantByYear(points: XbrlPoint[]): Map<string, number> {
  const byYear = new Map<string, number>();
  for (const point of [...points].sort((a, b) => a.end.localeCompare(b.end))) {
    if (point.start) continue;
    if (point.form !== '10-K' && point.form !== '10-Q') continue;
    byYear.set(point.end.slice(0, 4), point.val);
  }
  return byYear;
}

function quarterlyFlow(points: XbrlPoint[]): Array<{ end: string; val: number }> {
  const byEnd = new Map<string, number>();
  for (const point of points) {
    if (!point.start) continue;
    if (point.form !== '10-Q' && point.form !== '10-K') continue;
    const duration = daysBetween(point.start, point.end);
    if (duration < 80 || duration > 100) continue;
    byEnd.set(point.end, point.val);
  }
  return [...byEnd.entries()]
    .map(([end, val]) => ({ end, val }))
    .sort((a, b) => a.end.localeCompare(b.end));
}

function instantAt(points: XbrlPoint[], end: string): number {
  const exact = points.find((point) => !point.start && point.end === end);
  return exact?.val ?? 0;
}

const REVENUE_TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
];

export async function getFinancials(ticker: string): Promise<FinancialsRaw> {
  const cik = await getCikByTicker(ticker);
  return cached(`sec:financials:${cik}`, TTL.financials, async () => {
    const [revenue, operatingIncome, netIncome, cash, liabilities, equity, capital] =
      await Promise.all([
        firstConcept(cik, REVENUE_TAGS),
        concept(cik, 'OperatingIncomeLoss'),
        concept(cik, 'NetIncomeLoss'),
        firstConcept(cik, [
          'CashAndCashEquivalentsAtCarryingValue',
          'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
        ]),
        concept(cik, 'Liabilities'),
        concept(cik, 'StockholdersEquity'),
        firstConcept(cik, CAPITAL_TAGS),
      ]);

    const revenueAnnual = annualFlow(revenue);
    const operatingAnnual = annualFlow(operatingIncome);
    const netAnnual = annualFlow(netIncome);
    const cashAnnual = instantByYear(cash);
    const liabilitiesAnnual = instantByYear(liabilities);
    const equityAnnual = instantByYear(equity);
    const capitalAnnual = instantByYear(capital);

    const years = [...new Set([...revenueAnnual.keys(), ...netAnnual.keys()])]
      .sort()
      .slice(-5);

    const annual: FinancialRow[] = years.map((year) => {
      const row: FinancialRow = {
        period: year,
        revenue: revenueAnnual.get(year) ?? 0,
        operatingIncome: operatingAnnual.get(year) ?? 0,
        netIncome: netAnnual.get(year) ?? 0,
        cash: cashAnnual.get(year) ?? 0,
        debt: liabilitiesAnnual.get(year) ?? 0,
      };

      const equityValue = equityAnnual.get(year);
      if (equityValue != null) row.equity = equityValue;
      const capitalValue = capitalAnnual.get(year);
      if (capitalValue != null) row.capital = capitalValue;
      return row;
    });

    if (annual.length < 2) {
      throw new ProviderError('UNAVAILABLE', 'sec-edgar', `sparse XBRL for ${ticker}`);
    }

    const revenueQuarterlyRows = quarterlyFlow(revenue);
    const netQuarterlyRows = quarterlyFlow(netIncome);
    const anchor = revenueQuarterlyRows.length > 0
      ? revenueQuarterlyRows
      : netQuarterlyRows;
    const revenueQuarterly = new Map(
      revenueQuarterlyRows.map((row) => [row.end, row.val]),
    );
    const operatingQuarterly = new Map(
      quarterlyFlow(operatingIncome).map((row) => [row.end, row.val]),
    );
    const netQuarterly = new Map(
      netQuarterlyRows.map((row) => [row.end, row.val]),
    );

    const quarterly: FinancialRow[] = anchor.slice(-4).map((row) => ({
      period: row.end.slice(0, 7),
      revenue: revenueQuarterly.get(row.end) ?? 0,
      operatingIncome: operatingQuarterly.get(row.end) ?? 0,
      netIncome: netQuarterly.get(row.end) ?? 0,
      cash: instantAt(cash, row.end),
      debt: instantAt(liabilities, row.end),
    }));

    const latestYear = years[years.length - 1];
    return {
      annual,
      quarterly,
      latest: {
        equity: latestYear ? equityAnnual.get(latestYear) ?? 0 : 0,
        liabilities: latestYear
          ? liabilitiesAnnual.get(latestYear) ?? 0
          : 0,
        netIncome: latestYear ? netAnnual.get(latestYear) ?? 0 : 0,
        cash: latestYear ? cashAnnual.get(latestYear) ?? 0 : 0,
      },
    };
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
    .map((filing) => `${filing.form} ${filing.description}`.toLowerCase())
    .join(' ');
  const events: string[] = [];
  if (/s-1|s-3|424b|prospectus/.test(text)) {
    events.push('증자·신주발행 관련 공시');
  }
  if (/8-k/.test(text)) events.push('중요 경영사항 공시(8-K)');
  if (/10-k/.test(text)) events.push('연차보고서(10-K)');
  if (/10-q/.test(text)) events.push('분기보고서(10-Q)');

  const dilutionCount = filings.filter((filing) =>
    /s-1|s-3|424b/i.test(`${filing.form} ${filing.description}`),
  ).length;
  const riskLevel = dilutionCount >= 3
    ? 'high'
    : dilutionCount >= 1
      ? 'medium'
      : 'low';
  const summary = riskLevel === 'high'
    ? '최근 증자·신주발행 관련 공시가 반복되어 희석 위험을 주의해야 합니다.'
    : riskLevel === 'medium'
      ? '최근 증자·신주발행 관련 공시가 있어 희석 가능성을 확인해야 합니다.'
      : '최근 공시에서 반복적인 증자·희석 신호가 두드러지지 않습니다.';

  return { riskLevel, summary, events, filings };
}

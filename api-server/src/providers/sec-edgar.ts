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
  const map = await cached('sec:tickermap', TTL.mapping, async () => {
    const data = await fetchJson<Record<string, TickerMapEntry>>(
      'https://www.sec.gov/files/company_tickers.json',
      { provider: 'sec-edgar', headers: HEADERS },
    );
    const byTicker = new Map<string, string>();
    for (const key of Object.keys(data)) {
      const entry = data[key];
      byTicker.set(
        entry.ticker.toUpperCase(),
        String(entry.cik_str).padStart(10, '0'),
      );
    }
    return byTicker;
  });
  const cik = map.get(ticker.toUpperCase());
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

export interface FilingCounts {
  offering: number; // S-1/S-3/424B — dilutive offerings
  reverseSplit: number; // 8-K item 3.03 style structural changes (proxy)
  delisting: number; // Form 25 / 25-NSE
  eightK: number; // recent 8-K material events
  totalRecent: number;
}

// Rough form-based classification. Real filings, real counts per company.
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

    for (let i = 0; i < forms.length; i++) {
      const form = (forms[i] ?? '').toUpperCase();
      const date = dates[i] ? new Date(dates[i]).getTime() : 0;
      if (date < cutoff) continue;
      counts.totalRecent++;
      if (/^S-1|^S-3|^424B/.test(form)) counts.offering++;
      if (form === '25' || form === '25-NSE') counts.delisting++;
      if (form.startsWith('8-K')) counts.eightK++;
    }
    // Reverse splits are usually disclosed via 8-K item 3.03; without item-level
    // parsing we use a conservative proxy: heavy 8-K + offering activity.
    counts.reverseSplit =
      counts.offering >= 2 && counts.eightK >= 6 ? 1 : 0;
    return counts;
  });
}

// --- Fundamentals (real annual/quarterly statements via SEC XBRL) -----------

export interface FinancialsRaw {
  annual: FinancialRow[];
  quarterly: FinancialRow[];
  latest: { equity: number; liabilities: number; netIncome: number; cash: number };
}

// Common stock (contributed capital) tags, used to populate `capital`.
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

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000,
  );
}

async function concept(cik: string, tag: string): Promise<XbrlPoint[]> {
  try {
    const data = await fetchJson<XbrlConcept>(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`,
      { provider: 'sec-edgar', headers: HEADERS },
    );
    const units = data.units ?? {};
    const key = Object.keys(units)[0];
    return key ? units[key] : [];
  } catch {
    return [];
  }
}

async function firstConcept(cik: string, tags: string[]): Promise<XbrlPoint[]> {
  for (const t of tags) {
    const pts = await concept(cik, t);
    if (pts.length) return pts;
  }
  return [];
}

// Annual flow (income-statement) values keyed by fiscal-year-end year.
function annualFlow(pts: XbrlPoint[]): Map<string, number> {
  const byYear = new Map<string, number>();
  for (const p of pts) {
    if (p.form !== '10-K' || !p.start) continue;
    const dur = daysBetween(p.start, p.end);
    if (dur < 300 || dur > 400) continue;
    byYear.set(p.end.slice(0, 4), p.val);
  }
  return byYear;
}

// Instant (balance-sheet) values keyed by year-end, taking the latest report.
function instantByYear(pts: XbrlPoint[]): Map<string, number> {
  const byYear = new Map<string, number>();
  for (const p of [...pts].sort((a, b) => a.end.localeCompare(b.end))) {
    if (p.start) continue;
    if (p.form !== '10-K' && p.form !== '10-Q') continue;
    byYear.set(p.end.slice(0, 4), p.val);
  }
  return byYear;
}

// Trailing quarterly flow datapoints (≈90-day periods), sorted by end date.
function quarterlyFlow(pts: XbrlPoint[]): { end: string; val: number }[] {
  const m = new Map<string, number>();
  for (const p of pts) {
    if (!p.start) continue;
    if (p.form !== '10-Q' && p.form !== '10-K') continue;
    const dur = daysBetween(p.start, p.end);
    if (dur < 80 || dur > 100) continue;
    m.set(p.end, p.val);
  }
  return [...m.entries()]
    .map(([end, val]) => ({ end, val }))
    .sort((a, b) => a.end.localeCompare(b.end));
}

function instantAt(pts: XbrlPoint[], end: string): number {
  const exact = pts.find((p) => !p.start && p.end === end);
  return exact ? exact.val : 0;
}

const REVENUE_TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
];

export async function getFinancials(ticker: string): Promise<FinancialsRaw> {
  const cik = await getCikByTicker(ticker);
  return cached(`sec:financials:${cik}`, TTL.financials, async () => {
    const [rev, op, net, cash, liab, equity, capital] = await Promise.all([
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

    const revA = annualFlow(rev);
    const opA = annualFlow(op);
    const netA = annualFlow(net);
    const cashA = instantByYear(cash);
    const liabA = instantByYear(liab);
    const equityA = instantByYear(equity);
    const capitalA = instantByYear(capital);

    // Anchor annual periods on the UNION of core income-statement concepts, so a
    // company that reports NetIncome under a tag variant without a matching
    // Revenues tag still yields coherent rows (rather than a silent empty set).
    const years = [...new Set([...revA.keys(), ...netA.keys()])]
      .sort()
      .slice(-5);
    const annual: FinancialRow[] = years.map((y) => {
      const row: FinancialRow = {
        period: y,
        revenue: revA.get(y) ?? 0,
        operatingIncome: opA.get(y) ?? 0,
        netIncome: netA.get(y) ?? 0,
        cash: cashA.get(y) ?? 0,
        debt: liabA.get(y) ?? 0,
      };

      const eq = equityA.get(y);
      if (eq != null) row.equity = eq;

      const cap = capitalA.get(y);
      if (cap != null) row.capital = cap;

      return row;
    });

    // Below this coherence threshold the live view is too sparse to trust — throw
    // so FinancialService falls back to the coherent sample model.
    if (annual.length < 2) {
      throw new ProviderError('UNAVAILABLE', 'sec-edgar', `sparse XBRL for ${ticker}`);
    }

    // Quarterly anchored on revenue if present, else net income.
    const revQarr = quarterlyFlow(rev);
    const netQarr = quarterlyFlow(net);
    const anchor = revQarr.length ? revQarr : netQarr;
    const revQ = new Map(revQarr.map((q) => [q.end, q.val]));
    const opQ = new Map(quarterlyFlow(op).map((q) => [q.end, q.val]));
    const netQ = new Map(netQarr.map((q) => [q.end, q.val]));
    const quarterly: FinancialRow[] = anchor.slice(-4).map((q) => ({
      period: q.end.slice(0, 7),
      revenue: revQ.get(q.end) ?? 0,
      operatingIncome: opQ.get(q.end) ?? 0,
      netIncome: netQ.get(q.end) ?? 0,
      cash: instantAt(cash, q.end),
      debt: instantAt(liab, q.end),
    }));

    const latestYear = years[years.length - 1];
    return {
      annual,
      quarterly,
      latest: {
        equity: latestYear ? equityA.get(latestYear) ?? 0 : 0,
        liabilities: latestYear ? liabA.get(latestYear) ?? 0 : 0,
        netIncome: latestYear ? netA.get(latestYear) ?? 0 : 0,
        cash: latestYear ? cashA.get(latestYear) ?? 0 : 0,
      },
    };
  });
}

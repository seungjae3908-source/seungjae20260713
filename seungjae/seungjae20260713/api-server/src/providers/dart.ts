// DART provider (KR): Korean corporate disclosure system (전자공시). Detects
// dilution / going-concern risk from recent disclosure filings and surfaces
// recent disclosures as KR "news".
// Docs: https://opendart.fss.or.kr/
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { getDartKey } from '../lib/config';
import { ProviderError } from '../lib/errors';
import { fetchJson, fetchBuffer } from '../lib/http';
import { cached, TTL } from '../lib/cache';
import type { FinancialRow } from '../sample/types';
import type { FinancialsRaw } from './sec-edgar';

const BASE = 'https://opendart.fss.or.kr/api';

// DART's bulk corpCode.xml is ~3.5MB and its endpoint aggressively rate-limits
// repeated downloads (subsequent requests hang until they abort). The corp_code
// mapping is stable infrastructure (not market data), so we persist it to disk
// and reuse it, only re-downloading when the disk copy is old. On download
// failure we fall back to a stale disk copy so live disclosures keep working
// even while DART throttles the bulk endpoint. A single in-flight download is
// shared across concurrent callers (overview financials + disclosures + risk
// all resolve corp_code on a KR detail load).
const CORPMAP_DISK = path.join(os.tmpdir(), 'dart-corpmap.json');
const CORPMAP_DISK_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
// 실측 결과 DART 벌크 다운로드는 이 환경에서 3~4분까지 걸릴 수 있다.
const CORPMAP_DOWNLOAD_TIMEOUT = 270_000;
// 저장소에 함께 배포되는 사전 생성 매핑 (배포 직후 콜드스타트 대비).
const CORPMAP_BUNDLED = path.resolve(process.cwd(), 'data', 'dart-corpmap.json');

let corpMapMem: { map: Map<string, string>; expires: number } | null = null;
let corpMapInflight: Promise<Map<string, string>> | null = null;

async function loadCorpMapFromDisk(): Promise<{
  map: Map<string, string>;
  mtime: number;
} | null> {
  for (const file of [CORPMAP_DISK, CORPMAP_BUNDLED]) {
    try {
      const stat = await fs.stat(file);
      const raw = await fs.readFile(file, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, string>;
      const map = new Map(Object.entries(obj));
      if (map.size === 0) continue;
      return { map, mtime: stat.mtimeMs };
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function downloadCorpMap(): Promise<Map<string, string>> {
  const key = getDartKey();
  const buf = await fetchBuffer(`${BASE}/corpCode.xml?crtfc_key=${key}`, {
    provider: 'dart',
    timeoutMs: CORPMAP_DOWNLOAD_TIMEOUT,
  });
  let xml: string;
  try {
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith('.xml'));
    if (!entry) throw new Error('no xml in zip');
    xml = entry.getData().toString('utf-8');
  } catch {
    throw new ProviderError('UPSTREAM_ERROR', 'dart', 'corpCode parse failed');
  }
  const byStock = new Map<string, string>();
  const re = /<list>[\s\S]*?<corp_code>(\d+)<\/corp_code>[\s\S]*?<stock_code>\s*(\d{6})\s*<\/stock_code>[\s\S]*?<\/list>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    byStock.set(m[2], m[1]);
  }
  if (byStock.size === 0) {
    throw new ProviderError('UPSTREAM_ERROR', 'dart', 'empty corp map');
  }
  try {
    // Atomic write: write to a temp file then rename, so a crash mid-write
    // cannot truncate an existing (stale-fallback) cache file.
    const tmp = `${CORPMAP_DISK}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(byStock)), 'utf-8');
    await fs.rename(tmp, CORPMAP_DISK);
  } catch {
    // Disk cache is best-effort; a failed write must not break disclosures.
  }
  return byStock;
}

async function getCorpMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (corpMapMem && corpMapMem.expires > now) return corpMapMem.map;
  if (corpMapInflight) return corpMapInflight;

  corpMapInflight = (async () => {
    const disk = await loadCorpMapFromDisk();
    // Fresh disk copy — reuse without re-hitting the throttled bulk endpoint.
    if (disk && now - disk.mtime < CORPMAP_DISK_TTL) {
      corpMapMem = { map: disk.map, expires: now + TTL.mapping };
      return disk.map;
    }
    try {
      const map = await downloadCorpMap();
      corpMapMem = { map, expires: now + TTL.mapping };
      return map;
    } catch (err) {
      // Download failed (e.g. DART throttling the bulk endpoint). If we have any
      // disk copy — even stale — use it so disclosures stay live. corp_code
      // rarely changes, so a stale mapping is safe.
      if (disk) {
        corpMapMem = { map: disk.map, expires: now + 60 * 60 * 1000 };
        return disk.map;
      }
      throw err;
    }
  })().finally(() => {
    corpMapInflight = null;
  });

  return corpMapInflight;
}

// Map 6-digit KRX stock code -> 8-digit DART corp_code (disk-cached, resilient).
export async function getCorpCode(stockCode: string): Promise<string> {
  const map = await getCorpMap();
  const corp = map.get(stockCode);
  if (!corp) {
    throw new ProviderError('UNAVAILABLE', 'dart', `no corp_code for ${stockCode}`);
  }
  return corp;
}

export interface Disclosure {
  reportName: string;
  filer: string;
  date: string; // YYYYMMDD
  rceptNo: string;
  url: string; // real DART document viewer URL
}

interface DartListResponse {
  status: string;
  message: string;
  list?: {
    report_nm: string;
    flr_nm: string;
    rcept_dt: string;
    rcept_no: string;
  }[];
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Real DART electronic-disclosure document viewer URL for a receipt number.
export function dartDocUrl(rceptNo: string): string {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;
}

export async function getDisclosures(stockCode: string): Promise<Disclosure[]> {
  const key = getDartKey();
  const corp = await getCorpCode(stockCode);
  return cached(`dart:list:${corp}`, TTL.risk, async () => {
    const end = new Date();
    const begin = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const data = await fetchJson<DartListResponse>(
      `${BASE}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${ymd(
        begin,
      )}&end_de=${ymd(end)}&page_count=100`,
      { provider: 'dart' },
    );
    // status 013 = no data for the period.
    if (data.status === '013') return [];
    if (data.status !== '000') {
      if (data.status === '020') throw new ProviderError('RATE_LIMITED', 'dart');
      throw new ProviderError('UPSTREAM_ERROR', 'dart', data.message);
    }
    return (data.list ?? []).map((d) => ({
      reportName: d.report_nm,
      filer: d.flr_nm,
      date: d.rcept_dt,
      rceptNo: d.rcept_no,
      url: dartDocUrl(d.rcept_no),
    }));
  });
}

export interface DartRiskCounts {
  rightsOffering: number; // 유상증자
  cb: number; // 전환사채 (CB)
  bw: number; // 신주인수권부사채 (BW)
  managed: number; // 관리종목
  delisting: number; // 상장폐지
}

// --- Fundamentals (real annual/quarterly statements via fnlttSinglAcnt) -----

interface DartAcntRow {
  fs_div?: string;
  sj_div?: string;
  account_nm?: string;
  thstrm_amount?: string; // interim IS reports: current 3-month figure
  thstrm_add_amount?: string; // interim IS reports: cumulative (누적) figure
  frmtrm_amount?: string;
  bfefrmtrm_amount?: string;
}

interface DartAcntResponse {
  status: string;
  message: string;
  list?: DartAcntRow[];
}

// "-1,234" / "△1,234" / "(1,234)" -> -1234 ; "5,678" -> 5678.
function parseAmt(v?: string): number {
  if (!v) return 0;
  const neg = /[-△()]/.test(v);
  const n = Number(v.replace(/[^\d]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

function selectRows(list: DartAcntRow[]): DartAcntRow[] {
  const useCfs = list.some((r) => r.fs_div === 'CFS');
  return list.filter((r) => (useCfs ? r.fs_div === 'CFS' : r.fs_div === 'OFS'));
}

function pickAmt(
  rows: DartAcntRow[],
  names: string[],
  field:
    | 'thstrm_amount'
    | 'thstrm_add_amount'
    | 'frmtrm_amount'
    | 'bfefrmtrm_amount',
): number {
  const r = rows.find((x) =>
    names.includes((x.account_nm ?? '').replace(/\s/g, '')),
  );
  return parseAmt(r?.[field]);
}

const ACC = {
  revenue: ['매출액', '수익(매출액)', '영업수익', '매출'],
  operating: ['영업이익', '영업이익(손실)'],
  net: ['당기순이익', '당기순이익(손실)'],
  cash: ['현금및현금성자산'],
  liabilities: ['부채총계'],
  equity: ['자본총계'],
  capital: ['자본금'],
};

async function fetchAcnt(
  key: string,
  corp: string,
  year: number,
  reprt: string,
): Promise<DartAcntRow[] | null> {
  const data = await fetchJson<DartAcntResponse>(
    `${BASE}/fnlttSinglAcnt.json?crtfc_key=${key}&corp_code=${corp}&bsns_year=${year}&reprt_code=${reprt}`,
    { provider: 'dart' },
  );
  if (data.status === '000' && data.list && data.list.length) return data.list;
  if (data.status === '020') throw new ProviderError('RATE_LIMITED', 'dart');
  return null; // 013 = no data for the period
}

export async function getFinancials(stockCode: string): Promise<FinancialsRaw> {
  const key = getDartKey();
  const corp = await getCorpCode(stockCode);
  return cached(`dart:fin:${corp}`, TTL.financials, async () => {
    const now = new Date();
    // Latest fully-filed annual report: try last year, then the year before.
    let annualList: DartAcntRow[] | null = null;
    let baseYear = 0;
    for (const y of [now.getFullYear() - 1, now.getFullYear() - 2]) {
      annualList = await fetchAcnt(key, corp, y, '11011');
      if (annualList) {
        baseYear = y;
        break;
      }
    }
    if (!annualList) {
      throw new ProviderError('UNAVAILABLE', 'dart', `no financials for ${stockCode}`);
    }

    const annualRows = selectRows(annualList);
    const fields: Array<
      ['bfefrmtrm_amount' | 'frmtrm_amount' | 'thstrm_amount', number]
    > = [
      ['bfefrmtrm_amount', baseYear - 2],
      ['frmtrm_amount', baseYear - 1],
      ['thstrm_amount', baseYear],
    ];
    const annual: FinancialRow[] = fields
      .map(([field, year]) => {
        const row: FinancialRow = {
          period: String(year),
          revenue: pickAmt(annualRows, ACC.revenue, field),
          operatingIncome: pickAmt(annualRows, ACC.operating, field),
          netIncome: pickAmt(annualRows, ACC.net, field),
          cash: pickAmt(annualRows, ACC.cash, field),
          debt: pickAmt(annualRows, ACC.liabilities, field),
        };

        const eq = pickAmt(annualRows, ACC.equity, field);
        if (eq !== 0) row.equity = eq;

        const cap = pickAmt(annualRows, ACC.capital, field);
        if (cap !== 0) row.capital = cap;

        return row;
      })
      .filter((r, i) => i === fields.length - 1 || r.revenue !== 0 || r.netIncome !== 0);

    if (annual.length < 2) {
      throw new ProviderError('UNAVAILABLE', 'dart', `sparse financials for ${stockCode}`);
    }

    // Quarterly reconstruction.
    // In DART interim income statements, `thstrm_amount` is the CURRENT 3-month
    // figure and `thstrm_add_amount` is the cumulative (누적) figure:
    //   11013 = Q1 (thstrm = Q1), 11012 = 반기 (thstrm = Q2, add = 6M),
    //   11014 = 3분기 (thstrm = Q3, add = 9M), 11011 = annual (thstrm = 12M).
    // So Q1..Q3 come straight from `thstrm_amount`; Q4 = annual(12M) − 9M cum.
    // Balance-sheet items (cash/liabilities) are point-in-time `thstrm_amount`.
    let quarterly: FinancialRow[] = [];
    try {
      const [q1l, q2l, q3l] = await Promise.all([
        fetchAcnt(key, corp, baseYear, '11013'),
        fetchAcnt(key, corp, baseYear, '11012'),
        fetchAcnt(key, corp, baseYear, '11014'),
      ]);

      const quarterRow = (
        list: DartAcntRow[] | null,
        period: string,
      ): FinancialRow | null => {
        if (!list) return null;
        const rows = selectRows(list);
        return {
          period,
          revenue: pickAmt(rows, ACC.revenue, 'thstrm_amount'),
          operatingIncome: pickAmt(rows, ACC.operating, 'thstrm_amount'),
          netIncome: pickAmt(rows, ACC.net, 'thstrm_amount'),
          cash: pickAmt(rows, ACC.cash, 'thstrm_amount'),
          debt: pickAmt(rows, ACC.liabilities, 'thstrm_amount'),
        };
      };

      const built: (FinancialRow | null)[] = [
        quarterRow(q1l, `${baseYear}Q1`),
        quarterRow(q2l, `${baseYear}Q2`),
        quarterRow(q3l, `${baseYear}Q3`),
      ];

      // Q4 = annual (12M) − 9M cumulative (from the 3분기 report's 누적 column).
      if (q3l) {
        const q3rows = selectRows(q3l);
        const cum9Rev = pickAmt(q3rows, ACC.revenue, 'thstrm_add_amount');
        if (cum9Rev > 0) {
          built.push({
            period: `${baseYear}Q4`,
            revenue: pickAmt(annualRows, ACC.revenue, 'thstrm_amount') - cum9Rev,
            operatingIncome:
              pickAmt(annualRows, ACC.operating, 'thstrm_amount') -
              pickAmt(q3rows, ACC.operating, 'thstrm_add_amount'),
            netIncome:
              pickAmt(annualRows, ACC.net, 'thstrm_amount') -
              pickAmt(q3rows, ACC.net, 'thstrm_add_amount'),
            cash: pickAmt(annualRows, ACC.cash, 'thstrm_amount'),
            debt: pickAmt(annualRows, ACC.liabilities, 'thstrm_amount'),
          });
        }
      }

      quarterly = built.filter((r): r is FinancialRow => r !== null);
      // Coherence guard: negative revenue means the report layout didn't match
      // the standard 3-month/누적 convention — drop quarterly so the service
      // falls back to a coherent sample view instead of showing garbage.
      if (quarterly.some((q) => q.revenue < 0)) quarterly = [];
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'RATE_LIMITED') throw err;
      quarterly = [];
    }

    return {
      annual,
      quarterly,
      latest: {
        equity: pickAmt(annualRows, ACC.equity, 'thstrm_amount'),
        liabilities: pickAmt(annualRows, ACC.liabilities, 'thstrm_amount'),
        netIncome: pickAmt(annualRows, ACC.net, 'thstrm_amount'),
        cash: pickAmt(annualRows, ACC.cash, 'thstrm_amount'),
      },
    };
  });
}

export function classifyRisk(disclosures: Disclosure[]): DartRiskCounts {
  const counts: DartRiskCounts = {
    rightsOffering: 0,
    cb: 0,
    bw: 0,
    managed: 0,
    delisting: 0,
  };
  for (const d of disclosures) {
    const n = d.reportName;
    if (n.includes('유상증자')) counts.rightsOffering++;
    if (n.includes('전환사채')) counts.cb++;
    if (n.includes('신주인수권부사채')) counts.bw++;
    if (n.includes('관리종목')) counts.managed++;
    if (n.includes('상장폐지')) counts.delisting++;
  }
  return counts;
}

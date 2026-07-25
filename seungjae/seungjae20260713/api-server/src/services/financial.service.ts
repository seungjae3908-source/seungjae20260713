// FinancialService — quarterly/annual statements, ratios, growth, cash burn.
// Live-first: US statements from SEC XBRL + ratios from Finnhub; KR statements
// from DART + ratios from Naver. Falls back to the deterministic sample model
// only when a live source is unavailable, so the tab always renders coherently.
import { getFinancials as getSampleFinancials } from '../sample/financials';
import { getCatalogEntry, type CatalogEntry } from '../data/catalog';
import * as sec from '../providers/sec-edgar';
import * as dart from '../providers/dart';
import * as finnhub from '../providers/finnhub';
import * as naver from '../providers/naver';
import type { FinancialsRaw } from '../providers/sec-edgar';
import type {
  Financials,
  FinancialRatios,
  FinancialRow,
  HealthLevel,
} from '../sample/types';

function yoy(
  rows: FinancialRow[],
  key: 'revenue' | 'netIncome',
): number[] {
  const out: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1][key];
    const cur = rows[i][key];
    out.push(prev ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : 0);
  }
  return out;
}

function buildCashBurn(raw: FinancialsRaw) {
  const cashBalance = raw.latest.cash;
  const q = raw.quarterly;
  const quarterlyBurn = q.length
    ? q[q.length - 1].netIncome
    : Math.round(raw.latest.netIncome / 4);
  const survivalQuarters =
    quarterlyBurn >= 0
      ? null
      : Math.max(0, Math.round(cashBalance / Math.abs(quarterlyBurn)));
  return { cashBalance, quarterlyBurn, survivalQuarters };
}

function buildHealth(r: FinancialRatios): {
  level: HealthLevel;
  confidence: number;
} {
  let score = 50;
  if (r.roe >= 15) score += 20;
  else if (r.roe >= 5) score += 8;
  else if (r.roe < 0) score -= 20;

  if (r.debtRatio <= 80) score += 15;
  else if (r.debtRatio > 200) score -= 15;

  if (r.per > 0 && r.per < 30) score += 5;

  const confidence = Math.max(10, Math.min(95, score));
  const level: HealthLevel =
    confidence >= 66 ? 'STRONG' : confidence >= 40 ? 'AVERAGE' : 'WEAK';
  return { level, confidence };
}

function assemble(raw: FinancialsRaw, ratios: FinancialRatios): Financials {
  return {
    source: 'live',
    quarterly: raw.quarterly,
    annual: raw.annual,
    ratios,
    growth: {
      revenue: yoy(raw.annual, 'revenue'),
      profit: yoy(raw.annual, 'netIncome'),
    },
    cashBurn: buildCashBurn(raw),
    health: buildHealth(ratios),
  };
}

async function getLive(entry: CatalogEntry): Promise<Financials> {
  if (entry.market === 'KR') {
    const [raw, kr] = await Promise.all([
      dart.getFinancials(entry.ticker),
      naver.getRatios(entry).catch(() => ({ eps: 0, per: 0, pbr: 0, bps: 0 })),
    ]);
    if (raw.quarterly.length === 0) {
      // Incomplete live data — fall back to a coherent full sample view.
      throw new Error('no live KR quarterly statements');
    }
    const equity = raw.latest.equity;
    const ratios: FinancialRatios = {
      eps: kr.eps,
      per: kr.per,
      pbr: kr.pbr,
      roe: equity
        ? Math.round((raw.latest.netIncome / equity) * 1000) / 10
        : 0,
      debtRatio: equity
        ? Math.round((raw.latest.liabilities / equity) * 1000) / 10
        : 0,
    };
    return assemble(raw, ratios);
  }

  const [raw, us] = await Promise.all([
    sec.getFinancials(entry.ticker),
    finnhub
      .getRatios(entry)
      .catch(() => ({ eps: 0, per: 0, pbr: 0, roe: 0, debtRatio: 0 })),
  ]);

  const equity = raw.latest.equity;

  // Fill missing ROE / debtRatio from the real SEC balance sheet when the
  // ratios provider didn't supply them (don't fabricate — only compute from
  // authentic equity/liabilities/netIncome).
  const ratios: FinancialRatios = {
    ...us,
    roe:
      us.roe || !equity
        ? us.roe
        : Math.round((raw.latest.netIncome / equity) * 1000) / 10,
    debtRatio:
      us.debtRatio || !equity
        ? us.debtRatio
        : Math.round((raw.latest.liabilities / equity) * 1000) / 10,
  };

  return assemble(raw, ratios);
}

async function getFinancials(ticker: string): Promise<Financials | null> {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  try {
    return await getLive(entry);
  } catch (err) {
    console.error(`live financials failed for ${ticker}:`, err);
    const sample = getSampleFinancials(ticker);
    // 추천 엔진 등이 실데이터와 구분할 수 있도록 출처를 명시한다.
    return sample ? { ...sample, source: 'sample' as const } : sample;
  }
}

export const FinancialService = {
  getFinancials,
};

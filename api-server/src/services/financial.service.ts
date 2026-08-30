// FinancialService — quarterly/annual statements, ratios, growth, cash burn.
// US statements from SEC XBRL + ratios from Finnhub; KR statements from DART
// + ratios from Naver. Provider failures propagate as missing evidence; sample
// financials must never enter runtime grading, recommendations or AI context.
import { getCatalogEntry, type CatalogEntry } from '../data/catalog';
import * as sec from '../providers/sec-edgar';
import * as dart from '../providers/dart';
import * as finnhub from '../providers/finnhub';
import * as naver from '../providers/naver';
import type { FinancialsRaw } from '../providers/sec-edgar';
import { ProviderError } from '../lib/errors';
import { requireFinancialNumber } from '../providers/financial-evidence';
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
    if (prev === 0) {
      throw new ProviderError('UNAVAILABLE', 'financials', `UNDEFINED_GROWTH:${key}`);
    }
    out.push(requireFinancialNumber(Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10, 'financials', key));
  }
  return out;
}

function buildCashBurn(raw: FinancialsRaw) {
  const cashBalance = raw.latest.cash;
  const q = raw.quarterly;
  const quarterlyBurn = requireFinancialNumber(q.at(-1)?.netIncome, 'financials', 'quarterlyNetIncome');
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
      naver.getRatios(entry),
    ]);
    if (raw.quarterly.length === 0) {
      // Incomplete live data cannot establish financial evidence.
      throw new Error('no live KR quarterly statements');
    }
    const equity = requireFinancialNumber(raw.latest.equity, 'dart', 'equity');
    if (equity <= 0) {
      throw new ProviderError('UNAVAILABLE', 'dart', 'FINANCIAL_HEALTH_REQUIRES_POSITIVE_EQUITY');
    }
    const ratios: FinancialRatios = {
      eps: kr.eps,
      per: kr.per,
      pbr: kr.pbr,
      roe: Math.round((raw.latest.netIncome / equity) * 1000) / 10,
      debtRatio: Math.round((raw.latest.liabilities / equity) * 1000) / 10,
    };
    return assemble(raw, ratios);
  }

  const [raw, us] = await Promise.all([
    sec.getFinancials(entry.ticker),
    finnhub.getRatios(entry),
  ]);

  // Preserve measured zeroes; a ratio-provider failure cannot be replaced by
  // zeroes or ratios from a different reporting period.
  return assemble(raw, us);
}

async function getFinancials(ticker: string): Promise<Financials | null> {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  return getLive(entry);
}

export const FinancialService = {
  getFinancials,
};

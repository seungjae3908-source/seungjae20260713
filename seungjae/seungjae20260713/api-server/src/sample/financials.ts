// Financial statement sample generator derived from the ticker's market cap +
// quality seed, producing self-consistent quarterly/annual statements, ratios,
// growth series and a cash-burn analysis.
import { getCatalogEntry } from '../data/catalog';
import { seeded, rangeFloat, qualityScore, ANCHOR_MS } from './rng';
import { getQuote, shares } from './market';
import type { Financials, FinancialRow, HealthLevel } from './types';

function r0(n: number): number {
  return Math.round(n);
}

export function getFinancials(ticker: string): Financials | null {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  const quote = getQuote(ticker);
  if (!quote) return null;

  const q = qualityScore(entry.ticker); // 0..100
  const rng = seeded(entry.ticker, 'fin');
  const marketCap = quote.marketCap;

  const ps = rangeFloat(rng, 1.5, 8); // price/sales
  const latestRevenue = marketCap / ps;
  const opMargin = (q / 100) * 0.28 - 0.05 + rangeFloat(rng, -0.04, 0.06);
  const netMargin = opMargin - rangeFloat(rng, 0.005, 0.05);
  const yoyGrowth = ((q - 45) / 100) * 0.4 + rangeFloat(rng, -0.06, 0.08);

  // Annual (last 5 years, oldest -> newest), revenue grows to latestRevenue.
  const thisYear = new Date(ANCHOR_MS).getUTCFullYear();
  const annual: FinancialRow[] = [];
  for (let i = 4; i >= 0; i--) {
    const rev = latestRevenue / Math.pow(1 + yoyGrowth, i);
    const cash = rev * rangeFloat(rng, 0.15, 0.6);
    const debt = rev * rangeFloat(rng, 0.1, 0.9);
    annual.push({
      period: `${thisYear - i}`,
      revenue: r0(rev),
      operatingIncome: r0(rev * opMargin),
      netIncome: r0(rev * netMargin),
      cash: r0(cash),
      debt: r0(debt),
    });
  }

  // Quarterly (last 4), roughly a quarter of the latest annual with seasonality.
  const latest = annual[annual.length - 1];
  const quarterly: FinancialRow[] = [];
  const qLabels = ['1Q', '2Q', '3Q', '4Q'];
  for (let i = 0; i < 4; i++) {
    const season = 1 + (rng() - 0.5) * 0.2;
    const rev = (latest.revenue / 4) * season;
    quarterly.push({
      period: `${thisYear} ${qLabels[i]}`,
      revenue: r0(rev),
      operatingIncome: r0(rev * opMargin * season),
      netIncome: r0(rev * netMargin * season),
      cash: r0(latest.cash * (0.85 + i * 0.05)),
      debt: r0(latest.debt * (1.05 - i * 0.02)),
    });
  }

  // Ratios
  const equity = latestRevenue * rangeFloat(rng, 0.5, 1.4);
  const netIncome = latest.netIncome;
  const eps = netIncome / shares(entry);
  const per = eps > 0 ? Math.round((quote.price / eps) * 10) / 10 : 0;
  const pbr = Math.round((marketCap / equity) * 100) / 100;
  const roe = Math.round((netIncome / equity) * 1000) / 10; // %
  const debtRatio = Math.round((latest.debt / equity) * 1000) / 10; // %

  // Growth series (YoY %), 4 points
  const revenueGrowth: number[] = [];
  const profitGrowth: number[] = [];
  for (let i = 1; i < annual.length; i++) {
    revenueGrowth.push(
      Math.round(((annual[i].revenue - annual[i - 1].revenue) / Math.abs(annual[i - 1].revenue)) * 1000) / 10,
    );
    const prev = annual[i - 1].netIncome;
    profitGrowth.push(
      prev !== 0 ? Math.round(((annual[i].netIncome - prev) / Math.abs(prev)) * 1000) / 10 : 0,
    );
  }

  // Cash burn
  const quarterlyNet = quarterly[quarterly.length - 1].netIncome;
  const quarterlyBurn = r0(quarterlyNet); // negative => burning
  const cashBalance = quarterly[quarterly.length - 1].cash;
  const survivalQuarters =
    quarterlyBurn < 0 ? Math.max(1, Math.round(cashBalance / Math.abs(quarterlyBurn))) : null;

  // Health rating
  let healthScore = 50;
  if (netMargin > 0) healthScore += 15;
  else healthScore -= 20;
  if (yoyGrowth > 0.08) healthScore += 12;
  else if (yoyGrowth < 0) healthScore -= 10;
  if (debtRatio < 80) healthScore += 8;
  else healthScore -= 8;
  if (survivalQuarters !== null) healthScore -= 10;
  healthScore = Math.max(0, Math.min(100, healthScore));
  const level: HealthLevel = healthScore >= 66 ? 'STRONG' : healthScore >= 40 ? 'AVERAGE' : 'WEAK';
  const confidence = Math.round(60 + (Math.abs(healthScore - 50) / 50) * 35);

  return {
    quarterly,
    annual,
    ratios: { eps: Math.round(eps * 100) / 100, per, pbr, roe, debtRatio },
    growth: { revenue: revenueGrowth, profit: profitGrowth },
    cashBurn: { cashBalance, quarterlyBurn, survivalQuarters },
    health: { level, confidence },
  };
}

// Fundamental score 0-100 for the overall investment rating.
export function fundamentalScore(ticker: string): number {
  const fin = getFinancials(ticker);
  if (!fin) return 50;
  let s = 50;
  if (fin.ratios.roe > 12) s += 10;
  else if (fin.ratios.roe < 0) s -= 12;
  const avgRevGrowth = fin.growth.revenue.reduce((a, b) => a + b, 0) / (fin.growth.revenue.length || 1);
  if (avgRevGrowth > 10) s += 12;
  else if (avgRevGrowth < 0) s -= 10;
  if (fin.ratios.debtRatio > 120) s -= 10;
  if (fin.cashBurn.survivalQuarters !== null) s -= 12;
  if (fin.health.level === 'STRONG') s += 10;
  else if (fin.health.level === 'WEAK') s -= 10;
  return Math.max(0, Math.min(100, Math.round(s)));
}

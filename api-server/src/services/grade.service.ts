// Canonical, full-fidelity stock grade (등급). Computed ONCE per ticker on the
// backend so the detail page and every list/search screen show the same label.
//
// Inputs: marketCap + AI score + live financials + STRUCTURED, recency-aware
// risk events. Raw news/disclosure titles are intentionally NOT fed in — that
// keyword path is what made healthy stocks false-flip to 잡주 on the detail
// screen. Cached per ticker (risk TTL) to keep repeat views cheap.
import { cached, TTL } from '../lib/cache';
import { getCatalogEntry } from '../data/catalog';
import { MarketDataService } from './market-data.service';
import { FinancialService } from './financial.service';
import { RiskAnalysisService } from './risk-analysis.service';
import { computeScores } from '../sample/scores';
import { classifyStock, toStockGrade, type StockGrade } from '@workspace/stock-grade';

export type { StockGrade };

export const GradeService = {
  async getGrade(ticker: string): Promise<StockGrade | null> {
    const t = ticker.toUpperCase();
    const entry = getCatalogEntry(t);
    if (!entry) return null;

    const quote = await MarketDataService.getQuote(t);
    if (!quote) return null;

    return cached(`grade:v1:${t}`, TTL.risk, async () => {
      const { overall } = computeScores(t);

      let fin: Awaited<ReturnType<typeof FinancialService.getFinancials>> = null;
      try {
        fin = await FinancialService.getFinancials(t);
      } catch {
        fin = null;
      }

      let risk: Awaited<ReturnType<typeof RiskAnalysisService.getRisk>> = null;
      try {
        risk = await RiskAnalysisService.getRisk(t);
      } catch {
        risk = null;
      }

      const annual = fin?.annual ?? [];
      const latest = annual.length ? annual[annual.length - 1] : null;
      const revenue = fin?.growth?.revenue ?? [];
      const revenueGrowth = revenue.length ? revenue[revenue.length - 1] : null;

      return toStockGrade(
        classifyStock({
          ticker: t,
          name: entry.name,
          aiScore: overall,
          changePercent: quote.changePercent,
          marketCap: quote.marketCap,
          currency: entry.currency,
          market: entry.market,
          per: fin?.ratios?.per ?? null,
          pbr: fin?.ratios?.pbr ?? null,
          roe: fin?.ratios?.roe ?? null,
          debtRatio: fin?.ratios?.debtRatio ?? null,
          revenueGrowth,
          operatingIncome: latest?.operatingIncome ?? null,
          netIncome: latest?.netIncome ?? null,
          equity: latest?.equity ?? null,
          debt: latest?.debt ?? null,
          riskFactors: (risk?.events ?? []).map((event) => ({
            label: event.label || event.title,
            detail: event.summary,
            level: event.level,
          })),
        }),
      );
    });
  },
};

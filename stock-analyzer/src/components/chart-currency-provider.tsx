import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AnalysisMarket } from '@/lib/analysis-selection';
import { formatChartMoney, nativeChartCurrency, usableChartFx, type ChartDisplayCurrency, type ChartFxSnapshot } from '@/lib/chart-currency';

const EMPTY_QUOTES: ChartFxSnapshot['quotes'] = [];
const CurrencyContext = createContext<{ format: (value: number | null | undefined, market: AnalysisMarket) => string; display: ChartDisplayCurrency; inputRate: number }>({ format: formatChartMoney, display: 'USD', inputRate: 1 });
export const useChartCurrency = () => useContext(CurrencyContext);

export function ChartCurrencyProvider({ market, children }: { market: AnalysisMarket; children: ReactNode }) {
  const [display, setDisplay] = useState<ChartDisplayCurrency>(() => {
    try { return localStorage.getItem('ai-chart-display-currency') === 'KRW' ? 'KRW' : 'USD'; } catch { return 'USD'; }
  });
  const foreign = market === 'US' || market === 'BITGET';
  // The current server does not expose /api/market/fx. Avoid a phantom
  // request, missing-provider console errors or unsourced KRW conversion.
  // Re-enable only after a separate reviewed read-only server contract exists.
  const quotes = EMPTY_QUOTES;
  const quote = usableChartFx(quotes.find(row => row.currency === nativeChartCurrency(market)));
  const effectiveDisplay = foreign && display === 'KRW' && !quote ? 'USD' : display;
  const format = useCallback((value: number | null | undefined, sourceMarket: AnalysisMarket) => formatChartMoney(value, sourceMarket, effectiveDisplay, quotes), [effectiveDisplay, quotes]);
  const inputRate = foreign && effectiveDisplay === 'KRW' && quote ? quote.krwRate : 1;
  const context = useMemo(() => ({ format, display: effectiveDisplay, inputRate }), [format, effectiveDisplay, inputRate]);
  const choose = (value: ChartDisplayCurrency) => {
    setDisplay(value);
    try { localStorage.setItem('ai-chart-display-currency', value); } catch { /* Display preferences are optional. */ }
  };
  return <CurrencyContext.Provider value={context}><div className="flex h-full min-h-0 min-w-0 flex-col">
    {foreign && <div data-testid="chart-currency-switch" className="flex flex-wrap items-center justify-end gap-2 px-3 py-2 text-xs">
      <div role="group" aria-label="표시 통화" className="flex rounded-xl border border-card-border bg-card p-1">
        {(['USD', 'KRW'] as const).map(value => <button key={value} type="button" disabled={value === 'KRW' && !quote} aria-pressed={effectiveDisplay === value} onClick={() => choose(value)} className={`min-h-9 rounded-lg px-3 font-bold disabled:opacity-40 ${effectiveDisplay === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{value === 'KRW' ? '원화' : market === 'BITGET' ? 'USDT' : '달러'}</button>)}
      </div>
      <span data-testid="chart-fx-basis" className="text-muted-foreground">{quote ? `1 ${quote.currency} = ${quote.krwRate.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원 · ${new Date(quote.asOf).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 기준${Date.now() - Date.parse(quote.asOf) > 300_000 ? ' · 지연' : ''}` : '원화 환산 미지원 · 원본 통화 표시'}</span>
    </div>}
    <div className="min-h-0 flex-1">{children}</div>
    </div>
  </CurrencyContext.Provider>;
}

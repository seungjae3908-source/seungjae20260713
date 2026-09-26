import { useState } from 'react';
import { AiTab } from '@/components/tabs/ai-tab';
import { DisclosureTab } from '@/components/tabs/disclosure-tab';
import { FinancialTab } from '@/components/tabs/financial-tab';
import { ResponsiveTabs } from '@/components/responsive-tabs';

type Market = 'KR' | 'US';
type AnalysisTab = 'ai' | 'financials' | 'filings';

const ANALYSIS_TABS = [
  { value: 'ai', label: 'AI분석' },
  { value: 'financials', label: '재무제표' },
  { value: 'filings', label: '공시' },
] as const;

export function StockDetailAnalysisPanel({ ticker, market }: { ticker: string; market: Market }) {
  const [tab, setTab] = useState<AnalysisTab>('ai');
  const currency = market === 'US' ? 'USD' : 'KRW';

  return (
    <section className="min-h-0 min-w-0" data-testid="stock-detail-analysis-panel">
      <div className="mb-3">
        <ResponsiveTabs
          value={tab}
          options={ANALYSIS_TABS}
          onChange={setTab}
          ariaLabel="상세분석 하위 탭"
          testId="stock-detail-analysis-tabs"
          compact
        />
      </div>

      <div className="min-h-0 min-w-0" data-testid={`stock-detail-analysis-${tab}`}>
        {tab === 'ai' ? <AiTab ticker={ticker} currency={currency} active /> : null}
        {tab === 'financials' ? <FinancialTab ticker={ticker} currency={currency} active /> : null}
        {tab === 'filings' ? <DisclosureTab ticker={ticker} active /> : null}
      </div>
    </section>
  );
}

export default StockDetailAnalysisPanel;

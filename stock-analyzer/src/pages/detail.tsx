import { useMemo, useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  BarChart3,
  ExternalLink,
  FileText,
  Newspaper,
  Star,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { buildAiInsights } from '@/lib/ai-insights';
import {
  displayStockName,
  eventLabelKo,
  isInWatchlist,
  toggleWatchlistItem,
  formatAppPercent,
  formatAppPrice,
  summarizeText,
  translateMarketText,
} from '@/lib/stock-display';
import { stockClassBadgeClass } from '@/lib/stock-classifier';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

type DetailTab = 'overview' | 'ai' | 'chart' | 'financials' | 'filings' | 'news';

interface DetailData {
  ticker: string;
  quote: AnyObj | null;
  company: AnyObj | null;
  candles: AnyObj[];
  financials: AnyObj | null;
  filings: AnyObj[];
  news: AnyObj[];
}

const TABS: { key: DetailTab; label: string }[] = [
  { key: 'overview', label: '기업개요' },
  { key: 'ai', label: 'AI분석' },
  { key: 'chart', label: '차트' },
  { key: 'financials', label: '재무제표' },
  { key: 'filings', label: '공시' },
  { key: 'news', label: '뉴스' },
];

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').replace(/%/g, ''));

    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function isKrTicker(ticker: string) {
  return /^\d/.test(ticker);
}

function marketOf(ticker: string, quote?: AnyObj | null, company?: AnyObj | null): 'KR' | 'US' {
  if (quote?.market === 'US' || company?.market === 'US') return 'US';
  if (quote?.market === 'KR' || company?.market === 'KR') return 'KR';

  return isKrTicker(ticker) ? 'KR' : 'US';
}

function currencyOf(market: 'KR' | 'US', quote?: AnyObj | null): 'KRW' | 'USD' {
  if (quote?.currency === 'USD') return 'USD';
  if (quote?.currency === 'KRW') return 'KRW';

  return market === 'US' ? 'USD' : 'KRW';
}

async function tryJson<T>(urls: string[], fallback: T): Promise<T> {
  for (const url of urls) {
    try {
      const res = await fetch(url);

      if (!res.ok) continue;

      return (await res.json()) as T;
    } catch {
      // keep trying
    }
  }

  return fallback;
}

function normalizeQuoteResponse(ticker: string, data: AnyObj): AnyObj | null {
  if (Array.isArray(data?.quotes)) {
    return data.quotes.find(
      (item: AnyObj) => String(item.ticker ?? '').toUpperCase() === ticker,
    ) ?? data.quotes[0] ?? null;
  }

  if (data?.quote) return data.quote;
  if (data?.ticker || data?.price) return data;

  return null;
}

function collectNews(data: AnyObj): AnyObj[] {
  const merged = [
    ...(Array.isArray(data?.news) ? data.news : []),
    ...(Array.isArray(data?.positive) ? data.positive : []),
    ...(Array.isArray(data?.negative) ? data.negative : []),
    ...(Array.isArray(data?.items) ? data.items : []),
  ];

  const seen = new Set<string>();

  return merged.filter((item) => {
    const key = `${item.url ?? ''}:${item.title ?? ''}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function collectFilings(data: AnyObj): AnyObj[] {
  const merged = [
    ...(Array.isArray(data?.filings) ? data.filings : []),
    ...(Array.isArray(data?.disclosures) ? data.disclosures : []),
    ...(Array.isArray(data?.items) ? data.items : []),
  ];

  const seen = new Set<string>();

  return merged.filter((item) => {
    const key = `${item.url ?? ''}:${item.title ?? item.report ?? item.form ?? ''}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

async function fetchDetail(ticker: string): Promise<DetailData> {
  const upper = ticker.toUpperCase();

  const [quoteRaw, companyRaw, candlesRaw, financialRaw, riskRaw, filingsRaw, newsRaw] =
    await Promise.all([
      tryJson<AnyObj>([`/api/quotes?tickers=${upper}`, `/api/stocks/${upper}/quote`], {}),
      tryJson<AnyObj>(
        [`/api/stocks/${upper}/company`, `/api/stocks/${upper}/profile`],
        {},
      ),
      tryJson<AnyObj>(
        [
          `/api/stocks/${upper}/candles?tf=1D`,
          `/api/stocks/${upper}/candles?timeframe=1D`,
          `/api/candles?ticker=${upper}&tf=1D`,
        ],
        {},
      ),
      tryJson<AnyObj>([`/api/stocks/${upper}/financials`], {}),
      tryJson<AnyObj>([`/api/stocks/${upper}/risk`], {}),
      tryJson<AnyObj>(
        [`/api/stocks/${upper}/filings`, `/api/stocks/${upper}/disclosures`],
        {},
      ),
      tryJson<AnyObj>([`/api/stocks/${upper}/news`], {}),
    ]);

  const quote = normalizeQuoteResponse(upper, quoteRaw);
  const company = companyRaw.company ?? companyRaw.profile ?? companyRaw ?? null;
  const candles = Array.isArray(candlesRaw.candles)
    ? candlesRaw.candles
    : Array.isArray(candlesRaw)
      ? candlesRaw
      : [];

  const financials =
    financialRaw.financials ??
    financialRaw.data ??
    (Object.keys(financialRaw).length ? financialRaw : null);

  const filings = [...collectFilings(riskRaw), ...collectFilings(filingsRaw)];
  const news = collectNews(newsRaw);

  return {
    ticker: upper,
    quote,
    company,
    candles,
    financials,
    filings,
    news,
  };
}

function currentBackPath() {
  const raw = new URLSearchParams(window.location.search).get('back');

  if (!raw) return '/search';

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sortByPeriodDesc(rows: AnyObj[]) {
  return [...rows].sort((a, b) => {
    const av = String(a.period ?? a.date ?? a.year ?? '');
    const bv = String(b.period ?? b.date ?? b.year ?? '');

    return bv.localeCompare(av);
  });
}

function financialRows(financials: AnyObj | null, key: 'quarterly' | 'annual') {
  const rows = Array.isArray(financials?.[key])
    ? financials?.[key]
    : Array.isArray(financials?.rows)
      ? financials?.rows
      : [];

  return sortByPeriodDesc(rows);
}

function formatMoney(value: unknown, currency: 'KRW' | 'USD') {
  const n = toNumber(value);

  if (n == null) return '확인 필요';

  if (currency === 'USD') {
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }

  return `${Math.round(n).toLocaleString()}원`;
}

function ratioDesc(label: string, value: unknown) {
  const n = toNumber(value);

  if (n == null) return '확인 필요';

  if (label === 'PER') {
    if (n <= 0) return `${n.toFixed(1)}배 (적자/산정불가)`;
    if (n <= 10) return `${n.toFixed(1)}배 (낮은 편)`;
    if (n <= 25) return `${n.toFixed(1)}배 (보통)`;
    if (n <= 40) return `${n.toFixed(1)}배 (높은 편)`;

    return `${n.toFixed(1)}배 (매우 높은 편)`;
  }

  if (label === 'PBR') {
    if (n <= 0) return `${n.toFixed(2)}배 (산정불가)`;
    if (n <= 1) return `${n.toFixed(2)}배 (낮은 편)`;
    if (n <= 3) return `${n.toFixed(2)}배 (보통)`;
    if (n <= 7) return `${n.toFixed(2)}배 (높은 편)`;

    return `${n.toFixed(2)}배 (매우 높은 편)`;
  }

  if (label === 'ROE') {
    if (n < 0) return `${n.toFixed(1)}% (부진)`;
    if (n < 5) return `${n.toFixed(1)}% (낮음)`;
    if (n < 15) return `${n.toFixed(1)}% (보통)`;

    return `${n.toFixed(1)}% (우수)`;
  }

  if (label === '부채비율') {
    if (n <= 100) return `${n.toFixed(1)}% (안정적)`;
    if (n <= 200) return `${n.toFixed(1)}% (보통)`;

    return `${n.toFixed(1)}% (높음)`;
  }

  return String(n);
}

export default function DetailPage() {
  const [, params] = useRoute('/stock/:ticker') as [
    boolean,
    { ticker?: string } | null,
  ];
  const [, navigate] = useLocation();
  const ticker = String(params?.ticker ?? '').toUpperCase();

  const [tab, setTab] = useState<DetailTab>('overview');
  const [watched, setWatched] = useState(() => isInWatchlist(ticker));

  const detail = useQuery({
    queryKey: ['stock-detail', ticker],
    queryFn: () => fetchDetail(ticker),
    enabled: Boolean(ticker),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const data = detail.data;

  const market = marketOf(ticker, data?.quote, data?.company);
  const currency = currencyOf(market, data?.quote);
  const rawName = String(
    data?.company?.name ??
      data?.quote?.name ??
      data?.company?.companyName ??
      ticker,
  );
  const companyName = displayStockName(ticker, rawName, market);

  const insights = useMemo(() => {
    return buildAiInsights({
      ticker,
      name: companyName,
      market,
      currency,
      quote: data?.quote,
      financials: data?.financials,
      risk: null,
      news: data?.news ?? [],
      filings: data?.filings ?? [],
      candles: data?.candles ?? [],
    });
  }, [ticker, companyName, market, currency, data]);

  const positive = (toNumber(data?.quote?.changePercent) ?? 0) >= 0;

  const handleBack = () => {
    navigate(currentBackPath());
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-card-border bg-background/95 px-4 pb-3 pt-5 glass">
        <div className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-start gap-3">
          <button
            type="button"
            onClick={handleBack}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <div className="min-w-0">
            <h1 className="truncate text-2xl font-extrabold">{companyName}</h1>

            <p className="mt-1 text-sm font-bold text-muted-foreground">
              {market === 'US' ? `티커 ${ticker}` : ticker}
            </p>
          </div>

          <div className="text-right">
            <span
              className={cn(
                'inline-flex rounded-full border px-3 py-1 text-sm font-extrabold',
                stockClassBadgeClass(insights.classification.label),
              )}
            >
              {insights.classification.label}
            </span>

            <p
              className={cn(
                'mt-1 text-xs font-extrabold',
                insights.classification.delistingWarning
                  ? 'text-destructive'
                  : insights.classification.label === '우량주'
                    ? 'text-positive'
                    : 'text-muted-foreground',
              )}
            >
              {insights.classification.riskCaption}
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-[1fr_1fr_56px] gap-2 rounded-3xl border border-card-border bg-card p-3">
          <InfoMini label="현재가" value={formatAppPrice(data?.quote?.price, currency)} />

          <InfoMini
            label="등락률"
            value={formatAppPercent(data?.quote?.changePercent)}
            positive={positive}
          />

          <button
            type="button"
            onClick={() =>
              setWatched(
                toggleWatchlistItem({
                  ticker,
                  name: companyName,
                  market,
                  currency,
                }),
              )
            }
            className="flex items-center justify-center rounded-2xl bg-secondary text-muted-foreground"
          >
            <Star
              className={cn('h-6 w-6', watched && 'text-yellow-400')}
              fill={watched ? 'currentColor' : 'none'}
            />
          </button>
        </div>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn(
                'shrink-0 rounded-2xl border px-4 py-2.5 text-sm font-extrabold',
                tab === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-card text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-4">
        {detail.isLoading && (
          <section className="rounded-3xl border border-card-border bg-card p-8 text-center">
            <p className="text-sm font-bold text-muted-foreground">
              종목 데이터를 불러오는 중...
            </p>
          </section>
        )}

        {detail.isError && (
          <section className="rounded-3xl border border-card-border bg-card p-8 text-center">
            <p className="break-keep text-sm font-bold text-destructive">
              종목 데이터를 불러오지 못했습니다.
            </p>
          </section>
        )}

        {data && (
          <>
            {tab === 'overview' && (
              <OverviewTab
                name={companyName}
                ticker={ticker}
                market={market}
                company={data.company}
                insights={insights}
              />
            )}

            {tab === 'ai' && (
              <AiTab insights={insights} />
            )}

            {tab === 'chart' && (
              <ChartTab candles={data.candles} insights={insights} />
            )}

            {tab === 'financials' && (
              <FinancialTab financials={data.financials} currency={currency} />
            )}

            {tab === 'filings' && (
              <FilingTab filings={data.filings} summary={insights.disclosureAiSummary} />
            )}

            {tab === 'news' && (
              <NewsTab news={data.news} summary={insights.newsAiSummary} />
            )}
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function InfoMini({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-2xl bg-secondary/70 p-3 text-center">
      <p className="text-xs font-bold text-muted-foreground">{label}</p>

      <p
        className={cn(
          'mt-1 text-lg font-extrabold',
          positive === true && 'text-positive',
          positive === false && 'text-destructive',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
      <h2 className="mb-4 text-lg font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

function OverviewTab({
  name,
  ticker,
  market,
  company,
  insights,
}: {
  name: string;
  ticker: string;
  market: 'KR' | 'US';
  company: AnyObj | null;
  insights: ReturnType<typeof buildAiInsights>;
}) {
  return (
    <div className="space-y-4">
      <SectionCard title="1. 뭐하는 회사인지?">
        <div className="space-y-3">
          <InfoBox>
            {company?.description
              ? translateMarketText(company.description)
              : `${name}은(는) ${
                  market === 'US' ? '미국' : '대한민국'
                }의 상장 기업입니다.`}
          </InfoBox>

          <InfoBox>
            업종:{' '}
            {translateMarketText(
              company?.industry ?? company?.sector ?? company?.mainBusiness ?? '확인 필요',
            )}
          </InfoBox>

          <InfoBox>
            주요 매출원과 핵심 사업은 공시·기업개요 데이터를 기준으로 확인합니다.
          </InfoBox>
        </div>
      </SectionCard>

      <SectionCard title="2. 매수/매도 의견">
        <div className="space-y-3">
          <InfoBox>AI 의견: {insights.opinion}</InfoBox>
          <InfoBox>AI 종합점수: {insights.score}점 ({insights.gradeText})</InfoBox>
          <InfoBox>{insights.opinionReason}</InfoBox>
        </div>
      </SectionCard>

      <SectionCard title="3. 핵심 리스크">
        <div className="space-y-2">
          {insights.riskSummary.map((item) => (
            <InfoLine key={item}>{item}</InfoLine>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="4. 종목 코드">
        <InfoBox>{ticker}</InfoBox>
      </SectionCard>
    </div>
  );
}

function AiTab({ insights }: { insights: ReturnType<typeof buildAiInsights> }) {
  return (
    <div className="space-y-4">
      <SectionCard title="종합 판단">
        <div className="space-y-3">
          <InfoBox>
            AI 종합점수 {insights.score}점 · {insights.gradeText}
          </InfoBox>

          <InfoBox>
            의견: {insights.opinion}
          </InfoBox>

          <InfoBox>{insights.opinionReason}</InfoBox>
        </div>
      </SectionCard>

      <SummaryList title="재무 분석" items={insights.financialSummary} />
      <SummaryList title="차트 분석" items={insights.chartSummary} />
      <SummaryList title="뉴스/공시 분석" items={insights.newsDisclosureSummary} />
      <SummaryList title="리스크 요약" items={insights.riskSummary} />
    </div>
  );
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  return (
    <SectionCard title={title}>
      <div className="space-y-2">
        {items.map((item) => (
          <InfoLine key={item}>{item}</InfoLine>
        ))}
      </div>
    </SectionCard>
  );
}

function ChartTab({
  candles,
  insights,
}: {
  candles: AnyObj[];
  insights: ReturnType<typeof buildAiInsights>;
}) {
  return (
    <div className="space-y-4">
      <SectionCard title="차트 흐름">
        <MiniChart candles={candles} />

        <div className="mt-4 space-y-2">
          {insights.chartSummary.map((item) => (
            <InfoLine key={item}>{item}</InfoLine>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="보조지표 요약">
        <div className="grid grid-cols-2 gap-2">
          <IndicatorCard label="거래량" value="수급 확인" />
          <IndicatorCard label="RSI" value="과열·침체 확인" />
          <IndicatorCard label="MACD" value="추세 전환 확인" />
          <IndicatorCard label="이동평균선" value="추세 위치 확인" />
        </div>
      </SectionCard>
    </div>
  );
}

function MiniChart({ candles }: { candles: AnyObj[] }) {
  const closes = candles
    .map((item) => toNumber(item.close))
    .filter((value): value is number => value != null)
    .slice(-40);

  if (closes.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center rounded-3xl bg-secondary/70">
        <p className="text-sm font-bold text-muted-foreground">
          차트 데이터 확인 중
        </p>
      </div>
    );
  }

  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const width = 320;
  const height = 150;
  const range = max - min || 1;

  const points = closes
    .map((close, index) => {
      const x = (index / (closes.length - 1)) * width;
      const y = height - ((close - min) / range) * height;

      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="rounded-3xl bg-secondary/70 p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-48 w-full">
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-primary"
        />
      </svg>
    </div>
  );
}

function FinancialTab({
  financials,
  currency,
}: {
  financials: AnyObj | null;
  currency: 'KRW' | 'USD';
}) {
  const quarterly = financialRows(financials, 'quarterly');
  const annual = financialRows(financials, 'annual');
  const ratios = financials?.ratios ?? {};

  return (
    <div className="space-y-4">
      <SectionCard title="핵심 투자지표">
        <div className="grid grid-cols-2 gap-2">
          <IndicatorCard label="PER" value={ratioDesc('PER', ratios.per)} />
          <IndicatorCard label="PBR" value={ratioDesc('PBR', ratios.pbr)} />
          <IndicatorCard label="ROE" value={ratioDesc('ROE', ratios.roe)} />
          <IndicatorCard
            label="부채비율"
            value={ratioDesc('부채비율', ratios.debtRatio)}
          />
        </div>
      </SectionCard>

      <FinancialRows title="분기별 재무" rows={quarterly} currency={currency} />
      <FinancialRows title="연도별 재무" rows={annual} currency={currency} />
    </div>
  );
}

function FinancialRows({
  title,
  rows,
  currency,
}: {
  title: string;
  rows: AnyObj[];
  currency: 'KRW' | 'USD';
}) {
  return (
    <SectionCard title={title}>
      {!rows.length && (
        <p className="break-keep text-sm font-bold text-muted-foreground">
          재무 데이터가 부족합니다.
        </p>
      )}

      <div className="space-y-3">
        {rows.slice(0, 8).map((row, index) => {
          const operatingIncome = toNumber(row.operatingIncome);
          const netIncome = toNumber(row.netIncome);

          return (
            <div
              key={`${row.period ?? row.date ?? index}`}
              className="rounded-2xl bg-secondary/70 p-3"
            >
              <p className="text-sm font-extrabold">
                {row.period ?? row.date ?? row.year ?? '기간 확인'}
              </p>

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-bold text-muted-foreground">
                <p>매출: {formatMoney(row.revenue, currency)}</p>
                <p>
                  영업이익:{' '}
                  <span
                    className={cn(
                      operatingIncome != null && operatingIncome >= 0
                        ? 'text-positive'
                        : 'text-destructive',
                    )}
                  >
                    {formatMoney(row.operatingIncome, currency)}
                  </span>
                </p>
                <p>
                  순이익:{' '}
                  <span
                    className={cn(
                      netIncome != null && netIncome >= 0
                        ? 'text-positive'
                        : 'text-destructive',
                    )}
                  >
                    {formatMoney(row.netIncome, currency)}
                  </span>
                </p>
                <p>부채: {formatMoney(row.debt, currency)}</p>
                <p>자본총계: {formatMoney(row.equity, currency)}</p>
                <p>
                  상태:{' '}
                  {netIncome == null
                    ? '확인 필요'
                    : netIncome >= 0
                      ? '흑자'
                      : '적자'}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function FilingTab({
  filings,
  summary,
}: {
  filings: AnyObj[];
  summary: string;
}) {
  return (
    <div className="space-y-4">
      <SectionCard title="AI 공시 요약">
        <InfoBox>{summary}</InfoBox>
      </SectionCard>

      <SectionCard title="공시 목록">
        <ArticleList items={filings} type="filing" empty="최근 확인된 공시가 부족합니다." />
      </SectionCard>
    </div>
  );
}

function NewsTab({
  news,
  summary,
}: {
  news: AnyObj[];
  summary: string;
}) {
  return (
    <div className="space-y-4">
      <SectionCard title="AI 뉴스 요약">
        <InfoBox>{summary}</InfoBox>
      </SectionCard>

      <SectionCard title="뉴스 목록">
        <ArticleList items={news} type="news" empty="최근 관련 뉴스가 부족합니다." />
      </SectionCard>
    </div>
  );
}

function ArticleList({
  items,
  type,
  empty,
}: {
  items: AnyObj[];
  type: 'news' | 'filing';
  empty: string;
}) {
  if (!items.length) {
    return (
      <p className="break-keep text-sm font-bold text-muted-foreground">
        {empty}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {items.slice(0, 20).map((item, index) => {
        const rawTitle =
          item.translatedTitle ??
          item.title ??
          item.report ??
          item.description ??
          item.form ??
          '제목 확인 필요';

        const title = translateMarketText(rawTitle);
        const summary = summarizeText(
          item.translatedSummary ?? item.summary ?? item.description ?? title,
          type === 'filing' ? '공시 요약 데이터가 부족합니다.' : '뉴스 요약 데이터가 부족합니다.',
        );

        const label =
          type === 'filing'
            ? eventLabelKo(item.eventLabels?.[0] ?? item.events?.[0] ?? item.form ?? title)
            : eventLabelKo(title);

        const inner = (
          <article className="rounded-2xl bg-secondary/70 p-3 transition active:scale-[0.99]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-keep text-sm font-extrabold leading-relaxed">
                  {title}
                </p>

                <p className="mt-1 text-xs font-bold text-muted-foreground">
                  {item.date ?? item.time ?? item.source ?? '날짜 확인'}
                </p>
              </div>

              {item.url && <ExternalLink className="h-4 w-4 shrink-0 text-primary" />}
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-primary/10 px-2 py-1 text-[11px] font-extrabold text-primary">
                {label}
              </span>

              {item.source && (
                <span className="rounded-full bg-background/70 px-2 py-1 text-[11px] font-bold text-muted-foreground">
                  {item.source}
                </span>
              )}
            </div>

            <p className="mt-2 break-keep text-xs font-semibold leading-relaxed text-muted-foreground">
              {summary}
            </p>
          </article>
        );

        if (item.url) {
          return (
            <a
              key={`${item.url}:${index}`}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {inner}
            </a>
          );
        }

        return <div key={`${title}:${index}`}>{inner}</div>;
      })}
    </div>
  );
}

function IndicatorCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-secondary/70 p-3">
      <p className="text-xs font-bold text-muted-foreground">{label}</p>

      <p className="mt-1 break-keep text-sm font-extrabold leading-relaxed">
        {value}
      </p>
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="break-keep rounded-2xl bg-secondary/70 p-4 text-sm font-semibold leading-relaxed text-muted-foreground">
      {children}
    </div>
  );
}

function InfoLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="break-keep rounded-2xl bg-secondary/70 px-3 py-2 text-sm font-semibold leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
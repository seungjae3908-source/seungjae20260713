import { useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  ChevronRight,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  WalletCards,
  X,
} from 'lucide-react';
import { AppModal } from '@/components/app-modal';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type PortfolioMarket = 'KR' | 'US' | 'COIN';
type Horizon = 'SHORT' | 'MID' | 'LONG';
type AnyObj = Record<string, any>;

type Holding = {
  id: string;
  ticker: string;
  name: string;
  market: PortfolioMarket;
  currency: 'KRW' | 'USD' | 'USDT';
  quantity: number;
  averagePrice: number;
  currentPrice: number | null;
};

type SearchResult = {
  ticker: string;
  name: string;
  market: PortfolioMarket;
};

type Recommendation = {
  ticker: string;
  name: string;
  market: PortfolioMarket;
  score: number;
  probability: number | null;
  price: number | null;
  reason: string;
  allocation: number;
};

type ResponsePlan = {
  holding: Holding;
  view: string;
  currentPrice: number | null;
  target: number | null;
  stop: number | null;
  buyLevels: number[];
  sellLevels: number[];
  basis: string[];
  risks: string[];
  action: string;
};

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeMarket(value: unknown): PortfolioMarket {
  const raw = String(value ?? '').toUpperCase();
  if (raw === 'COIN' || raw.includes('CRYPTO') || raw.includes('UPBIT')) return 'COIN';
  if (raw === 'US' || raw.includes('NASDAQ') || raw.includes('NYSE')) return 'US';
  return 'KR';
}

function collectSearchRows(value: unknown, rows: SearchResult[], depth = 0) {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectSearchRows(item, rows, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;

  const item = value as AnyObj;
  const ticker = String(
    item.ticker ?? item.symbol ?? item.code ?? item.stockCode ?? '',
  )
    .trim()
    .toUpperCase()
    .replace(/^KRW-/, '');
  const name = String(
    item.name ??
      item.stockName ??
      item.companyName ??
      item.koreanName ??
      item.korean_name ??
      item.englishName ??
      '',
  ).trim();

  if (ticker && name) {
    rows.push({ ticker, name, market: normalizeMarket(item.market ?? item.exchange) });
  }

  Object.values(item).forEach((nested) => {
    if (nested && typeof nested === 'object') collectSearchRows(nested, rows, depth + 1);
  });
}

function collectRecommendationRows(value: unknown, rows: AnyObj[], depth = 0) {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectRecommendationRows(item, rows, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;

  const item = value as AnyObj;
  const ticker = String(item.ticker ?? item.symbol ?? item.code ?? '').trim();
  const score = Number(item.score ?? item.aiScore ?? item.totalScore ?? item.confidence);
  if (ticker && Number.isFinite(score)) rows.push(item);

  Object.values(item).forEach((nested) => {
    if (nested && typeof nested === 'object') {
      collectRecommendationRows(nested, rows, depth + 1);
    }
  });
}

function currencyForMarket(market: PortfolioMarket) {
  return market === 'KR' ? 'KRW' : market === 'US' ? 'USD' : 'USDT';
}

function marketLabel(market: PortfolioMarket) {
  return market === 'KR' ? '국내주식' : market === 'US' ? '해외주식' : '코인';
}

function priceText(value: number | null, market: PortfolioMarket) {
  return formatAppPrice(value, currencyForMarket(market));
}

export function PortfolioPlannerModals() {
  const auth = useAuth();
  const [active, setActive] = useState<'holdings' | 'recommend' | 'response' | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const [market, setMarket] = useState<PortfolioMarket>('KR');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [averagePrice, setAveragePrice] = useState('');
  const [quantity, setQuantity] = useState('');

  const [waterHoldingId, setWaterHoldingId] = useState('');
  const [waterPrice, setWaterPrice] = useState('');
  const [waterQuantity, setWaterQuantity] = useState('');

  const [budget, setBudget] = useState('');
  const [horizon, setHorizon] = useState<Horizon>('SHORT');
  const [recommendMarket, setRecommendMarket] = useState<PortfolioMarket>('KR');
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);

  const [responsePlans, setResponsePlans] = useState<ResponsePlan[]>([]);

  const loadHoldings = async () => {
    if (!auth.user) {
      setHoldings([]);
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const { data, error } = await getSupabase()
        .from('portfolio_holdings')
        .select('*')
        .eq('user_id', auth.user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;

      const base = ((data ?? []) as AnyObj[]).map((row) => ({
        id: String(row.id ?? ''),
        ticker: String(row.ticker ?? '').toUpperCase(),
        name: String(row.name ?? row.ticker ?? ''),
        market: normalizeMarket(row.market),
        currency: String(row.currency ?? currencyForMarket(normalizeMarket(row.market))) as Holding['currency'],
        quantity: Number(row.quantity ?? 0),
        averagePrice: Number(row.average_price ?? 0),
        currentPrice: null,
      }));

      const stockTickers = base.filter((row) => row.market !== 'COIN').map((row) => row.ticker);
      let quoteMap = new Map<string, number>();
      if (stockTickers.length) {
        const response = await authorizedFetch(
          `/api/quotes?tickers=${encodeURIComponent(stockTickers.join(','))}`,
          { cache: 'no-store' },
        );
        if (response.ok) {
          const payload = await response.json();
          const rows: AnyObj[] = Array.isArray(payload?.quotes)
            ? (payload.quotes as AnyObj[])
            : [];

          quoteMap = new Map<string, number>(
            rows
              .map(
                (row: AnyObj): readonly [string, number] => [
                  String(row.ticker ?? row.symbol ?? '').toUpperCase(),
                  Number(row.price ?? row.currentPrice),
                ],
              )
              .filter(
                (entry: readonly [string, number]) =>
                  Boolean(entry[0]) && Number.isFinite(entry[1]),
              ),
          );
        }
      }

      let coinMap = new Map<string, number>();
      if (base.some((row) => row.market === 'COIN')) {
        const response = await authorizedFetch('/api/crypto/spot/tickers', {
          cache: 'no-store',
        });
        if (response.ok) {
          const payload = await response.json();
          coinMap = new Map(
            ((payload?.tickers ?? []) as AnyObj[])
              .map((row) => [String(row.symbol ?? '').toUpperCase(), Number(row.price)] as const)
              .filter(([, price]) => Number.isFinite(price)),
          );
        }
      }

      setHoldings(
        base.map((row) => ({
          ...row,
          currentPrice:
            row.market === 'COIN'
              ? coinMap.get(row.ticker) ?? null
              : quoteMap.get(row.ticker) ?? null,
        })),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '포트폴리오를 불러오지 못했습니다.');
      setHoldings([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    void loadHoldings();
  }, [active, auth.user?.id]);

  useEffect(() => {
    const clean = query.trim();
    if (!clean) {
      setSuggestions([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        if (market === 'COIN') {
          const response = await authorizedFetch('/api/crypto/spot/markets', {
            cache: 'no-store',
          });
          const payload = await response.json();
          const needle = clean.toLowerCase();
          const rows = ((payload?.markets ?? []) as AnyObj[])
            .map((row) => ({
              ticker: String(row.symbol ?? '').toUpperCase(),
              name: String(row.koreanName ?? row.englishName ?? row.symbol ?? ''),
              market: 'COIN' as const,
            }))
            .filter((row) =>
              `${row.ticker} ${row.name}`.toLowerCase().includes(needle),
            )
            .slice(0, 12);
          setSuggestions(rows);
          return;
        }

        const response = await authorizedFetch(
          `/api/search?q=${encodeURIComponent(clean)}&market=${market}`,
          { cache: 'no-store' },
        );
        const payload = await response.json();
        const rows: SearchResult[] = [];
        collectSearchRows(payload, rows);
        const unique = new Map<string, SearchResult>();
        rows
          .filter((row) => row.market === market)
          .forEach((row) => unique.set(`${row.market}:${row.ticker}`, row));
        setSuggestions([...unique.values()].slice(0, 12));
      } catch {
        setSuggestions([]);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [market, query]);

  const saveHolding = async () => {
    if (!auth.user || !selected) return;
    const parsedAverage = Number(averagePrice);
    const parsedQuantity = Number(quantity);
    if (!Number.isFinite(parsedAverage) || parsedAverage <= 0) {
      setMessage('평균 매수가를 확인하세요.');
      return;
    }
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      setMessage('수량을 확인하세요.');
      return;
    }

    setLoading(true);
    setMessage('보유 종목을 저장하는 중입니다.');
    try {
      const { error } = await getSupabase().from('portfolio_holdings').insert({
        user_id: auth.user.id,
        ticker: selected.ticker,
        name: selected.name,
        market: selected.market,
        currency: currencyForMarket(selected.market),
        quantity: parsedQuantity,
        average_price: parsedAverage,
        purchase_date: new Date().toISOString().slice(0, 10),
      });
      if (error) throw error;
      setQuery('');
      setSelected(null);
      setAveragePrice('');
      setQuantity('');
      setMessage('계정 포트폴리오에 저장했습니다.');
      await loadHoldings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '보유 종목 저장에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const waterResult = useMemo(() => {
    const holding = holdings.find((row) => row.id === waterHoldingId);
    const addPrice = Number(waterPrice);
    const addQuantity = Number(waterQuantity);
    if (
      !holding ||
      !Number.isFinite(addPrice) ||
      addPrice <= 0 ||
      !Number.isFinite(addQuantity) ||
      addQuantity <= 0
    ) {
      return null;
    }
    const oldCost = holding.averagePrice * holding.quantity;
    const addCost = addPrice * addQuantity;
    const totalQuantity = holding.quantity + addQuantity;
    return {
      holding,
      totalQuantity,
      newAverage: (oldCost + addCost) / totalQuantity,
      additionalAmount: addCost,
    };
  }, [holdings, waterHoldingId, waterPrice, waterQuantity]);

  const createRecommendations = async () => {
    const amount = Number(budget);
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage('추천에 사용할 금액을 입력하세요.');
      return;
    }
    setLoading(true);
    setMessage('실제 신호검색 결과를 분석하는 중입니다.');
    setRecommendations([]);
    try {
      const asset = recommendMarket === 'COIN' ? 'coin' : 'stock';
      const marketQuery =
        recommendMarket === 'COIN' ? 'spot' : recommendMarket;
      const response = await authorizedFetch(
        `/api/market/signal-scan?asset=${asset}&market=${marketQuery}`,
        { cache: 'no-store' },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? '추천 데이터를 불러오지 못했습니다.');

      const rawRows: AnyObj[] = [];
      collectRecommendationRows(payload, rawRows);
      const unique = new Map<string, AnyObj>();
      rawRows.forEach((row) => {
        const ticker = String(row.ticker ?? row.symbol ?? row.code ?? '').toUpperCase();
        if (ticker && !unique.has(ticker)) unique.set(ticker, row);
      });

      const horizonMinimum = horizon === 'SHORT' ? 72 : horizon === 'MID' ? 66 : 60;
      const count = horizon === 'SHORT' ? 3 : horizon === 'MID' ? 4 : 5;
      const selectedRows = [...unique.values()]
        .map((row) => ({
          ticker: String(row.ticker ?? row.symbol ?? row.code ?? '').toUpperCase(),
          name: String(row.name ?? row.stockName ?? row.koreanName ?? row.symbol ?? row.ticker ?? ''),
          score: Number(row.score ?? row.aiScore ?? row.totalScore ?? row.confidence ?? 0),
          probability: finite(row.probability ?? row.winProbability ?? row.breakoutProbability),
          price: finite(row.price ?? row.currentPrice ?? row.close),
          reason: String(
            row.reason ??
              row.summary ??
              (Array.isArray(row.reasons) ? row.reasons[0] : '') ??
              '실제 신호검색 점수 기준',
          ),
        }))
        .filter((row) => row.ticker && row.score >= horizonMinimum)
        .sort((left, right) => right.score - left.score)
        .slice(0, count);

      if (!selectedRows.length) {
        setMessage('현재 조건을 통과한 실제 추천 종목이 없습니다. 임의 종목은 만들지 않았습니다.');
        return;
      }

      const totalScore = selectedRows.reduce((sum, row) => sum + row.score, 0);
      setRecommendations(
        selectedRows.map((row) => ({
          ...row,
          market: recommendMarket,
          allocation: Math.floor((amount * row.score) / totalScore),
        })),
      );
      setMessage('현재 신호검색 결과로 추천 계획을 만들었습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '추천 계획 생성에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const createResponsePlans = async () => {
    if (!holdings.length) {
      setMessage('저장된 보유 종목이 없습니다.');
      return;
    }
    setLoading(true);
    setMessage('보유 종목별 실제 AI 가격계획을 불러오는 중입니다.');
    setResponsePlans([]);
    try {
      const plans = await Promise.all(
        holdings.map(async (holding): Promise<ResponsePlan> => {
          const asset = holding.market === 'COIN' ? 'coin' : 'stock';
          const coinMarket = holding.market === 'COIN' ? 'spot' : 'spot';
          const response = await authorizedFetch(
            `/api/market/ai-chart-plan?asset=${asset}&coinMarket=${coinMarket}&symbol=${encodeURIComponent(holding.ticker)}&interval=1D`,
            { cache: 'no-store' },
          );
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            return {
              holding,
              view: '분석 불가',
              currentPrice: holding.currentPrice,
              target: null,
              stop: null,
              buyLevels: [],
              sellLevels: [],
              basis: [],
              risks: [String(payload?.message ?? '분석 데이터를 불러오지 못했습니다.')],
              action: '데이터가 복구되기 전까지 신규 매수·매도를 보류합니다.',
            };
          }

          const currentPrice = finite(payload.currentPrice) ?? holding.currentPrice;
          const target = finite(payload.target);
          const stop = finite(payload.stop);
          const buyLevels = Array.isArray(payload.buyLevels)
            ? payload.buyLevels
                .map((value: unknown) => finite(value))
                .filter(
                  (value: number | null): value is number =>
                    value != null,
                )
            : [];

          const sellLevels = Array.isArray(payload.sellLevels)
            ? payload.sellLevels
                .map((value: unknown) => finite(value))
                .filter(
                  (value: number | null): value is number =>
                    value != null,
                )
            : [];
          const basis = Array.isArray(payload.basis) ? payload.basis.map(String).filter(Boolean) : [];
          const risks = Array.isArray(payload.risks) ? payload.risks.map(String).filter(Boolean) : [];
          const view = String(payload.view ?? '중립');
          const profitPercent =
            currentPrice != null && holding.averagePrice > 0
              ? ((currentPrice - holding.averagePrice) / holding.averagePrice) * 100
              : null;

          let action = '현재 가격대에서는 보유 비중을 유지하고 목표가·손절가 도달 여부를 확인합니다.';
          if (stop != null && currentPrice != null && currentPrice <= stop) {
            action = '현재가가 손절 기준에 도달했습니다. 추가매수보다 손실 제한을 우선 검토합니다.';
          } else if (target != null && currentPrice != null && currentPrice >= target) {
            action = '현재가가 목표가에 도달했습니다. 분할매도와 이익 보호를 우선 검토합니다.';
          } else if (view === '매수' && profitPercent != null && profitPercent < 0 && buyLevels.length) {
            action = '매수 관점이 유지되지만 손실 중입니다. 표시된 분할매수 가격과 손절가 사이에서만 물타기를 검토합니다.';
          } else if (view === '매도') {
            action = '매도 관점이 우세합니다. 신규 물타기를 중단하고 반등 시 비중 축소를 검토합니다.';
          }

          return {
            holding,
            view,
            currentPrice,
            target,
            stop,
            buyLevels,
            sellLevels,
            basis,
            risks,
            action,
          };
        }),
      );
      setResponsePlans(plans);
      setMessage('보유 종목 대응계획을 갱신했습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '대응계획 생성에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="grid grid-cols-1 gap-2">
      <Launcher
        title="보유 종목"
        description="평단가·수량·수익률·물타기 계산"
        icon={<WalletCards className="h-5 w-5" />}
        onClick={() => setActive('holdings')}
      />
      <Launcher
        title="추천 계획"
        description="입력 금액과 단기·중기·장기 기준 실제 신호 추천"
        icon={<Sparkles className="h-5 w-5" />}
        onClick={() => setActive('recommend')}
      />
      <Launcher
        title="대응 계획"
        description="저장된 종목의 목표가·손절가·분할 대응"
        icon={<ShieldCheck className="h-5 w-5" />}
        onClick={() => setActive('response')}
      />

      <AppModal open={active === 'holdings'} onClose={() => setActive(null)} title="보유 종목">
        <div className="space-y-4">
          <div className="rounded-2xl border border-card-border bg-background p-3">
            <div className="grid grid-cols-3 gap-2">
              {(['KR', 'US', 'COIN'] as PortfolioMarket[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setMarket(item);
                    setQuery('');
                    setSelected(null);
                  }}
                  className={cn(
                    'rounded-xl border px-2 py-2 text-[10px] font-black',
                    market === item
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-card-border bg-card text-muted-foreground',
                  )}
                >
                  {marketLabel(item)}
                </button>
              ))}
            </div>

            <label className="mt-3 flex h-11 items-center gap-2 rounded-xl border border-card-border bg-secondary/70 px-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelected(null);
                }}
                className="min-w-0 flex-1 bg-transparent text-sm font-black outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setSelected(null);
                  }}
                  aria-label="검색어 삭제"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </label>

            {suggestions.length > 0 && !selected && (
              <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-card-border bg-card p-2">
                {suggestions.map((row) => (
                  <button
                    key={`${row.market}:${row.ticker}`}
                    type="button"
                    onClick={() => {
                      setSelected(row);
                      setQuery(`${row.name} ${row.ticker}`);
                      setSuggestions([]);
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-xs font-black hover:bg-secondary"
                  >
                    <span className="min-w-0 truncate">{row.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{row.ticker}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <NumberInput label="평균 매수가" value={averagePrice} onChange={setAveragePrice} unit={currencyForMarket(market) === 'KRW' ? '원' : currencyForMarket(market) === 'USD' ? '달러' : 'USDT'} />
              <NumberInput label="수량" value={quantity} onChange={setQuantity} unit="주/개" />
            </div>
            <button
              type="button"
              onClick={() => void saveHolding()}
              disabled={loading || !selected}
              className="mt-3 h-11 w-full rounded-xl bg-primary text-sm font-black text-primary-foreground disabled:opacity-50"
            >
              계정 포트폴리오에 저장
            </button>
          </div>

          <div className="space-y-2">
            {holdings.map((holding) => {
              const current = holding.currentPrice;
              const rate =
                current != null && holding.averagePrice > 0
                  ? ((current - holding.averagePrice) / holding.averagePrice) * 100
                  : null;
              return (
                <article key={holding.id} className="rounded-2xl border border-card-border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black">{holding.name}</p>
                      <p className="mt-1 text-[10px] font-bold text-muted-foreground">{holding.ticker} · {marketLabel(holding.market)}</p>
                    </div>
                    <p className={cn('shrink-0 text-sm font-black', rate == null ? 'text-muted-foreground' : rate >= 0 ? 'text-positive' : 'text-destructive')}>
                      {rate == null ? '수익률 확인중' : formatAppPercent(rate)}
                    </p>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Metric label="평균 매수가" value={priceText(holding.averagePrice, holding.market)} />
                    <Metric label="현재가" value={priceText(current, holding.market)} />
                    <Metric label="보유 수량" value={holding.quantity.toLocaleString('ko-KR', { maximumFractionDigits: 8 })} />
                    <Metric label="평가금액" value={current == null ? '확인중' : priceText(current * holding.quantity, holding.market)} />
                  </div>
                </article>
              );
            })}
            {!loading && holdings.length === 0 && <State>저장된 보유 종목이 없습니다.</State>}
          </div>

          <div className="rounded-2xl border border-card-border bg-background p-3">
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-black">물타기 계산</h3>
            </div>
            <select
              value={waterHoldingId}
              onChange={(event) => setWaterHoldingId(event.target.value)}
              className="mt-3 h-11 w-full rounded-xl border border-card-border bg-secondary px-3 text-sm font-black outline-none"
            >
              <option value="">보유 종목 선택</option>
              {holdings.map((holding) => (
                <option key={holding.id} value={holding.id}>{holding.name} · {holding.ticker}</option>
              ))}
            </select>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <NumberInput label="추가 매수가" value={waterPrice} onChange={setWaterPrice} unit="금액" />
              <NumberInput label="추가 수량" value={waterQuantity} onChange={setWaterQuantity} unit="수량" />
            </div>
            {waterResult && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Metric label="새 평단가" value={priceText(waterResult.newAverage, waterResult.holding.market)} />
                <Metric label="총 보유 수량" value={waterResult.totalQuantity.toLocaleString('ko-KR', { maximumFractionDigits: 8 })} />
                <Metric label="추가 투자금" value={priceText(waterResult.additionalAmount, waterResult.holding.market)} />
                <Metric label="평단 변화" value={formatAppPercent(((waterResult.newAverage - waterResult.holding.averagePrice) / waterResult.holding.averagePrice) * 100)} />
              </div>
            )}
          </div>
          {message && <State>{message}</State>}
        </div>
      </AppModal>

      <AppModal open={active === 'recommend'} onClose={() => setActive(null)} title="추천 계획">
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {(['KR', 'US', 'COIN'] as PortfolioMarket[]).map((item) => (
              <button key={item} type="button" onClick={() => setRecommendMarket(item)} className={cn('rounded-xl border px-2 py-2 text-[10px] font-black', recommendMarket === item ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>
                {marketLabel(item)}
              </button>
            ))}
          </div>
          <NumberInput label="투자 가능 금액" value={budget} onChange={setBudget} unit={recommendMarket === 'KR' || recommendMarket === 'COIN' ? '원' : '달러'} />
          <div className="grid grid-cols-3 gap-2">
            {([
              ['SHORT', '단기'],
              ['MID', '중기'],
              ['LONG', '장기'],
            ] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setHorizon(key)} className={cn('rounded-xl border px-2 py-2 text-xs font-black', horizon === key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void createRecommendations()} disabled={loading} className="h-11 w-full rounded-xl bg-primary text-sm font-black text-primary-foreground disabled:opacity-50">
            실제 신호로 추천 계획 만들기
          </button>
          <div className="space-y-2">
            {recommendations.map((row, index) => (
              <article key={row.ticker} className="rounded-2xl border border-card-border bg-background p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black">{index + 1}. {row.name}</p>
                    <p className="mt-1 text-[10px] font-bold text-muted-foreground">{row.ticker} · 점수 {row.score}</p>
                  </div>
                  <p className="shrink-0 text-sm font-black text-primary">{priceText(row.allocation, row.market)}</p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Metric label="현재가" value={priceText(row.price, row.market)} />
                  <Metric label="신호 확률" value={row.probability == null ? '확인중' : formatAppPercent(row.probability)} />
                </div>
                <p className="mt-2 rounded-xl bg-secondary p-2 text-[10px] font-bold leading-4 text-muted-foreground">{row.reason}</p>
              </article>
            ))}
          </div>
          {message && <State>{message}</State>}
        </div>
      </AppModal>

      <AppModal open={active === 'response'} onClose={() => setActive(null)} title="대응 계획">
        <div className="space-y-3">
          <button type="button" onClick={() => void createResponsePlans()} disabled={loading} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-black text-primary-foreground disabled:opacity-50">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            보유 종목 대응계획 분석
          </button>
          {responsePlans.map((plan) => (
            <article key={plan.holding.id} className="rounded-2xl border border-card-border bg-background p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-black">{plan.holding.name}</p>
                  <p className="mt-1 text-[10px] font-bold text-muted-foreground">{plan.holding.ticker} · {plan.view}</p>
                </div>
                <p className="shrink-0 text-sm font-black">{priceText(plan.currentPrice, plan.holding.market)}</p>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Metric label="목표가" value={priceText(plan.target, plan.holding.market)} />
                <Metric label="손절가" value={priceText(plan.stop, plan.holding.market)} />
                <Metric label="분할매수" value={plan.buyLevels.length ? plan.buyLevels.map((value) => priceText(value, plan.holding.market)).join(' / ') : '분석값 없음'} />
                <Metric label="분할매도" value={plan.sellLevels.length ? plan.sellLevels.map((value) => priceText(value, plan.holding.market)).join(' / ') : '분석값 없음'} />
              </div>
              <p className="mt-3 rounded-xl bg-primary/10 p-3 text-xs font-black leading-5 text-primary">{plan.action}</p>
              {plan.basis[0] && <p className="mt-2 rounded-xl bg-secondary p-2 text-[10px] font-bold leading-4 text-muted-foreground">근거: {plan.basis[0]}</p>}
              {plan.risks[0] && <p className="mt-2 rounded-xl bg-destructive/10 p-2 text-[10px] font-bold leading-4 text-destructive">주의: {plan.risks[0]}</p>}
            </article>
          ))}
          {!loading && responsePlans.length === 0 && <State>분석 버튼을 누르면 저장된 종목별 대응계획이 표시됩니다.</State>}
          {message && <State>{message}</State>}
        </div>
      </AppModal>
    </section>
  );
}

function Launcher({
  title,
  description,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-4 text-left shadow-sm">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-center text-sm font-black">{title}</span>
        <span className="mt-1 block break-keep text-center text-[10px] font-bold leading-4 text-muted-foreground">{description}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  unit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  unit: string;
}) {
  return (
    <label className="block rounded-xl border border-card-border bg-secondary/70 p-2 text-center">
      <span className="text-[9px] font-black text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-center gap-1">
        <input value={value} onChange={(event) => onChange(event.target.value)} inputMode="decimal" className="min-w-0 flex-1 bg-transparent text-right text-xs font-black outline-none" />
        <span className="shrink-0 text-[9px] font-black">{unit}</span>
      </div>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-secondary p-2 text-center">
      <p className="text-[9px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-[10px] font-black leading-4">{value}</p>
    </div>
  );
}

function State({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-secondary p-3 text-center text-[10px] font-bold leading-4 text-muted-foreground">{children}</p>;
}

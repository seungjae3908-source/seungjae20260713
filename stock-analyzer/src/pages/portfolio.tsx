import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  Bell,
  LogIn,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  WalletCards,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';

interface Holding {
  id: string;
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  quantity: number;
  average_price: number;
  currentPrice?: number | null;
  changePercent?: number | null;
}

function money(value: number, currency: 'KRW' | 'USD') {
  if (!Number.isFinite(value)) return '-';
  if (currency === 'USD') {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  return `${Math.round(value).toLocaleString()}원`;
}

export default function PortfolioPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const [rows, setRows] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [ticker, setTicker] = useState('');
  const [name, setName] = useState('');
  const [market, setMarket] = useState<'KR' | 'US'>('KR');
  const [quantity, setQuantity] = useState('');
  const [averagePrice, setAveragePrice] = useState('');

  const load = useCallback(async () => {
    if (!auth.user || !auth.configured) return;
    setLoading(true);
    setError('');

    try {
      const supabase = getSupabase();
      const { data, error: selectError } = await supabase
        .from('portfolio_holdings')
        .select('*')
        .order('created_at', { ascending: false });

      if (selectError) throw selectError;

      const baseRows = (data ?? []).map((item) => ({
        id: String(item.id),
        ticker: String(item.ticker),
        name: String(item.name || item.ticker),
        market: item.market === 'US' ? ('US' as const) : ('KR' as const),
        currency: item.currency === 'USD' ? ('USD' as const) : ('KRW' as const),
        quantity: Number(item.quantity),
        average_price: Number(item.average_price),
      }));

      if (baseRows.length === 0) {
        setRows([]);
        return;
      }

      const quoteResponse = await fetch(
        `/api/quotes?tickers=${encodeURIComponent(baseRows.map((row) => row.ticker).join(','))}`,
      );
      const quoteData = quoteResponse.ok ? await quoteResponse.json() : {};
      const quoteMap = new Map<string, Record<string, unknown>>(
        Array.isArray(quoteData.quotes)
          ? quoteData.quotes.map(
              (quote: Record<string, unknown>) =>
                [String(quote.ticker).toUpperCase(), quote] as const,
            )
          : [],
      );

      setRows(
        baseRows.map((row) => {
          const quote = quoteMap.get(row.ticker.toUpperCase());
          return {
            ...row,
            currentPrice:
              quote?.price == null ? null : Number(quote.price as number),
            changePercent:
              quote?.changePercent == null
                ? null
                : Number(quote.changePercent as number),
          };
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '포트폴리오를 불러오지 못했습니다.',
      );
    } finally {
      setLoading(false);
    }
  }, [auth.configured, auth.user]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    let cost = 0;
    let value = 0;
    for (const row of rows) {
      cost += row.average_price * row.quantity;
      value += (row.currentPrice ?? row.average_price) * row.quantity;
    }
    const profit = value - cost;
    const rate = cost > 0 ? (profit / cost) * 100 : 0;
    return { cost, value, profit, rate };
  }, [rows]);

  async function addHolding(event: React.FormEvent) {
    event.preventDefault();
    if (!auth.user) return;

    const cleanTicker = ticker.trim().toUpperCase();
    const parsedQuantity = Number(quantity);
    const parsedAveragePrice = Number(averagePrice);

    if (!cleanTicker || parsedQuantity <= 0 || parsedAveragePrice <= 0) {
      setError('종목코드, 수량, 평균매수가를 정확히 입력해 주세요.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { error: insertError } = await getSupabase()
        .from('portfolio_holdings')
        .insert({
          user_id: auth.user.id,
          ticker: cleanTicker,
          name: name.trim() || cleanTicker,
          market,
          currency: market === 'KR' ? 'KRW' : 'USD',
          quantity: parsedQuantity,
          average_price: parsedAveragePrice,
        });

      if (insertError) throw insertError;
      setTicker('');
      setName('');
      setQuantity('');
      setAveragePrice('');
      setShowForm(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '종목 추가 실패');
    } finally {
      setLoading(false);
    }
  }

  async function removeHolding(id: string) {
    if (!confirm('이 보유 종목을 삭제할까요?')) return;
    try {
      const { error: deleteError } = await getSupabase()
        .from('portfolio_holdings')
        .delete()
        .eq('id', id);
      if (deleteError) throw deleteError;
      setRows((current) => current.filter((row) => row.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '삭제 실패');
    }
  }

  return (
    <main className="min-h-[100dvh] pb-24">
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/90 px-4 py-4 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-extrabold">내 포트폴리오</h1>
            <p className="text-xs text-muted-foreground">
              매수가·수량·현재가와 손익을 한 번에 확인합니다.
            </p>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => navigate('/alerts')}
              className="rounded-xl p-2 active:bg-muted"
              aria-label="알림"
            >
              <Bell className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/account')}
              className="rounded-xl p-2 active:bg-muted"
              aria-label="계정"
            >
              <UserRound className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <section className="space-y-4 p-4">
        {!auth.configured ? (
          <div className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5">
            <h2 className="font-extrabold">로그인 서버 설정이 필요합니다</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Supabase 환경변수와 제공된 SQL 스키마를 적용하면 사용자별
              포트폴리오가 활성화됩니다.
            </p>
          </div>
        ) : auth.loading ? (
          <div className="rounded-3xl border border-card-border bg-card p-6 text-center text-sm text-muted-foreground">
            로그인 상태 확인 중...
          </div>
        ) : !auth.user ? (
          <div className="rounded-3xl border border-card-border bg-card p-6 text-center shadow-sm">
            <LogIn className="mx-auto h-9 w-9 text-primary" />
            <h2 className="mt-3 font-extrabold">로그인이 필요합니다</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              로그인하면 보유 종목과 수익률을 안전하게 저장할 수 있습니다.
            </p>
            <button
              type="button"
              onClick={() => navigate('/login?next=/portfolio')}
              className="mt-5 rounded-2xl bg-primary px-5 py-3 text-sm font-extrabold text-primary-foreground"
            >
              로그인 / 회원가입
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <WalletCards className="h-5 w-5 text-primary" />
                  <h2 className="font-extrabold">전체 평가</h2>
                </div>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className="rounded-xl p-2 active:bg-muted disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <p className="mt-4 text-2xl font-black">
                {Math.round(summary.value).toLocaleString()}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-2xl bg-muted/60 p-3">
                  <p className="text-xs font-bold text-muted-foreground">평가손익</p>
                  <p
                    className={`mt-1 font-extrabold ${summary.profit >= 0 ? 'text-positive' : 'text-destructive'}`}
                  >
                    {summary.profit >= 0 ? '+' : ''}
                    {Math.round(summary.profit).toLocaleString()}
                  </p>
                </div>
                <div className="rounded-2xl bg-muted/60 p-3">
                  <p className="text-xs font-bold text-muted-foreground">수익률</p>
                  <p
                    className={`mt-1 font-extrabold ${summary.rate >= 0 ? 'text-positive' : 'text-destructive'}`}
                  >
                    {summary.rate >= 0 ? '+' : ''}
                    {summary.rate.toFixed(2)}%
                  </p>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                원화와 달러 보유분의 단순 합계입니다. 환율 환산 기능은 다음 단계에서
                연결됩니다.
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowForm((value) => !value)}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground"
              >
                <Plus className="h-4 w-4" /> 보유 종목 추가
              </button>
            </div>

            {showForm && (
              <form
                onSubmit={addHolding}
                className="space-y-3 rounded-3xl border border-card-border bg-card p-5 shadow-sm"
              >
                <div className="flex rounded-2xl bg-muted p-1">
                  {(['KR', 'US'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setMarket(item)}
                      className={`flex-1 rounded-xl py-2 text-sm font-extrabold ${market === item ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
                    >
                      {item === 'KR' ? '국내' : '미국'}
                    </button>
                  ))}
                </div>
                <input
                  value={ticker}
                  onChange={(event) => setTicker(event.target.value)}
                  placeholder={market === 'KR' ? '종목코드 예: 005930' : '티커 예: NVDA'}
                  className="w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
                />
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="종목명 (선택)"
                  className="w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    placeholder="수량"
                    className="rounded-2xl border border-card-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
                  />
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={averagePrice}
                    onChange={(event) => setAveragePrice(event.target.value)}
                    placeholder="평균매수가"
                    className="rounded-2xl border border-card-border bg-background px-4 py-3 text-sm outline-none focus:border-primary"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-50"
                >
                  저장
                </button>
              </form>
            )}

            {error && (
              <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">
                {error}
              </p>
            )}

            <div className="space-y-3">
              {rows.length === 0 && !loading ? (
                <div className="rounded-3xl border border-dashed border-card-border p-8 text-center text-sm text-muted-foreground">
                  보유 종목을 추가하면 실시간 손익과 AI 위험 분석을 연결할 수 있습니다.
                </div>
              ) : (
                rows.map((row) => {
                  const current = row.currentPrice ?? row.average_price;
                  const profit = (current - row.average_price) * row.quantity;
                  const rate =
                    row.average_price > 0
                      ? ((current - row.average_price) / row.average_price) * 100
                      : 0;

                  return (
                    <article
                      key={row.id}
                      className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => navigate(`/stock/${row.ticker}`)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span className="rounded-lg bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
                              {row.market === 'KR' ? '국내' : '미국'}
                            </span>
                            <span className="text-xs font-bold text-muted-foreground">
                              {row.ticker}
                            </span>
                          </div>
                          <h3 className="mt-2 truncate font-extrabold">{row.name}</h3>
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeHolding(row.id)}
                          className="rounded-xl p-2 text-muted-foreground active:bg-muted"
                          aria-label="삭제"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                        <div>
                          <p className="text-[11px] font-bold text-muted-foreground">현재가</p>
                          <p className="font-extrabold">{money(current, row.currency)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-bold text-muted-foreground">평균매수가</p>
                          <p className="font-extrabold">{money(row.average_price, row.currency)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-bold text-muted-foreground">수량</p>
                          <p className="font-extrabold">{row.quantity.toLocaleString()}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-bold text-muted-foreground">평가손익</p>
                          <p className={`font-extrabold ${profit >= 0 ? 'text-positive' : 'text-destructive'}`}>
                            {profit >= 0 ? '+' : ''}{money(profit, row.currency)} · {rate >= 0 ? '+' : ''}{rate.toFixed(2)}%
                          </p>
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </>
        )}
      </section>

      <BottomNav />
    </main>
  );
}

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useLocation } from 'wouter';
import {
  AlertTriangle,
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
import { cn } from '@/lib/utils';

type Market = 'KR' | 'US';
type Currency = 'KRW' | 'USD';

interface Holding {
  id: string;
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  quantity: number;
  average_price: number;
  currentPrice: number | null;
  changePercent: number | null;
}

interface PortfolioSummary {
  cost: number;
  value: number;
  profit: number;
  rate: number;
}

interface ResolvedStock {
  ticker: string;
  name: string;
  market: Market | null;
}

function toSafeNumber(
  value: unknown,
  fallback = 0,
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function money(
  value: number | null | undefined,
  currency: Currency,
): string {
  if (
    value == null ||
    !Number.isFinite(value)
  ) {
    return '-';
  }

  if (currency === 'USD') {
    return `$${value.toLocaleString(
      undefined,
      {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      },
    )}`;
  }

  return `${Math.round(
    value,
  ).toLocaleString()}원`;
}

function signedMoney(
  value: number,
  currency: Currency,
): string {
  const prefix =
    value > 0
      ? '+'
      : '';

  return `${prefix}${money(
    value,
    currency,
  )}`;
}

function signedPercent(
  value: number,
): string {
  if (!Number.isFinite(value)) {
    return '-';
  }

  const prefix =
    value > 0
      ? '+'
      : '';

  return `${prefix}${value.toFixed(
    2,
  )}%`;
}

function supabaseErrorMessage(
  cause: unknown,
): string {
  const raw =
    cause instanceof Error
      ? cause.message
      : String(
          cause ?? '',
        );

  const lower =
    raw.toLowerCase();

  if (
    lower.includes(
      'portfolio_holdings',
    ) &&
    (
      lower.includes(
        'does not exist',
      ) ||
      lower.includes(
        'could not find',
      ) ||
      lower.includes(
        'schema cache',
      )
    )
  ) {
    return '포트폴리오 저장 테이블이 아직 생성되지 않았습니다.';
  }

  if (
    lower.includes(
      'row-level security',
    ) ||
    lower.includes(
      'permission denied',
    ) ||
    lower.includes(
      'not authorized',
    ) ||
    lower.includes(
      '42501',
    )
  ) {
    return '이 계정이 포트폴리오를 저장할 수 있도록 데이터베이스 권한 설정이 필요합니다.';
  }

  if (
    lower.includes(
      'jwt',
    ) ||
    lower.includes(
      'session',
    ) ||
    lower.includes(
      'refresh token',
    )
  ) {
    return '로그인 세션이 만료되었습니다. 계정 화면에서 다시 로그인해 주세요.';
  }

  if (
    lower.includes(
      'failed to fetch',
    ) ||
    lower.includes(
      'network',
    )
  ) {
    return '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }

  return raw ||
    '포트폴리오를 불러오지 못했습니다.';
}

function normalizeHolding(
  item: Record<string, unknown>,
): Holding {
  const market: Market =
    item.market === 'US'
      ? 'US'
      : 'KR';

  const currency: Currency =
    item.currency === 'USD'
      ? 'USD'
      : market === 'US'
        ? 'USD'
        : 'KRW';

  return {
    id:
      String(
        item.id ?? '',
      ),

    ticker:
      String(
        item.ticker ?? '',
      )
        .trim()
        .toUpperCase(),

    name:
      String(
        item.name ??
          item.ticker ??
          '',
      ).trim(),

    market,
    currency,

    quantity:
      Math.max(
        0,
        toSafeNumber(
          item.quantity,
        ),
      ),

    average_price:
      Math.max(
        0,
        toSafeNumber(
          item.average_price,
        ),
      ),

    currentPrice:
      null,

    changePercent:
      null,
  };
}

function quoteMapFromResponse(
  data: unknown,
): Map<
  string,
  Record<string, unknown>
> {
  const object =
    data &&
    typeof data === 'object'
      ? data as Record<
          string,
          unknown
        >
      : {};

  const quoteRows =
    Array.isArray(
      object.quotes,
    )
      ? object.quotes
      : Array.isArray(data)
        ? data
        : [];

  const result =
    new Map<
      string,
      Record<string, unknown>
    >();

  for (
    const rawQuote of
    quoteRows
  ) {
    if (
      !rawQuote ||
      typeof rawQuote !==
        'object'
    ) {
      continue;
    }

    const quote =
      rawQuote as Record<
        string,
        unknown
      >;

    const ticker =
      String(
        quote.ticker ??
          quote.symbol ??
          quote.code ??
          '',
      )
        .trim()
        .toUpperCase();

    if (ticker) {
      result.set(
        ticker,
        quote,
      );
    }
  }

  return result;
}

function normalizeSearchText(
  value: string,
): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(
      /[\s._\-()/]/g,
      '',
    );
}

function searchCandidateMarket(
  item: Record<string, unknown>,
): Market | null {
  const raw =
    String(
      item.market ??
        item.country ??
        item.exchange ??
        item.marketType ??
        item.market_type ??
        '',
    ).toUpperCase();

  if (
    raw.includes('NASDAQ') ||
    raw.includes('NYSE') ||
    raw.includes('AMEX') ||
    raw === 'US' ||
    raw.includes('USA')
  ) {
    return 'US';
  }

  if (
    raw.includes('KOSPI') ||
    raw.includes('KOSDAQ') ||
    raw.includes('KOREA') ||
    raw === 'KR'
  ) {
    return 'KR';
  }

  return null;
}

function collectSearchCandidates(
  value: unknown,
  result: ResolvedStock[],
  depth = 0,
): void {
  if (
    value == null ||
    depth > 5
  ) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSearchCandidates(
        item,
        result,
        depth + 1,
      );
    }

    return;
  }

  if (
    typeof value !==
    'object'
  ) {
    return;
  }

  const item =
    value as Record<
      string,
      unknown
    >;

  const ticker =
    String(
      item.ticker ??
        item.symbol ??
        item.code ??
        item.stockCode ??
        item.stock_code ??
        item.shortCode ??
        '',
    )
      .trim()
      .toUpperCase();

  const name =
    String(
      item.name ??
        item.stockName ??
        item.stock_name ??
        item.companyName ??
        item.company_name ??
        item.koreanName ??
        item.korean_name ??
        item.koName ??
        item.title ??
        '',
    ).trim();

  if (
    ticker &&
    name
  ) {
    result.push({
      ticker,
      name,
      market:
        searchCandidateMarket(
          item,
        ),
    });
  }

  for (
    const nested of
    Object.values(item)
  ) {
    if (
      nested &&
      typeof nested ===
        'object'
    ) {
      collectSearchCandidates(
        nested,
        result,
        depth + 1,
      );
    }
  }
}

function chooseBestStock(
  candidates: ResolvedStock[],
  query: string,
  market: Market,
): ResolvedStock | null {
  const normalizedQuery =
    normalizeSearchText(
      query,
    );

  const unique =
    new Map<
      string,
      ResolvedStock
    >();

  for (
    const candidate of
    candidates
  ) {
    const key =
      `${candidate.market ?? ''}:${candidate.ticker}`;

    if (
      !unique.has(key)
    ) {
      unique.set(
        key,
        candidate,
      );
    }
  }

  const scored =
    Array.from(
      unique.values(),
    )
      .map(
        (candidate) => {
          const normalizedName =
            normalizeSearchText(
              candidate.name,
            );

          const normalizedTicker =
            normalizeSearchText(
              candidate.ticker,
            );

          let score = 0;

          if (
            candidate.market &&
            candidate.market !==
              market
          ) {
            score -= 1000;
          }

          if (
            candidate.market ===
            market
          ) {
            score += 30;
          }

          if (
            normalizedName ===
            normalizedQuery
          ) {
            score += 200;
          } else if (
            normalizedName.startsWith(
              normalizedQuery,
            )
          ) {
            score += 120;
          } else if (
            normalizedName.includes(
              normalizedQuery,
            )
          ) {
            score += 80;
          } else if (
            normalizedQuery.includes(
              normalizedName,
            )
          ) {
            score += 50;
          }

          if (
            normalizedTicker ===
            normalizedQuery
          ) {
            score += 220;
          }

          return {
            candidate,
            score,
          };
        },
      )
      .filter(
        (item) =>
          item.score > 0,
      )
      .sort(
        (a, b) =>
          b.score -
          a.score,
      );

  return (
    scored[0]?.candidate ??
    null
  );
}

async function resolveStockByName(
  name: string,
  market: Market,
): Promise<ResolvedStock | null> {
  const encodedName =
    encodeURIComponent(
      name,
    );

  const encodedMarket =
    encodeURIComponent(
      market,
    );

  const urls = [
    `/api/search?q=${encodedName}&market=${encodedMarket}`,
    `/api/search?query=${encodedName}&market=${encodedMarket}`,
    `/api/stocks/search?q=${encodedName}&market=${encodedMarket}`,
    `/api/stock/search?q=${encodedName}&market=${encodedMarket}`,
    `/api/stocks?q=${encodedName}&market=${encodedMarket}`,
  ];

  for (const url of urls) {
    try {
      const response =
        await fetch(
          url,
          {
            cache:
              'no-store',
          },
        );

      if (!response.ok) {
        continue;
      }

      const data =
        await response.json();

      const candidates:
        ResolvedStock[] =
        [];

      collectSearchCandidates(
        data,
        candidates,
      );

      const selected =
        chooseBestStock(
          candidates,
          name,
          market,
        );

      if (selected) {
        return selected;
      }
    } catch (cause) {
      console.debug(
        '종목 자동 검색 실패:',
        url,
        cause,
      );
    }
  }

  return null;
}

function createManualTicker(
  name: string,
  market: Market,
): string {
  const source =
    `${market}:${normalizeSearchText(
      name,
    )}`;

  let hash =
    2166136261;

  for (
    let index = 0;
    index < source.length;
    index += 1
  ) {
    hash ^=
      source.charCodeAt(
        index,
      );

    hash =
      Math.imul(
        hash,
        16777619,
      );
  }

  return `MANUAL-${market}-${(
    hash >>> 0
  )
    .toString(36)
    .toUpperCase()}`;
}

function isManualTicker(
  ticker: string,
): boolean {
  return ticker.startsWith(
    'MANUAL-',
  );
}

export default function PortfolioPage() {
  const [, navigate] =
    useLocation();

  const auth =
    useAuth();

  const [
    rows,
    setRows,
  ] =
    useState<Holding[]>(
      [],
    );

  const [
    loading,
    setLoading,
  ] =
    useState(false);

  const [
    initialized,
    setInitialized,
  ] =
    useState(false);

  const [
    error,
    setError,
  ] =
    useState('');

  const [
    showForm,
    setShowForm,
  ] =
    useState(false);

  const [
    name,
    setName,
  ] =
    useState('');

  const [
    market,
    setMarket,
  ] =
    useState<Market>(
      'KR',
    );

  const [
    quantity,
    setQuantity,
  ] =
    useState('');

  const [
    averagePrice,
    setAveragePrice,
  ] =
    useState('');

  const load =
    useCallback(
      async () => {
        if (
          auth.loading
        ) {
          return;
        }

        if (
          !auth.configured ||
          !auth.user
        ) {
          setRows([]);
          setInitialized(true);
          setLoading(false);

          return;
        }

        setLoading(true);
        setError('');

        try {
          const supabase =
            getSupabase();

          const {
            data,
            error:
              selectError,
          } =
            await supabase
              .from(
                'portfolio_holdings',
              )
              .select('*')
              .eq(
                'user_id',
                auth.user.id,
              )
              .order(
                'created_at',
                {
                  ascending:
                    false,
                },
              );

          if (selectError) {
            throw selectError;
          }

          const baseRows =
            (
              Array.isArray(data)
                ? data
                : []
            )
              .map(
                (
                  item,
                ) =>
                  normalizeHolding(
                    item as Record<
                      string,
                      unknown
                    >,
                  ),
              )
              .filter(
                (row) =>
                  Boolean(
                    row.id &&
                    row.ticker,
                  ),
              );

          if (
            baseRows.length ===
            0
          ) {
            setRows([]);
            setInitialized(true);

            return;
          }

          let quoteMap =
            new Map<
              string,
              Record<
                string,
                unknown
              >
            >();

          const quoteTickers =
            baseRows
              .filter(
                (row) =>
                  !isManualTicker(
                    row.ticker,
                  ),
              )
              .map(
                (row) =>
                  row.ticker,
              );

          if (
            quoteTickers.length >
            0
          ) {
            try {
              const response =
                await fetch(
                  `/api/quotes?tickers=${encodeURIComponent(
                    quoteTickers.join(
                      ',',
                    ),
                  )}`,
                  {
                    cache:
                      'no-store',
                  },
                );

              if (
                response.ok
              ) {
                quoteMap =
                  quoteMapFromResponse(
                    await response.json(),
                  );
              }
            } catch (
              quoteError
            ) {
              console.error(
                'portfolio quote error:',
                quoteError,
              );
            }
          }

          setRows(
            baseRows.map(
              (row) => {
                const quote =
                  quoteMap.get(
                    row.ticker,
                  );

                const quotePrice =
                  toSafeNumber(
                    quote?.price ??
                      quote?.currentPrice ??
                      quote?.cur_prc,
                    Number.NaN,
                  );

                const quoteChange =
                  toSafeNumber(
                    quote?.changePercent ??
                      quote?.change_rate ??
                      quote?.flu_rt,
                    Number.NaN,
                  );

                return {
                  ...row,

                  currentPrice:
                    Number.isFinite(
                      quotePrice,
                    )
                      ? Math.abs(
                          quotePrice,
                        )
                      : null,

                  changePercent:
                    Number.isFinite(
                      quoteChange,
                    )
                      ? quoteChange
                      : null,
                };
              },
            ),
          );

          setInitialized(true);
        } catch (cause) {
          console.error(
            'portfolio load error:',
            cause,
          );

          setRows([]);

          setError(
            supabaseErrorMessage(
              cause,
            ),
          );

          setInitialized(true);
        } finally {
          setLoading(false);
        }
      },
      [
        auth.configured,
        auth.loading,
        auth.user,
      ],
    );

  useEffect(() => {
    void load();
  }, [load]);

  const summary =
    useMemo<PortfolioSummary>(
      () => {
        let cost = 0;
        let value = 0;

        for (
          const row of
          rows
        ) {
          const rowCost =
            row.average_price *
            row.quantity;

          const current =
            row.currentPrice ??
            row.average_price;

          const rowValue =
            current *
            row.quantity;

          cost +=
            rowCost;

          value +=
            rowValue;
        }

        const profit =
          value -
          cost;

        const rate =
          cost > 0
            ? (
                profit /
                cost
              ) *
              100
            : 0;

        return {
          cost,
          value,
          profit,
          rate,
        };
      },
      [
        rows,
      ],
    );

  async function addHolding(
    event:
      FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (
      loading ||
      !auth.user
    ) {
      return;
    }

    const cleanName =
      name.trim();

    const parsedQuantity =
      Number(
        quantity,
      );

    const parsedAveragePrice =
      Number(
        averagePrice,
      );

    if (!cleanName) {
      setError(
        '종목명을 입력해 주세요.',
      );

      return;
    }

    if (
      !Number.isFinite(
        parsedQuantity,
      ) ||
      parsedQuantity <= 0
    ) {
      setError(
        '수량을 0보다 크게 입력해 주세요.',
      );

      return;
    }

    if (
      !Number.isFinite(
        parsedAveragePrice,
      ) ||
      parsedAveragePrice <= 0
    ) {
      setError(
        '평균매수가를 0보다 크게 입력해 주세요.',
      );

      return;
    }

    setLoading(true);
    setError('');

    try {
      const resolvedStock =
        await resolveStockByName(
          cleanName,
          market,
        );

      const resolvedTicker =
        resolvedStock?.ticker ??
        createManualTicker(
          cleanName,
          market,
        );

      const resolvedName =
        resolvedStock?.name ??
        cleanName;

      const supabase =
        getSupabase();

      const {
        error:
          insertError,
      } =
        await supabase
          .from(
            'portfolio_holdings',
          )
          .insert({
            user_id:
              auth.user.id,

            ticker:
              resolvedTicker,

            name:
              resolvedName,

            market,

            currency:
              market === 'KR'
                ? 'KRW'
                : 'USD',

            quantity:
              parsedQuantity,

            average_price:
              parsedAveragePrice,
          });

      if (insertError) {
        throw insertError;
      }

      setName('');
      setQuantity('');
      setAveragePrice('');
      setShowForm(false);

      await load();
    } catch (cause) {
      console.error(
        'portfolio insert error:',
        cause,
      );

      setError(
        supabaseErrorMessage(
          cause,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  async function removeHolding(
    id: string,
  ) {
    if (
      loading ||
      !auth.user
    ) {
      return;
    }

    const confirmed =
      window.confirm(
        '이 보유 종목을 삭제할까요?',
      );

    if (!confirmed) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      const {
        error:
          deleteError,
      } =
        await getSupabase()
          .from(
            'portfolio_holdings',
          )
          .delete()
          .eq(
            'id',
            id,
          )
          .eq(
            'user_id',
            auth.user.id,
          );

      if (deleteError) {
        throw deleteError;
      }

      setRows(
        (current) =>
          current.filter(
            (row) =>
              row.id !== id,
          ),
      );
    } catch (cause) {
      console.error(
        'portfolio delete error:',
        cause,
      );

      setError(
        supabaseErrorMessage(
          cause,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 shrink-0 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold">
              내 포트폴리오
            </h1>

            <p className="mt-1 break-keep text-xs font-semibold text-muted-foreground">
              매수가·수량·현재가와 손익을 한 번에 확인합니다.
            </p>
          </div>

          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() =>
                navigate(
                  '/alerts',
                )
              }
              className="flex h-10 w-10 items-center justify-center rounded-xl active:bg-muted"
              aria-label="알림"
            >
              <Bell className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={() =>
                navigate(
                  '/account',
                )
              }
              className="flex h-10 w-10 items-center justify-center rounded-xl active:bg-muted"
              aria-label="계정"
            >
              <UserRound className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pb-28 pt-4">
        {!auth.configured && (
          <section className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />

              <div>
                <h2 className="font-extrabold">
                  로그인 서버 설정이 필요합니다
                </h2>

                <p className="mt-2 break-keep text-sm font-semibold leading-6 text-muted-foreground">
                  Supabase 주소와 공개키가 등록되어야 사용자별
                  포트폴리오를 저장할 수 있습니다.
                </p>
              </div>
            </div>
          </section>
        )}

        {auth.configured &&
          auth.loading && (
            <LoadingCard text="로그인 상태를 확인하는 중입니다." />
          )}

        {auth.configured &&
          !auth.loading &&
          !auth.user && (
            <section className="rounded-3xl border border-card-border bg-card p-6 text-center shadow-sm">
              <LogIn className="mx-auto h-10 w-10 text-primary" />

              <h2 className="mt-3 text-lg font-extrabold">
                로그인이 필요합니다
              </h2>

              <p className="mt-2 break-keep text-sm font-semibold leading-6 text-muted-foreground">
                이름과 비밀번호로 로그인하면 보유 종목과 수익률을
                계정에 저장할 수 있습니다.
              </p>

              <button
                type="button"
                onClick={() =>
                  navigate(
                    '/account?next=/portfolio',
                  )
                }
                className="mt-5 rounded-2xl bg-primary px-5 py-3 text-sm font-extrabold text-primary-foreground"
              >
                로그인 · 계정 등록
              </button>
            </section>
          )}

        {auth.configured &&
          !auth.loading &&
          auth.user && (
            <div className="space-y-4">
              <section className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <WalletCards className="h-5 w-5 shrink-0 text-primary" />

                    <div className="min-w-0">
                      <h2 className="font-extrabold">
                        전체 평가
                      </h2>

                      <p className="mt-0.5 truncate text-[11px] font-bold text-muted-foreground">
                        {auth.displayName ??
                          '사용자'}님의 포트폴리오
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      void load()
                    }
                    disabled={
                      loading
                    }
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl active:bg-muted disabled:opacity-50"
                    aria-label="새로고침"
                  >
                    <RefreshCw
                      className={cn(
                        'h-4 w-4',

                        loading &&
                          'animate-spin',
                      )}
                    />
                  </button>
                </div>

                <p className="mt-4 text-2xl font-black">
                  {Math.round(
                    summary.value,
                  ).toLocaleString()}
                </p>

                <div className="mt-3 grid grid-cols-2 gap-3">
                  <SummaryBox
                    label="평가손익"
                    value={
                      summary.profit >=
                      0
                        ? `+${Math.round(
                            summary.profit,
                          ).toLocaleString()}`
                        : Math.round(
                            summary.profit,
                          ).toLocaleString()
                    }
                    positive={
                      summary.profit >=
                      0
                    }
                  />

                  <SummaryBox
                    label="수익률"
                    value={signedPercent(
                      summary.rate,
                    )}
                    positive={
                      summary.rate >=
                      0
                    }
                  />
                </div>

                <p className="mt-3 break-keep text-[11px] font-semibold leading-5 text-muted-foreground">
                  국내 원화와 미국 달러 보유분을 단순 합산한 값입니다.
                  환율 환산은 다음 단계에서 연결합니다.
                </p>
              </section>

              <button
                type="button"
                onClick={() => {
                  setShowForm(
                    (value) =>
                      !value,
                  );

                  setError('');
                }}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground"
              >
                <Plus className="h-4 w-4" />

                {showForm
                  ? '입력창 닫기'
                  : '보유 종목 추가'}
              </button>

              {showForm && (
                <form
                  onSubmit={
                    addHolding
                  }
                  className="space-y-3 rounded-3xl border border-card-border bg-card p-5 shadow-sm"
                >
                  <div className="grid grid-cols-2 rounded-2xl bg-muted p-1">
                    <button
                      type="button"
                      onClick={() =>
                        setMarket(
                          'KR',
                        )
                      }
                      className={cn(
                        'rounded-xl py-2.5 text-sm font-extrabold',

                        market === 'KR'
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground',
                      )}
                    >
                      국내
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setMarket(
                          'US',
                        )
                      }
                      className={cn(
                        'rounded-xl py-2.5 text-sm font-extrabold',

                        market === 'US'
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground',
                      )}
                    >
                      미국
                    </button>
                  </div>

                  <label className="block">
                    <span className="text-xs font-extrabold text-muted-foreground">
                      종목명
                    </span>

                    <input
                      value={
                        name
                      }
                      onChange={(
                        event,
                      ) =>
                        setName(
                          event.target
                            .value,
                        )
                      }
                      required
                      placeholder={
                        market === 'KR'
                          ? '예: 삼성전자'
                          : '예: 엔비디아'
                      }
                      className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-4 text-sm font-bold outline-none focus:border-primary"
                    />

                    <p className="mt-2 break-keep text-[11px] font-semibold leading-5 text-muted-foreground">
                      종목명을 입력하면 종목코드는 자동으로 찾습니다.
                    </p>
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-xs font-extrabold text-muted-foreground">
                        수량
                      </span>

                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min="0.00000001"
                        value={
                          quantity
                        }
                        onChange={(
                          event,
                        ) =>
                          setQuantity(
                            event.target
                              .value,
                          )
                        }
                        required
                        placeholder="수량"
                        className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary"
                      />
                    </label>

                    <label className="block">
                      <span className="text-xs font-extrabold text-muted-foreground">
                        평균매수가
                      </span>

                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min="0.00000001"
                        value={
                          averagePrice
                        }
                        onChange={(
                          event,
                        ) =>
                          setAveragePrice(
                            event.target
                              .value,
                          )
                        }
                        required
                        placeholder="매수가"
                        className="mt-2 h-12 w-full rounded-2xl border border-card-border bg-background px-3 text-sm font-bold outline-none focus:border-primary"
                      />
                    </label>
                  </div>

                  <button
                    type="submit"
                    disabled={
                      loading
                    }
                    className="w-full rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50"
                  >
                    {loading
                      ? '종목을 찾고 저장하는 중...'
                      : '보유 종목 저장'}
                  </button>
                </form>
              )}

              {error && (
                <section className="rounded-3xl border border-destructive/30 bg-destructive/10 p-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />

                    <div className="min-w-0">
                      <p className="break-keep text-sm font-extrabold leading-6 text-destructive">
                        {error}
                      </p>

                      <button
                        type="button"
                        onClick={() =>
                          void load()
                        }
                        className="mt-3 rounded-xl bg-background px-3 py-2 text-xs font-extrabold"
                      >
                        다시 불러오기
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {loading &&
                !initialized && (
                  <LoadingCard text="포트폴리오를 불러오는 중입니다." />
                )}

              {!loading &&
                initialized &&
                !error &&
                rows.length ===
                  0 && (
                  <section className="rounded-3xl border border-dashed border-card-border bg-card/50 p-8 text-center">
                    <WalletCards className="mx-auto h-9 w-9 text-muted-foreground" />

                    <p className="mt-3 text-sm font-extrabold">
                      아직 보유 종목이 없습니다
                    </p>

                    <p className="mt-2 break-keep text-xs font-semibold leading-5 text-muted-foreground">
                      보유 종목 추가 버튼을 눌러 종목명, 수량,
                      평균매수가를 저장해 주세요.
                    </p>
                  </section>
                )}

              <div className="space-y-3">
                {rows.map(
                  (row) => {
                    const current =
                      row.currentPrice ??
                      row.average_price;

                    const profit =
                      (
                        current -
                        row.average_price
                      ) *
                      row.quantity;

                    const rate =
                      row.average_price >
                      0
                        ? (
                            (
                              current -
                              row.average_price
                            ) /
                            row.average_price
                          ) *
                          100
                        : 0;

                    const manual =
                      isManualTicker(
                        row.ticker,
                      );

                    return (
                      <article
                        key={
                          row.id
                        }
                        className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                manual
                              ) {
                                return;
                              }

                              navigate(
                                `/stock/${encodeURIComponent(
                                  row.ticker,
                                )}`,
                              );
                            }}
                            aria-disabled={
                              manual
                            }
                            className="min-w-0 flex-1 text-left"
                          >
                            <span className="rounded-lg bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
                              {row.market ===
                              'KR'
                                ? '국내'
                                : '미국'}
                            </span>

                            <h3 className="mt-3 truncate font-extrabold">
                              {row.name}
                            </h3>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              void removeHolding(
                                row.id,
                              )
                            }
                            disabled={
                              loading
                            }
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground active:bg-muted disabled:opacity-50"
                            aria-label="삭제"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>

                        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                          <HoldingValue
                            label="현재가"
                            value={money(
                              current,
                              row.currency,
                            )}
                          />

                          <HoldingValue
                            label="평균매수가"
                            value={money(
                              row.average_price,
                              row.currency,
                            )}
                          />

                          <HoldingValue
                            label="수량"
                            value={row.quantity.toLocaleString()}
                          />

                          <HoldingValue
                            label="평가금액"
                            value={money(
                              current *
                                row.quantity,
                              row.currency,
                            )}
                          />

                          <div className="col-span-2 rounded-2xl bg-muted/60 p-3">
                            <p className="text-[11px] font-bold text-muted-foreground">
                              평가손익
                            </p>

                            <p
                              className={cn(
                                'mt-1 text-sm font-extrabold',

                                profit >= 0
                                  ? 'text-positive'
                                  : 'text-destructive',
                              )}
                            >
                              {signedMoney(
                                profit,
                                row.currency,
                              )}{' '}
                              ·{' '}
                              {signedPercent(
                                rate,
                              )}
                            </p>
                          </div>
                        </div>
                      </article>
                    );
                  },
                )}
              </div>
            </div>
          )}
      </main>

      <BottomNav />
    </div>
  );
}

function LoadingCard({
  text,
}: {
  text: string;
}) {
  return (
    <section className="rounded-3xl border border-card-border bg-card p-8 text-center shadow-sm">
      <RefreshCw className="mx-auto h-5 w-5 animate-spin text-primary" />

      <p className="mt-3 text-sm font-bold text-muted-foreground">
        {text}
      </p>
    </section>
  );
}

function SummaryBox({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive: boolean;
}) {
  return (
    <div className="rounded-2xl bg-muted/60 p-3">
      <p className="text-xs font-bold text-muted-foreground">
        {label}
      </p>

      <p
        className={cn(
          'mt-1 font-extrabold',

          positive
            ? 'text-positive'
            : 'text-destructive',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function HoldingValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-bold text-muted-foreground">
        {label}
      </p>

      <p className="mt-1 truncate text-sm font-extrabold">
        {value}
      </p>
    </div>
  );
}
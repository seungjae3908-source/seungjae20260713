import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Check,
  ChevronDown,
  ChevronUp,
  Search,
  Star,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { useQuotes } from "@/hooks/use-stock-data";
import { BottomNav } from "@/components/bottom-nav";
import { LoadingState } from "@/components/data-state";
import { api, apiGet, type SearchResult } from "@/lib/api";
import { authorizedFetch } from "@/lib/auth-fetch";
import {
  displayStockName,
  formatAppPercent,
  formatAppPrice,
  readWatchlistItems,
  setWatchlistTargetPrice,
  toggleWatchlistItem,
  WATCHLIST_CHANGE_EVENT,
  writeWatchlistItems,
  type WatchlistItem,
} from "@/lib/stock-display";
import { cn } from "@/lib/utils";

type AnyObj = Record<string, any>;
type InterestTab = "watchlist" | "price-alert";
type AlertDirection = "above" | "below";

type PriceAlertRow = {
  id: string;
  asset_type?: string;
  market?: string;
  symbol?: string;
  direction?: AlertDirection;
  target_price?: number | string;
  repeat_enabled?: boolean;
  app_enabled?: boolean;
  push_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
};

type CoinTickerRow = {
  symbol?: string;
  price?: number | null;
  changePercent?: number | null;
  changePercent24h?: number | null;
};

export default function WatchlistPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<InterestTab>("watchlist");
  const [items, setItems] = useState<WatchlistItem[]>(() =>
    readWatchlistItems(),
  );

  const alertsQuery = useQuery({
    queryKey: ["notification-price-alerts"],
    queryFn: () => apiGet<{ alerts?: PriceAlertRow[] }>("/notifications/price-alerts"),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });

  const stockAlerts = useMemo(
    () =>
      (alertsQuery.data?.alerts ?? []).filter(
        (row) => String(row.asset_type ?? "stock") === "stock",
      ),
    [alertsQuery.data?.alerts],
  );

  const tickers = useMemo(
    () =>
      Array.from(
        new Set([
          ...items
            .filter(
              (item) =>
                item.assetType !== "coinSpot" &&
                item.assetType !== "coinFutures",
            )
            .map((item) => item.ticker),
          ...stockAlerts
            .map((row) => String(row.symbol ?? "").trim().toUpperCase())
            .filter(Boolean),
        ]),
      ),
    [items, stockAlerts],
  );

  const { data, isLoading } = useQuotes(tickers);
  const spotItems = items.filter((item) => item.assetType === "coinSpot");
  const futuresItems = items.filter((item) => item.assetType === "coinFutures");
  const spotQuotes = useQuery({
    queryKey: [
      "watchlist-spot-quotes",
      spotItems.map((item) => item.ticker).sort().join(","),
    ],
    queryFn: () =>
      apiGet<{ tickers?: CoinTickerRow[]; updatedAt?: string }>(
        `/crypto/spot/tickers?markets=${encodeURIComponent(
          spotItems.map((item) => item.ticker).join(","),
        )}`,
      ),
    enabled: spotItems.length > 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: 2,
  });
  const futuresQuotes = useQuery({
    queryKey: ["watchlist-futures-quotes"],
    queryFn: () =>
      apiGet<{ tickers?: CoinTickerRow[]; updatedAt?: string }>(
        "/crypto/futures/tickers",
      ),
    enabled: futuresItems.length > 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: 2,
  });

  useEffect(() => {
    const refresh = () => setItems(readWatchlistItems());

    window.addEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);

    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const quoteMap = useMemo(
    () =>
      new Map(
        (data?.quotes ?? []).map((quote) => [
          String(quote.ticker).toUpperCase(),
          quote,
        ]),
      ),
    [data?.quotes],
  );

  const rows = useMemo(
    () =>
      items.map((item) => {
        const assetType =
          item.assetType ??
          (item.market === "US" ? "stockUS" : "stockKR");
        const coinRows =
          assetType === "coinSpot"
            ? spotQuotes.data?.tickers
            : assetType === "coinFutures"
              ? futuresQuotes.data?.tickers
              : null;
        const coinQuote = coinRows?.find(
          (quote) =>
            String(quote.symbol ?? "").toUpperCase() ===
            item.ticker.toUpperCase(),
        );
        const cachedPlan = queryClient.getQueryData<Record<string, unknown>>([
          "chart-relay-ai",
          assetType,
          item.ticker.toUpperCase(),
          "5m",
        ]);
        const cachedSignals = queryClient.getQueryData<{
          signals?: Array<Record<string, unknown>>;
        }>([
          "chart-relay-signals",
          assetType,
          item.ticker.toUpperCase(),
          "5m",
        ]);
        return {
          ...item,
          assetType,
          ...(quoteMap.get(item.ticker.toUpperCase()) as AnyObj | undefined),
          ...(coinQuote
            ? {
                price: coinQuote.price,
                changePercent:
                  coinQuote.changePercent ?? coinQuote.changePercent24h,
              }
            : {}),
          liveStatus:
            assetType === "coinSpot"
              ? spotQuotes.isError
                ? "지연"
                : "REST 갱신"
              : assetType === "coinFutures"
                ? futuresQuotes.isError
                  ? "지연"
                  : "REST 갱신"
                : "REST 갱신",
          updatedAt:
            assetType === "coinSpot"
              ? spotQuotes.data?.updatedAt
              : assetType === "coinFutures"
                ? futuresQuotes.data?.updatedAt
                : new Date().toISOString(),
          aiDirection: cachedPlan?.view,
          latestSignal: cachedSignals?.signals?.[0]?.name,
          confidence:
            cachedPlan?.confidence ??
            cachedPlan?.confidenceScore ??
            cachedPlan?.probability,
        };
      }),
    [
      futuresQuotes.data,
      futuresQuotes.isError,
      items,
      queryClient,
      quoteMap,
      spotQuotes.data,
      spotQuotes.isError,
    ],
  );

  const remove = async (
    event: MouseEvent<HTMLButtonElement>,
    row: WatchlistItem,
  ) => {
    event.stopPropagation();
    const previous = readWatchlistItems();
    toggleWatchlistItem(row);
    setItems(readWatchlistItems());
    try {
      const response = await authorizedFetch(
        `/api/watchlist/${encodeURIComponent(row.ticker)}?asset=${encodeURIComponent(
          row.assetType ?? (row.market === "US" ? "stockUS" : "stockKR"),
        )}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      writeWatchlistItems(previous);
      setItems(previous);
      window.alert("관심종목 삭제에 실패해 이전 상태로 되돌렸습니다.");
    }
  };

  const deletePriceAlert = async (id: string) => {
    const alertId = String(id ?? "").trim();

    if (!alertId) {
      throw new Error("삭제할 지정가 알림 ID가 없습니다.");
    }

    const response = await authorizedFetch(
      `/api/notifications/price-alerts/${encodeURIComponent(alertId)}`,
      {
        method: "DELETE",
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache, no-store, max-age=0",
          Pragma: "no-cache",
        },
      },
    );

    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      deletedId?: string;
      error?: string;
      message?: string;
    };

    if (!response.ok || body.ok !== true) {
      throw new Error(
        body.message ??
          body.error ??
          `지정가 알림 삭제 실패: ${response.status}`,
      );
    }

    const deletedId = String(body.deletedId ?? alertId);

    queryClient.setQueryData<{ alerts?: PriceAlertRow[] }>(
      ["notification-price-alerts"],
      (current) => ({
        ...(current ?? {}),
        alerts: (current?.alerts ?? []).filter(
          (row) => String(row.id) !== deletedId,
        ),
      }),
    );

    await queryClient.refetchQueries({
      queryKey: ["notification-price-alerts"],
      type: "active",
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
      <header className="relative z-20 border-b border-card-border bg-background/90 px-4 pb-3 pt-4 glass">
        <h1 className="text-center text-xl font-extrabold">관심</h1>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <HeaderTab
            active={tab === "watchlist"}
            onClick={() => setTab("watchlist")}
          >
            관심종목
          </HeaderTab>
          <HeaderTab
            active={tab === "price-alert"}
            onClick={() => setTab("price-alert")}
          >
            지정가알림
          </HeaderTab>
        </div>
      </header>

      <main className="flex-none p-3 pb-24">
        {tab === "watchlist" ? (
          items.length === 0 ? (
            <EmptyState />
          ) : isLoading ||
            (spotItems.length > 0 && spotQuotes.isLoading) ||
            (futuresItems.length > 0 && futuresQuotes.isLoading) ? (
            <LoadingState label="관심종목 불러오는 중..." />
          ) : (
            <div className="space-y-2">
              {rows.map((row) => (
                <WatchCard
                  key={`${row.assetType ?? "stockKR"}:${row.ticker}`}
                  row={row}
                  onOpen={() =>
                    navigate(
                      `/tech/chart-relay?asset=${encodeURIComponent(
                        row.assetType ??
                          (row.market === "US" ? "stockUS" : "stockKR"),
                      )}&symbol=${encodeURIComponent(
                        row.ticker,
                      )}&interval=5m`,
                    )
                  }
                  onRemove={remove}
                />
              ))}
            </div>
          )
        ) : (
          <PriceAlertWorkspace
            alerts={stockAlerts}
            alertsLoading={alertsQuery.isLoading}
            alertsError={alertsQuery.isError}
            quoteMap={quoteMap}
            onSaved={() =>
              queryClient.invalidateQueries({
                queryKey: ["notification-price-alerts"],
              })
            }
            onDelete={deletePriceAlert}
          />
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function HeaderTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center rounded-xl border px-3 py-2 text-center text-sm font-extrabold",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-card-border bg-card text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PriceAlertWorkspace({
  alerts,
  alertsLoading,
  alertsError,
  quoteMap,
  onSaved,
  onDelete,
}: {
  alerts: PriceAlertRow[];
  alertsLoading: boolean;
  alertsError: boolean;
  quoteMap: Map<string, AnyObj>;
  onSaved: () => Promise<unknown> | unknown;
  onDelete: (id: string) => Promise<void>;
}) {
  const [searchText, setSearchText] = useState("");
  const deferredSearch = useDeferredValue(searchText.trim());
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [direction, setDirection] = useState<AlertDirection>("above");
  const [targetPrice, setTargetPrice] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 알림 추가/알림종류는 처음 들어왔을 때 접힌 상태로 시작합니다.
  const [editorOpen, setEditorOpen] = useState(false);

  const searchQuery = useQuery({
    queryKey: ["price-alert-stock-autocomplete", deferredSearch],
    queryFn: () => api.search(deferredSearch),
    enabled: deferredSearch.length >= 1,
    staleTime: 30_000,
    retry: 1,
  });

  const suggestions = useMemo(
    () => (searchQuery.data?.results ?? []).slice(0, 10),
    [searchQuery.data?.results],
  );

  const selectedQuoteQuery = useQuery({
    queryKey: ["price-alert-selected-quote", selected?.ticker],
    queryFn: () => api.quotes(selected ? [selected.ticker] : []),
    enabled: Boolean(selected?.ticker),
    staleTime: 10_000,
    refetchInterval: selected ? 15_000 : false,
  });

  const selectedQuote = selected
    ? selectedQuoteQuery.data?.quotes?.[0] ??
      quoteMap.get(selected.ticker.toUpperCase())
    : undefined;
  const selectedPrice = Number(selectedQuote?.price);
  const currentPrice = Number.isFinite(selectedPrice) ? selectedPrice : null;
  const selectedCurrency =
    selectedQuote?.currency === "USD" || selected?.currency === "USD"
      ? "USD"
      : "KRW";

  const chooseStock = (item: SearchResult) => {
    setSelected(item);
    setSearchText(displayStockName(item.ticker, item.name, item.market));
    setSuggestionsOpen(false);
    setMessage(null);
  };

  const save = async () => {
    if (!selected) {
      setMessage("검색 결과에서 종목을 먼저 선택해 주세요.");
      return;
    }

    const parsedTarget = Number(targetPrice.replace(/,/g, "").trim());
    if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
      setMessage("알림을 받을 가격을 입력해 주세요.");
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const response = await authorizedFetch(
        "/api/notifications/price-alerts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assetType: "stock",
            market: selected.market,
            symbol: selected.ticker,
            direction,
            targetPrice: parsedTarget,
            repeatEnabled: false,
            appEnabled: enabled,
            pushEnabled: enabled,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`지정가 알림 저장 실패: ${response.status}`);
      }

      setTargetPrice("");
      setMessage("지정가 알림을 저장했습니다.");
      await onSaved();
    } catch {
      setMessage("저장하지 못했습니다. 로그인 상태와 서버 연결을 확인해 주세요.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setDeletingId(id);
    setMessage(null);

    try {
      await onDelete(id);
      setMessage("지정가 알림을 삭제했습니다.");
    } catch {
      setMessage("삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <button
          type="button"
          aria-expanded={editorOpen}
          onClick={() => setEditorOpen((current) => !current)}
          className="flex w-full items-center justify-between gap-3 rounded-2xl bg-secondary/60 px-3 py-3 text-left"
        >
          <span>
            <span className="block text-sm font-extrabold">지정가 알림 추가</span>
            <span className="mt-0.5 block text-[10px] font-bold text-muted-foreground">
              종목·알림종류·설정가 입력
            </span>
          </span>
          {editorOpen ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>

        {editorOpen && (
          <div className="mt-3">
        <div className="relative">
          <label className="flex h-12 items-center gap-2 rounded-2xl border border-card-border bg-card px-3 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
            <Search className="h-4 w-4 shrink-0 text-foreground/70" />
            <input
              value={searchText}
              onFocus={() => setSuggestionsOpen(true)}
              onChange={(event) => {
                setSearchText(event.target.value);
                setSelected(null);
                setSuggestionsOpen(true);
                setMessage(null);
              }}
              placeholder=""
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-sm font-bold text-foreground outline-none"
            />
            {searchText && (
              <button type="button" onClick={() => { setSearchText(""); setSelected(null); setSuggestionsOpen(false); }} aria-label="검색어 지우기" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            )}
          </label>

          {suggestionsOpen && deferredSearch.length >= 1 && !selected && (
            <div className="absolute inset-x-0 top-[3.25rem] z-30 max-h-64 overflow-y-auto rounded-2xl border border-card-border bg-card p-2 shadow-2xl">
              {searchQuery.isLoading && (
                <p className="rounded-xl bg-secondary/70 p-3 text-center text-xs font-bold text-muted-foreground">
                  종목을 찾는 중입니다.
                </p>
              )}

              {searchQuery.isError && (
                <p className="rounded-xl bg-destructive/10 p-3 text-center text-xs font-bold text-destructive">
                  종목 검색에 실패했습니다.
                </p>
              )}

              {!searchQuery.isLoading &&
                !searchQuery.isError &&
                suggestions.length === 0 && (
                  <p className="rounded-xl bg-secondary/70 p-3 text-center text-xs font-bold text-muted-foreground">
                    검색 결과가 없습니다.
                  </p>
                )}

              {suggestions.map((item) => (
                <button
                  key={`${item.market}:${item.ticker}`}
                  type="button"
                  onClick={() => chooseStock(item)}
                  className="flex w-full items-center gap-3 rounded-xl border border-transparent bg-background px-3 py-2.5 text-left transition-colors hover:border-primary/25 hover:bg-secondary active:bg-secondary"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-extrabold text-foreground">
                      {displayStockName(item.ticker, item.name, item.market)}
                    </p>
                    <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                      {item.market === "KR" ? "국내" : "해외"} · {item.ticker}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-lg bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
                    선택
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className="mt-3 flex items-center gap-3 rounded-2xl bg-secondary/70 p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Check className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-extrabold">
                {displayStockName(selected.ticker, selected.name, selected.market)}
              </p>
              <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                {selected.ticker} · 현재가 {formatAppPrice(currentPrice, selectedCurrency)}
              </p>
            </div>
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDirection("above")}
            className={cn(
              "rounded-xl border px-3 py-2 text-xs font-extrabold",
              direction === "above"
                ? "border-positive bg-positive/10 text-positive"
                : "border-card-border bg-background text-muted-foreground",
            )}
          >
            설정가 이상
          </button>
          <button
            type="button"
            onClick={() => setDirection("below")}
            className={cn(
              "rounded-xl border px-3 py-2 text-xs font-extrabold",
              direction === "below"
                ? "border-destructive bg-destructive/10 text-destructive"
                : "border-card-border bg-background text-muted-foreground",
            )}
          >
            설정가 이하
          </button>
        </div>

        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <input
            inputMode="decimal"
            value={targetPrice}
            onChange={(event) => setTargetPrice(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            placeholder="알림 가격 입력"
            className="h-11 min-w-0 rounded-xl border border-card-border bg-background px-3 text-sm font-extrabold outline-none placeholder:font-normal placeholder:text-muted-foreground focus:border-primary"
          />
          <button
            type="button"
            onClick={() => setEnabled((current) => !current)}
            className={cn(
              "rounded-xl border px-3 text-xs font-extrabold",
              enabled
                ? "border-primary bg-primary/10 text-primary"
                : "border-card-border bg-background text-muted-foreground",
            )}
          >
            {enabled ? "알림 켜짐" : "알림 꺼짐"}
          </button>
        </div>

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="mt-3 w-full rounded-2xl bg-primary py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-50"
        >
          {saving ? "저장 중" : "지정가 알림 저장"}
        </button>

        {message && (
          <p className="mt-3 break-keep text-center text-xs font-bold text-muted-foreground">
            {message}
          </p>
        )}
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-extrabold">저장된 지정가 알림</h2>
          <span className="ml-auto rounded-full bg-secondary px-2 py-1 text-[10px] font-bold text-muted-foreground">
            {alerts.length}건
          </span>
        </div>

        {alertsLoading && (
          <p className="mt-3 rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground">
            지정가 알림을 불러오는 중입니다.
          </p>
        )}

        {alertsError && (
          <p className="mt-3 rounded-2xl bg-destructive/10 p-4 text-center text-xs font-bold text-destructive">
            지정가 알림을 불러오지 못했습니다.
          </p>
        )}

        {!alertsLoading && !alertsError && alerts.length === 0 && (
          <p className="mt-3 rounded-2xl bg-secondary p-5 text-center text-xs font-bold text-muted-foreground">
            저장된 지정가 알림이 없습니다.
          </p>
        )}

        <div className="mt-3 space-y-2">
          {alerts.map((row) => {
            const ticker = String(row.symbol ?? "").toUpperCase();
            const quote = quoteMap.get(ticker);
            const market = row.market === "US" || quote?.market === "US" ? "US" : "KR";
            const currency = quote?.currency === "USD" || market === "US" ? "USD" : "KRW";
            const name = displayStockName(ticker, quote?.name ?? ticker, market);
            const target = Number(row.target_price);
            const active = Boolean(row.app_enabled || row.push_enabled);

            return (
              <article
                key={row.id}
                className="rounded-2xl border border-card-border bg-background p-3"
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      window.location.assign(
                        `/stock/${encodeURIComponent(ticker)}?back=${encodeURIComponent(
                          "/watchlist",
                        )}`,
                      )
                    }
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-sm font-extrabold">{name}</p>
                    <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                      {ticker} · {market === "KR" ? "국내" : "해외"}
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => void remove(row.id)}
                    disabled={deletingId === row.id}
                    aria-label="지정가 알림 삭제"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-card-border text-destructive disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-secondary/70 p-2">
                    <p className="text-[9px] font-bold text-muted-foreground">조건</p>
                    <p className="mt-1 text-xs font-extrabold">
                      {row.direction === "below" ? "이하" : "이상"}
                    </p>
                  </div>
                  <div className="rounded-xl bg-secondary/70 p-2">
                    <p className="text-[9px] font-bold text-muted-foreground">설정가</p>
                    <p className="mt-1 text-xs font-extrabold">
                      {formatAppPrice(Number.isFinite(target) ? target : null, currency)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-secondary/70 p-2">
                    <p className="text-[9px] font-bold text-muted-foreground">상태</p>
                    <p
                      className={cn(
                        "mt-1 text-xs font-extrabold",
                        active ? "text-positive" : "text-muted-foreground",
                      )}
                    >
                      {active ? "켜짐" : "꺼짐"}
                    </p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <Star className="h-8 w-8 text-muted-foreground" />

      <p className="break-keep text-sm leading-relaxed text-muted-foreground">
        관심종목이 없습니다.
      </p>

      <Link
        href="/search"
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        종목 찾기
      </Link>
    </div>
  );
}

function WatchCard({
  row,
  onOpen,
  onRemove,
}: {
  row: WatchlistItem & AnyObj;
  onOpen: () => void;
  onRemove: (
    event: MouseEvent<HTMLButtonElement>,
    row: WatchlistItem,
  ) => void;
}) {
  const assetType =
    row.assetType ?? (row.market === "US" ? "stockUS" : "stockKR");
  const market = assetType === "stockUS" ? "US" : "KR";
  const currency =
    assetType === "stockUS"
      ? "USD"
      : assetType === "coinFutures"
        ? "USDT"
        : "KRW";
  const name = displayStockName(row.ticker, row.name, market);
  const positive = (row.changePercent ?? 0) >= 0;
  const updatedTime = Date.parse(String(row.updatedAt ?? ""));
  const delayed =
    Number.isFinite(updatedTime) && Date.now() - updatedTime > 60_000;
  const confidenceNumber = Number(row.confidence);
  const confidence =
    Number.isFinite(confidenceNumber)
      ? `${Math.max(
          0,
          Math.min(
            100,
            confidenceNumber <= 1 ? confidenceNumber * 100 : confidenceNumber,
          ),
        ).toFixed(0)}%`
      : "산출 불가";
  const assetLabel =
    assetType === "stockKR"
      ? "국내주식"
      : assetType === "stockUS"
        ? "해외주식"
        : assetType === "coinSpot"
          ? "코인 현물"
          : "코인 선물";

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
      className="cursor-pointer rounded-3xl border border-card-border bg-card p-4 shadow-sm transition active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-keep text-base font-extrabold leading-relaxed">
            {name}
          </h2>

          <p className="mt-0.5 text-xs font-bold text-muted-foreground">
            {assetLabel} · {market === "US" ? `티커 ${row.ticker}` : row.ticker}
          </p>
        </div>

        <button
          type="button"
          onClick={(event) => onRemove(event, row)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-warning bg-warning/10 text-warning"
          aria-label="관심종목 삭제"
        >
          <Star className="h-5 w-5" fill="currentColor" />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-2xl bg-secondary/70 p-2">
          <p className="text-[11px] text-muted-foreground">현재가</p>

          <p className="mt-1 text-sm font-extrabold">
            {formatAppPrice(row.price, currency)}
          </p>
        </div>

        <div className="rounded-2xl bg-secondary/70 p-2">
          <p className="text-[11px] text-muted-foreground">등락률</p>

          <p
            className={cn(
              "mt-1 flex items-center justify-center gap-1 text-sm font-extrabold",
              positive ? "text-positive" : "text-destructive",
            )}
          >
            {positive ? (
              <TrendingUp className="h-3.5 w-3.5" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5" />
            )}

            {formatAppPercent(row.changePercent)}
          </p>
        </div>

        <div className="rounded-2xl border border-card-border bg-secondary/70 p-2">
          <p className="text-[11px] text-muted-foreground">갱신 상태</p>
          <p
            className={cn(
              "mt-1 text-xs font-extrabold",
              delayed ? "text-warning" : "text-positive",
            )}
          >
            {delayed ? "데이터 지연" : String(row.liveStatus ?? "REST 갱신")}
          </p>
        </div>
      </div>

      <TargetPriceRow row={row} />

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-secondary/70 p-2">
          <p className="text-[10px] font-bold text-muted-foreground">최신 AI 방향</p>
          <p className="mt-1 text-xs font-black">
            {String(row.aiDirection ?? "캐시 없음")}
          </p>
        </div>
        <div className="rounded-xl bg-secondary/70 p-2">
          <p className="text-[10px] font-bold text-muted-foreground">최신 신호</p>
          <p className="mt-1 truncate text-xs font-black">
            {String(row.latestSignal ?? "캐시 없음")}
          </p>
        </div>
        <div className="rounded-xl bg-secondary/70 p-2">
          <p className="text-[10px] font-bold text-muted-foreground">신뢰도</p>
          <p className="mt-1 text-xs font-black">{confidence}</p>
        </div>
      </div>
      <p className="mt-2 text-center text-[10px] font-bold text-muted-foreground">
        AI 값은 기존 차트 분석 캐시가 있을 때만 표시하며 추가 분석 요청을 만들지 않습니다.
      </p>
    </article>
  );
}

function TargetPriceRow({ row }: { row: WatchlistItem & AnyObj }) {
  const target = typeof row.targetPrice === "number" ? row.targetPrice : null;
  const [value, setValue] = useState<string>(target != null ? String(target) : "");

  useEffect(() => {
    setValue(target != null ? String(target) : "");
  }, [target]);

  const price = typeof row.price === "number" ? row.price : null;
  const gap =
    target != null && price != null && price > 0
      ? ((target - price) / price) * 100
      : null;

  const save = () => {
    const parsed = Number(value.replace(/,/g, "").trim());
    setWatchlistTargetPrice(
      row.ticker,
      Number.isFinite(parsed) && parsed > 0 ? parsed : null,
    );
  };

  return (
    <div
      className="mt-3 flex items-center gap-2 rounded-2xl bg-secondary/70 px-3 py-2"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      role="presentation"
    >
      <span className="shrink-0 text-[11px] font-bold text-muted-foreground">
        목표가
      </span>

      <input
        inputMode="decimal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
        placeholder="미설정"
        aria-label={`${row.ticker} 목표가`}
        className="min-w-0 flex-1 bg-transparent text-sm font-extrabold outline-none placeholder:font-normal placeholder:text-muted-foreground"
      />

      {gap != null && (
        <span
          className={cn(
            "shrink-0 text-[11px] font-bold",
            gap <= 0 ? "text-positive" : "text-muted-foreground",
          )}
        >
          {gap <= 0 ? "목표 달성!" : `목표까지 +${gap.toFixed(1)}%`}
        </span>
      )}

      <button
        type="button"
        onClick={save}
        className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-xs font-bold text-primary-foreground"
      >
        저장
      </button>

      {target != null && (
        <button
          type="button"
          onClick={() => {
            setValue("");
            setWatchlistTargetPrice(row.ticker, null);
          }}
          className="shrink-0 rounded-lg border border-card-border px-2 py-1 text-xs text-muted-foreground"
          aria-label="목표가 삭제"
        >
          지우기
        </button>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Power, RefreshCw, ShieldAlert } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type Exchange = 'bitget' | 'upbit' | 'kiwoom' | 'toss';
type Market = 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
type StockMarket = 'domestic_stock' | 'us_stock';
type StockBroker = 'kiwoom' | 'toss';
type MarketSwitches = Record<Market, boolean>;
type StockBrokerByMarket = Record<StockMarket, StockBroker>;

type Policy = {
  mode: 'approval' | 'automatic';
  automaticEnabled: boolean;
  emergencyStopped: boolean;
  marketEnabled?: MarketSwitches;
  stockBrokerByMarket?: StockBrokerByMarket;
  exchangeEnabled: Record<Exchange, boolean>;
  enabledAssets: Record<Exchange, string[]>;
  enabledStrategies: string[];
  totalCapitalKrw: number;
  maxOrderKrw: number;
  dailyLossLimitPercent: number;
  maxAssetPercent: number;
  maxOpenPositions: number;
  maxDailyOrders: number;
  maxConsecutiveLosses: number;
  bitgetLeverage: 2 | 3;
};

type UiPolicy = Omit<Policy, 'marketEnabled' | 'stockBrokerByMarket'> & {
  marketEnabled: MarketSwitches;
  stockBrokerByMarket: StockBrokerByMarket;
};

type Status = {
  policy: Policy;
  connections: Array<{
    exchange: Exchange; accountMode: 'paper' | 'mock' | 'live'; configured: boolean;
    lastVerifiedAt: string | null; lastErrorCode: string | null; credentialsExposed: false;
  }>;
  emergencyStopped: boolean;
  credentialVault: { encryptionConfigured: boolean; keyValueExposed: false };
  lastOrder: { exchange: Exchange; state: string; updatedAt: string; lastErrorCode: string | null } | null;
  liveExecutionServerEnabled?: Record<Exchange, boolean>;
  strategyAiReview?: {
    configured: boolean;
    provider: 'google-gemini' | 'groq' | 'openai-compatible' | null;
    model: string | null;
    fallbackConfigured: boolean;
    fallbackProvider: 'google-gemini' | 'groq' | 'openai-compatible' | null;
    fallbackModel: string | null;
    promptVersion: string;
    producer: 'BOUNDED_AI_JSON_PROVIDER';
    failClosed: true;
    cacheEnabled: true;
    cacheSize: number;
    cacheMaxEntries: number;
    cacheHits: number;
    cacheEvictions: number;
    reviewCalls: number;
    pass: number;
    abstain: number;
    veto: number;
    blocked: number;
    unavailable: number;
    lastDecisionAt: string | null;
    providerCalls: number;
    providerSuccesses: number;
    providerFailures: number;
    providerFallbackSuccesses: number;
    providerLastSuccessAt: string | null;
    providerLastErrorAt: string | null;
    providerLastErrorCode: string | null;
    providerLastProvider: 'google-gemini' | 'groq' | 'openai-compatible' | null;
    providerAverageLatencyMs: number | null;
    providerMaxLatencyMs: number | null;
    maxTtlMs: number;
    executionAuthority: 'NONE';
    orderAllowed: false;
    riskOverrideAllowed: false;
  };
  scannerAiReview?: {
    configured: boolean;
    providerSeam: 'BOUNDED_AI_JSON_PROVIDER';
    provider: 'google-gemini' | 'groq' | 'openai-compatible' | null;
    model: string | null;
    fallbackConfigured: boolean;
    fallbackProvider: 'google-gemini' | 'groq' | 'openai-compatible' | null;
    canonicalScannerWired: true;
    maxCandidatesPerRequest: number;
    failSoftForDisplay: true;
    vetoBlocksStrongSignal: true;
    providerCalls: number;
    providerSuccesses: number;
    providerFailures: number;
    providerFallbackSuccesses: number;
    providerLastSuccessAt: string | null;
    providerLastErrorAt: string | null;
    providerLastErrorCode: string | null;
    providerAverageLatencyMs: number | null;
    providerMaxLatencyMs: number | null;
    schedulerPending: number;
    schedulerActive: number;
    schedulerConsecutiveFailures: number;
    schedulerCircuitOpen: boolean;
    schedulerCircuitOpenedAt: number | null;
    schedulerCircuitResetMs: number;
    executionAuthority: 'NONE';
    orderAllowed: false;
    positionSizeAuthority: false;
    leverageAuthority: false;
  };
  pilotCapitalState?: {
    initialOperatingCapitalKrw: number;
    operatingCapitalKrw: number;
    reserveKrw: number;
    highWaterMarkKrw: number;
    maxEntryKrw: number;
    realizedNetPnlKrw: number;
    compoundedProfitKrw: number;
    dailyRealizedPnlKrw: number;
    dailyLosingTrades: number;
    consecutiveLosses: number;
    settlementReady: boolean;
    blockers: string[];
    reserveWithdrawalAutomatic: false;
  };
  evidenceBackedStrategies?: Array<{
    strategyId: string;
    label: string;
    markets: Array<'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES'>;
    directions: Array<'BUY' | 'LONG' | 'SHORT'>;
    summary: string;
    rules: string[];
    paperResearchAllowedWhenReady: true;
    pilotProfile: {
      mode: 'PAPER_MIRROR_MANUAL_LIVE_CONFIRM';
      initialOperatingCapitalKrw: number;
      profitCompoundShare: 0.5;
      profitReserveShare: 0.5;
      maxEntryTracksOperatingCapital: true;
      reserveAutoWithdrawalAllowed: false;
      highWaterMarkRequired: true;
      riskPerTradePercentCeiling: 0.5;
      maxConcurrentLivePositions: number;
      maxDailyLiveEntries: null;
      maxDailyLosingTrades: number;
      dailyLossStopKrw: number;
      maxConsecutiveLosses: number;
      lossCooldownMinutes: number;
      sameSymbolReentryRequiresFreshSignal: true;
      futuresMaxLeverage: 3;
      paperMirrorRequired: true;
      pairedFillComparisonRequired: true;
      liveOrderRequiresExplicitConfirmation: true;
      automaticLiveExecutionAllowed: false;
    };
    automaticLivePromotionAllowed: false;
    promotionRequirements: string[];
  }>;
};

const EXCHANGE_LABELS: Record<Exchange, string> = {
  bitget: 'Bitget 코인선물',
  upbit: 'Upbit 코인현물',
  kiwoom: 'Kiwoom 주식 실행 연결',
  toss: 'Toss 주식 실행 연결',
};

const STOCK_BROKER_LABELS: Record<StockBroker, string> = {
  kiwoom: 'Kiwoom',
  toss: 'Toss',
};

const MARKET_LABELS: Record<Market, string> = {
  domestic_stock: '국내주식',
  us_stock: '미국주식',
  crypto_spot: '코인현물',
  crypto_futures: '코인선물',
};

const MARKET_DESCRIPTIONS: Record<Market, string> = {
  domestic_stock: '모의 + 거래키·서버게이트 충족 시 Toss/Kiwoom 실전',
  us_stock: '모의 + 거래키·서버게이트 충족 시 Toss/Kiwoom 실전',
  crypto_spot: 'Upbit 고정 · 모의매매 지원',
  crypto_futures: 'Bitget 고정 · LONG/SHORT, 2~3배 제한',
};

const DEFAULT_MARKETS: MarketSwitches = {
  domestic_stock: true,
  us_stock: true,
  crypto_spot: true,
  crypto_futures: true,
};

const DEFAULT_POLICY: UiPolicy = {
  mode: 'automatic',
  automaticEnabled: false,
  emergencyStopped: false,
  marketEnabled: DEFAULT_MARKETS,
  stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'kiwoom' },
  exchangeEnabled: { bitget: true, upbit: true, kiwoom: true, toss: false },
  enabledAssets: { bitget: [], upbit: [], kiwoom: [], toss: [] },
  enabledStrategies: [],
  totalCapitalKrw: 1_000_000,
  maxOrderKrw: 1_000_000,
  dailyLossLimitPercent: 5,
  maxAssetPercent: 30,
  maxOpenPositions: 5,
  maxDailyOrders: 10,
  maxConsecutiveLosses: 3,
  bitgetLeverage: 2,
};

function normalizeUiPolicy(policy?: Policy | null): UiPolicy {
  if (!policy) return DEFAULT_POLICY;
  const marketEnabled = policy.marketEnabled ?? {
    domestic_stock: policy.exchangeEnabled.kiwoom,
    us_stock: policy.exchangeEnabled.kiwoom,
    crypto_spot: policy.exchangeEnabled.upbit,
    crypto_futures: policy.exchangeEnabled.bitget,
  };
  const stockBrokerByMarket: StockBrokerByMarket = {
    domestic_stock: policy.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom',
    us_stock: policy.stockBrokerByMarket?.us_stock === 'toss' ? 'toss' : 'kiwoom',
  };
  return {
    ...policy,
    mode: 'automatic',
    marketEnabled,
    stockBrokerByMarket,
    exchangeEnabled: {
      bitget: marketEnabled.crypto_futures,
      upbit: marketEnabled.crypto_spot,
      kiwoom: (marketEnabled.domestic_stock && stockBrokerByMarket.domestic_stock === 'kiwoom')
        || (marketEnabled.us_stock && stockBrokerByMarket.us_stock === 'kiwoom'),
      toss: (marketEnabled.domestic_stock && stockBrokerByMarket.domestic_stock === 'toss')
        || (marketEnabled.us_stock && stockBrokerByMarket.us_stock === 'toss'),
    },
    enabledAssets: {
      bitget: policy.enabledAssets.bitget ?? [],
      upbit: policy.enabledAssets.upbit ?? [],
      kiwoom: policy.enabledAssets.kiwoom ?? [],
      toss: policy.enabledAssets.toss ?? [],
    },
  };
}

function exchangesForMarkets(
  markets: MarketSwitches,
  brokers: StockBrokerByMarket,
): Record<Exchange, boolean> {
  return {
    bitget: markets.crypto_futures,
    upbit: markets.crypto_spot,
    kiwoom: (markets.domestic_stock && brokers.domestic_stock === 'kiwoom')
      || (markets.us_stock && brokers.us_stock === 'kiwoom'),
    toss: (markets.domestic_stock && brokers.domestic_stock === 'toss')
      || (markets.us_stock && brokers.us_stock === 'toss'),
  };
}

export function TradeAutomationSettings({ fixture, selectedMarket }: { fixture?: Status; selectedMarket?: Market }) {
  const [status, setStatus] = useState<Status | null>(fixture ?? null);
  const [draft, setDraft] = useState<UiPolicy>(() => normalizeUiPolicy(fixture?.policy));
  const [loading, setLoading] = useState(!fixture);
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);

  async function load() {
    if (fixture) return;
    setLoading(true);
    try {
      const response = await authorizedFetch('/api/trade-automation/status');
      const payload = await response.json() as Status & { ok?: boolean; status?: string; error?: string };
      if (!response.ok || payload.ok === false) {
        const message = payload.status === 'UNAVAILABLE'
          ? '자동매매 상태 저장소를 확인할 수 없습니다. 주문 실행 없이 안전하게 차단했습니다.'
          : (payload.error ?? '설정을 불러오지 못했습니다.');
        throw new Error(message);
      }
      setStatus(payload);
      setDraft(normalizeUiPolicy(payload.policy));
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설정을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function updateNumber(key: keyof UiPolicy, value: string) {
    setDraft((current) => ({ ...current, [key]: Number(value) }));
  }

  function toggleAutomatic() {
    setDraft((current) => ({
      ...current,
      mode: 'automatic',
      automaticEnabled: !current.automaticEnabled,
      emergencyStopped: false,
    }));
  }

  function toggleStrategy(strategyId: string) {
    setDraft((current) => {
      const selected = current.enabledStrategies.includes(strategyId);
      return {
        ...current,
        enabledStrategies: selected
          ? current.enabledStrategies.filter((item) => item !== strategyId)
          : [...current.enabledStrategies, strategyId],
      };
    });
  }

  function toggleMarket(market: Market) {
    setDraft((current) => {
      const marketEnabled = { ...current.marketEnabled, [market]: !current.marketEnabled[market] };
      return {
        ...current,
        mode: 'automatic',
        marketEnabled,
        exchangeEnabled: exchangesForMarkets(marketEnabled, current.stockBrokerByMarket),
      };
    });
  }

  function selectStockBroker(market: StockMarket, broker: StockBroker) {
    setDraft((current) => {
      const stockBrokerByMarket = { ...current.stockBrokerByMarket, [market]: broker };
      return {
        ...current,
        stockBrokerByMarket,
        exchangeEnabled: exchangesForMarkets(current.marketEnabled, stockBrokerByMarket),
      };
    });
  }

  async function save(confirmed: boolean) {
    const outbound: UiPolicy = {
      ...draft,
      mode: 'automatic',
      exchangeEnabled: exchangesForMarkets(draft.marketEnabled, draft.stockBrokerByMarket),
    };
    if (fixture) {
      setDraft(outbound);
      setStatus((current) => current ? { ...current, policy: outbound } : current);
      setMessage('테스트 설정이 저장되었습니다.');
      setConfirming(false);
      return;
    }
    try {
      const response = await authorizedFetch('/api/trade-automation/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...outbound, confirmation: { acknowledged: confirmed } }),
      });
      const payload = await response.json() as { policy?: Policy; error?: string };
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? '저장하지 못했습니다.');
      const normalized = normalizeUiPolicy(payload.policy);
      setDraft(normalized);
      setStatus((current) => current ? { ...current, policy: payload.policy! } : current);
      setMessage(normalized.automaticEnabled
        ? '자동매매가 켜졌습니다. 활성 시장의 새 신호는 주문별 승인 없이 위험검사를 통과하면 자동 처리됩니다.'
        : '자동매매 설정을 저장했습니다. 현재 자동 실행은 꺼져 있습니다.');
      setConfirming(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '저장하지 못했습니다.');
    }
  }

  async function emergencyStop() {
    const stoppedMarkets: MarketSwitches = {
      domestic_stock: false,
      us_stock: false,
      crypto_spot: false,
      crypto_futures: false,
    };
    if (fixture) {
      setDraft((current) => ({
        ...current,
        mode: 'automatic',
        automaticEnabled: false,
        emergencyStopped: true,
        marketEnabled: stoppedMarkets,
        exchangeEnabled: exchangesForMarkets(stoppedMarkets, current.stockBrokerByMarket),
      }));
      setMessage('비상정지: 4시장 신규 주문이 모두 차단되었습니다.');
      return;
    }
    const response = await authorizedFetch('/api/trade-automation/emergency-stop', { method: 'POST' });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setMessage(payload.error ?? '비상정지에 실패했습니다.');
      return;
    }
    setDraft((current) => ({
      ...current,
      mode: 'automatic',
      automaticEnabled: false,
      emergencyStopped: true,
      marketEnabled: stoppedMarkets,
      exchangeEnabled: exchangesForMarkets(stoppedMarkets, current.stockBrokerByMarket),
    }));
    setMessage('비상정지: 4시장 신규 주문이 모두 차단되었습니다.');
  }

  const connections = Object.fromEntries(
    (status?.connections ?? []).map((item) => [item.exchange, item]),
  ) as Partial<Record<Exchange, Status['connections'][number]>>;
  const activeMarkets = (Object.keys(MARKET_LABELS) as Market[]).filter((market) => draft.marketEnabled[market]);
  const visibleMarkets: Market[] = selectedMarket ? [selectedMarket] : (Object.keys(MARKET_LABELS) as Market[]);
  const visibleExchanges: Exchange[] = selectedMarket === 'crypto_futures'
    ? ['bitget']
    : selectedMarket === 'crypto_spot'
      ? ['upbit']
      : selectedMarket === 'domestic_stock' || selectedMarket === 'us_stock'
        ? [draft.stockBrokerByMarket[selectedMarket]]
        : (Object.keys(EXCHANGE_LABELS) as Exchange[]);

  return <section className="rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm" data-testid="trade-automation-settings">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-extrabold">자동매매 설정</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          주문별 승인은 사용하지 않습니다. 저장된 자동매매 정책과 시장 ON/OFF, 매 주문 위험검사를 모두 통과한 신호만 실행합니다.
        </p>
      </div>
      <button type="button" onClick={() => void load()} aria-label="거래 설정 새로고침" className="rounded-xl border border-card-border p-2">
        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
      </button>
    </div>

    <button
      type="button"
      onClick={toggleAutomatic}
      className="mt-4 flex w-full items-center justify-between rounded-2xl border border-card-border bg-background p-4"
      data-testid="automatic-trading-master-toggle"
      aria-pressed={draft.automaticEnabled}
    >
      <span>
        <span className="block text-sm font-extrabold">자동매매</span>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {draft.automaticEnabled ? '켜짐 · 활성 시장의 적격 신호를 자동 처리' : '꺼짐 · 신호를 주문으로 자동 전환하지 않음'}
        </span>
      </span>
      <Switch active={draft.automaticEnabled} />
    </button>

    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="시장별 자동매매">
      {visibleMarkets.map((market) => (
        <button
          key={market}
          type="button"
          onClick={() => toggleMarket(market)}
          className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-card-border bg-background p-3 text-left"
          data-testid={`auto-market-${market}`}
          aria-pressed={draft.marketEnabled[market]}
        >
          <span className="min-w-0">
            <span className="block text-xs font-extrabold">{MARKET_LABELS[market]}</span>
            <span className="mt-1 block break-keep text-[10px] leading-4 text-muted-foreground">{MARKET_DESCRIPTIONS[market]}</span>
          </span>
          <Switch active={draft.marketEnabled[market]} />
        </button>
      ))}
    </div>

    {!selectedMarket || selectedMarket === 'domestic_stock' || selectedMarket === 'us_stock' ? <div className="mt-4 rounded-2xl border border-card-border bg-background p-3" data-testid="stock-broker-routing">
      <p className="text-xs font-extrabold">주식 증권사 선택</p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        국내·미국주식은 사용자마다 Toss 또는 Kiwoom을 선택합니다. 코인현물은 Upbit, 코인선물은 Bitget으로 고정됩니다.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {((selectedMarket === 'domestic_stock' || selectedMarket === 'us_stock') ? [selectedMarket] : ['domestic_stock', 'us_stock'] as StockMarket[]).map((market) => (
          <label key={market} className="rounded-xl border border-card-border bg-card p-3 text-xs font-extrabold">
            {MARKET_LABELS[market]} 증권사
            <select
              data-testid={`stock-broker-${market}`}
              aria-label={`${MARKET_LABELS[market]} 증권사`}
              value={draft.stockBrokerByMarket[market]}
              onChange={(event) => selectStockBroker(market, event.target.value === 'toss' ? 'toss' : 'kiwoom')}
              className="mt-2 h-10 w-full rounded-xl border border-card-border bg-background px-3 text-xs"
            >
              <option value="kiwoom">Kiwoom</option>
              <option value="toss">Toss</option>
            </select>
          </label>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 text-[11px] font-semibold text-muted-foreground">
        <p className="rounded-xl bg-secondary/60 p-2">코인현물 · Upbit 고정</p>
        <p className="rounded-xl bg-secondary/60 p-2">코인선물 · Bitget 고정</p>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
        실전 주문은 거래용 키 저장, 사용자 정책, 서버 provider 게이트, 주문 직전 Risk 재검증을 모두 통과해야 합니다. 키 저장만으로 실주문은 켜지지 않습니다.
      </p>
    </div> : null}

    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {visibleExchanges.map((exchange) => {
        const connection = connections[exchange];
        return <div key={exchange} className="rounded-2xl border border-card-border bg-background p-3" data-testid={`connection-${exchange}`}>
          <div className="flex items-center gap-2">
            {connection?.configured
              ? <CheckCircle2 className="h-4 w-4 text-positive" />
              : <AlertTriangle className="h-4 w-4 text-warning" />}
            <span className="text-xs font-extrabold">{EXCHANGE_LABELS[exchange]}</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {connection?.configured
              ? `${connection.accountMode === 'live' ? '실전 거래키 저장됨' : connection.accountMode === 'mock' ? '모의' : 'Paper'} · ${status?.liveExecutionServerEnabled?.[exchange] ? '서버게이트 ON' : '서버게이트 OFF'}`
              : '거래키 미연결 · 모의매매는 가능'}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">API 키 값은 화면에 표시하지 않습니다.</p>
        </div>;
      })}
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {visibleExchanges.map((exchange) => (
        <label key={exchange} className="rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">
          {EXCHANGE_LABELS[exchange]} 허용 종목
          <input
            aria-label={`${EXCHANGE_LABELS[exchange]} 허용 자산`}
            value={draft.enabledAssets[exchange].join(', ')}
            onChange={(event) => setDraft((value) => ({
              ...value,
              enabledAssets: {
                ...value.enabledAssets,
                [exchange]: event.target.value.split(',').map((item) => item.trim()).filter(Boolean),
              },
            }))}
            placeholder={exchange === 'kiwoom' || exchange === 'toss' ? '비우면 전체 · 005930, AAPL' : '비우면 전체 · BTC, ETH'}
            className="mt-2 h-10 w-full rounded-xl border border-card-border bg-card px-2 text-xs"
          />
        </label>
      ))}
    </div>

    <div className="mt-4 grid grid-cols-2 gap-2">
      <NumberField label="총 운용금액" value={draft.totalCapitalKrw} onChange={(value) => updateNumber('totalCapitalKrw', value)} suffix="원" />
      <NumberField label="1회 주문금액" value={draft.maxOrderKrw} onChange={(value) => updateNumber('maxOrderKrw', value)} suffix="원" />
      <NumberField label="최대 보유비중" value={draft.maxAssetPercent} onChange={(value) => updateNumber('maxAssetPercent', value)} suffix="%" />
      <NumberField label="일일 손실한도" value={draft.dailyLossLimitPercent} onChange={(value) => updateNumber('dailyLossLimitPercent', value)} suffix="%" />
      <NumberField label="동시 보유 수" value={draft.maxOpenPositions} onChange={(value) => updateNumber('maxOpenPositions', value)} suffix="개" />
      <NumberField label="일일 주문 수" value={draft.maxDailyOrders} onChange={(value) => updateNumber('maxDailyOrders', value)} suffix="회" />
      <NumberField label="연속 손실 제한" value={draft.maxConsecutiveLosses} onChange={(value) => updateNumber('maxConsecutiveLosses', value)} suffix="회" />
    </div>

    {(status?.evidenceBackedStrategies?.length ?? 0) > 0 ? <div className="mt-4 rounded-2xl border border-card-border bg-background p-3" data-testid="strategy-ai-review-status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-extrabold">6전략 AI Review 연결</p>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            결정론적 Evidence 통과 후에만 AI를 호출하며, 실패·만료·신원 불일치·형식 오류는 신규 진입을 차단합니다.
          </p>
        </div>
        <span className={cn(
          'rounded-full border px-2 py-1 text-[10px] font-black',
          status?.strategyAiReview?.configured
            ? 'border-positive/30 bg-positive/10 text-positive'
            : 'border-warning/30 bg-warning/10 text-warning',
        )}>
          {status?.strategyAiReview?.configured ? 'AI 연결 준비됨' : 'AI Provider 미설정 · FAIL-CLOSED'}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <dt className="font-bold">Provider</dt><dd>{status?.strategyAiReview?.provider ?? '미설정'} · {status?.strategyAiReview?.model ?? '모델 미설정'}</dd>
        <dt className="font-bold">Fallback</dt><dd>{status?.strategyAiReview?.fallbackConfigured ? `${status.strategyAiReview.fallbackProvider ?? '구성됨'} / ${status.strategyAiReview.fallbackModel ?? '기본모델'}` : '없음'}</dd>
        <dt className="font-bold">Provider Health</dt><dd>호출 {status?.strategyAiReview?.providerCalls ?? 0} · 성공 {status?.strategyAiReview?.providerSuccesses ?? 0} · 실패 {status?.strategyAiReview?.providerFailures ?? 0} · Fallback {status?.strategyAiReview?.providerFallbackSuccesses ?? 0}</dd>
        <dt className="font-bold">최근 성공</dt><dd>{status?.strategyAiReview?.providerLastSuccessAt ?? '아직 없음'}{status?.strategyAiReview?.providerAverageLatencyMs != null ? ` · 평균 ${status.strategyAiReview.providerAverageLatencyMs}ms / 최대 ${status.strategyAiReview.providerMaxLatencyMs ?? 0}ms` : ''}</dd>
        <dt className="font-bold">최근 오류</dt><dd>{status?.strategyAiReview?.providerLastErrorCode ?? '없음'}{status?.strategyAiReview?.providerLastErrorAt ? ` · ${status.strategyAiReview.providerLastErrorAt}` : ''}</dd>
        <dt className="font-bold">판정</dt><dd>PASS {status?.strategyAiReview?.pass ?? 0} · ABSTAIN {status?.strategyAiReview?.abstain ?? 0} · VETO {status?.strategyAiReview?.veto ?? 0} · 차단 {status?.strategyAiReview?.blocked ?? 0} · 공급불가 {status?.strategyAiReview?.unavailable ?? 0}</dd>
        <dt className="font-bold">Cache</dt><dd>{status?.strategyAiReview?.cacheSize ?? 0}/{status?.strategyAiReview?.cacheMaxEntries ?? 0} · hit {status?.strategyAiReview?.cacheHits ?? 0} · eviction {status?.strategyAiReview?.cacheEvictions ?? 0}</dd>
        <dt className="font-bold">Scanner AI</dt><dd>{status?.scannerAiReview?.configured ? '연결됨' : '미설정'} · circuit {status?.scannerAiReview?.schedulerCircuitOpen ? 'OPEN' : 'CLOSED'} · active {status?.scannerAiReview?.schedulerActive ?? 0} · pending {status?.scannerAiReview?.schedulerPending ?? 0}</dd>
        <dt className="font-bold">TTL</dt><dd>최대 {Math.round((status?.strategyAiReview?.maxTtlMs ?? 0) / 1000)}초</dd>
        <dt className="font-bold">Live AI 정책</dt><dd>PASS-only 사전계약 · 현재 6전략 자동 Live는 비활성</dd>
        <dt className="font-bold">권한</dt><dd>주문 없음 · Risk override 없음 · 실행권한 NONE</dd>
      </dl>
    </div> : null}

    {(status?.evidenceBackedStrategies?.length ?? 0) > 0 ? <div className="mt-4 rounded-2xl border border-card-border bg-background p-3" data-testid="strategy-rule-pack-cards">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-extrabold">수식·파동·보조지표·AI 룰팩</p>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            50만원 소액 실전 검증 프로필입니다. Paper는 자동으로 병행하고, 실계좌는 같은 신호의 주문안을 만들어 최종 확인 후 실행하는 방식으로 비교합니다.
          </p>
        </div>
        <ShieldAlert className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
        {status!.evidenceBackedStrategies!.map((strategy) => {
          const selected = draft.enabledStrategies.includes(strategy.strategyId);
          return <button
            key={strategy.strategyId}
            type="button"
            onClick={() => toggleStrategy(strategy.strategyId)}
            className="rounded-xl border border-card-border bg-card p-3 text-left"
            data-testid={'strategy-rule-pack-' + strategy.strategyId}
            aria-pressed={selected}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold">{strategy.label}</span>
              <span className="rounded-full border border-card-border px-2 py-0.5 text-[10px] font-bold">
                {selected ? '선택됨' : '대기'}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{strategy.summary}</p>
            <p className="mt-2 text-[10px] font-bold text-muted-foreground">
              Paper 자동 · 초기 운용금 {strategy.pilotProfile.initialOperatingCapitalKrw.toLocaleString('ko-KR')}원 · 신규 순이익 50% 복리 / 50% Reserve
            </p>
          </button>;
        })}
      </div>
    </div> : null}

    {(status?.evidenceBackedStrategies?.length ?? 0) > 0 ? <div className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs" data-testid="strategy-pilot-risk-summary">
      <p className="font-extrabold">50만원 실전 검증 방식</p>
      <p className="mt-1 leading-5 text-muted-foreground">
        최대 진입은 현재 운용금과 함께 증가 · 손절거리 Risk Size가 더 작으면 그 이하만 허용 · 거래당 위험은 운용금의 최대 0.5% · 동시 2개 · 조건이 좋으면 하루 진입 횟수 제한 없음 · 하루 손실거래 5회 중지 · 연속 3회 손실 시 중지 · 동일 종목 손실 후 30분 + 새 신호 필요 · 비상 일손실 2.5만원 · 선물 3배(위험예산 증액 금지) · Paper 동시 기록 · Reserve 자동출금 금지 · 실계좌 주문은 최종 확인 필요
      </p>
    </div> : null}

    {status?.pilotCapitalState ? <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="strategy-pilot-capital-state">
      <div className="rounded-xl border border-card-border bg-background p-3">
        <p className="text-[10px] text-muted-foreground">현재 운용금</p>
        <p className="mt-1 text-xs font-extrabold">{status.pilotCapitalState.operatingCapitalKrw.toLocaleString('ko-KR')}원</p>
      </div>
      <div className="rounded-xl border border-card-border bg-background p-3">
        <p className="text-[10px] text-muted-foreground">최대 진입 상한</p>
        <p className="mt-1 text-xs font-extrabold">{status.pilotCapitalState.maxEntryKrw.toLocaleString('ko-KR')}원</p>
      </div>
      <div className="rounded-xl border border-card-border bg-background p-3">
        <p className="text-[10px] text-muted-foreground">Reserve</p>
        <p className="mt-1 text-xs font-extrabold">{status.pilotCapitalState.reserveKrw.toLocaleString('ko-KR')}원</p>
      </div>
      <div className="rounded-xl border border-card-border bg-background p-3">
        <p className="text-[10px] text-muted-foreground">High-Water Mark</p>
        <p className="mt-1 text-xs font-extrabold">{status.pilotCapitalState.highWaterMarkKrw.toLocaleString('ko-KR')}원</p>
      </div>
    </div> : null}

    <label className="mt-3 block rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">
      허용 전략
      <input
        aria-label="허용 전략"
        value={draft.enabledStrategies.join(', ')}
        onChange={(event) => setDraft((value) => ({
          ...value,
          enabledStrategies: event.target.value.split(',').map((item) => item.trim()).filter(Boolean),
        }))}
        placeholder="비우면 위험검사를 통과한 전략 전체 · 예: trend-breakout-v1"
        className="mt-2 h-11 w-full rounded-xl border border-card-border bg-card px-3 text-sm"
      />
    </label>

    {!selectedMarket || selectedMarket === 'crypto_futures' ? <label className="mt-3 block rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">
      Bitget 레버리지
      <select
        aria-label="Bitget 레버리지"
        value={draft.bitgetLeverage}
        onChange={(event) => setDraft((value) => ({
          ...value,
          bitgetLeverage: Number(event.target.value) === 3 ? 3 : 2,
        }))}
        className="mt-2 h-11 w-full rounded-xl border border-card-border bg-card px-3"
      >
        <option value="2">2배 (기본)</option>
        <option value="3">3배</option>
      </select>
    </label> : null}

    <div className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs">
      <p className="font-extrabold">마지막 주문 · 체결 · 오류</p>
      <p className="mt-1 text-muted-foreground" data-testid="last-trade-state">
        {status?.lastOrder
          ? `${EXCHANGE_LABELS[status.lastOrder.exchange]} · ${status.lastOrder.state}${status.lastOrder.lastErrorCode ? ` · ${status.lastOrder.lastErrorCode}` : ''}`
          : '주문 기록 없음'}
      </p>
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <button type="button" onClick={() => setConfirming(true)} className="rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground">
        설정 저장
      </button>
      <button type="button" onClick={() => void emergencyStop()} className="flex items-center justify-center gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-extrabold text-destructive">
        <Power className="h-4 w-4" />긴급정지
      </button>
    </div>

    {message && <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p>}

    {confirming && <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="자동매매 설정 확인">
      <div className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2 text-destructive">
          <ShieldAlert className="h-6 w-6" />
          <h3 className="text-lg font-black">자동매매 상시 권한 설정</h3>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          이 확인은 주문마다 묻는 승인이 아닙니다. 저장 후에는 자동매매가 켜진 시장에서 적격 신호가 발생할 때마다 시장·비용·위험·손실한도를 다시 검사한 뒤 자동 처리합니다.
        </p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="font-bold">자동 실행</dt><dd>{draft.automaticEnabled ? '켜짐' : '꺼짐'}</dd>
          <dt className="font-bold">활성 시장</dt><dd>{activeMarkets.map((market) => MARKET_LABELS[market]).join(', ') || '없음'}</dd>
          <dt className="font-bold">최대 주문</dt><dd>{draft.maxOrderKrw.toLocaleString('ko-KR')}원</dd>
          <dt className="font-bold">일일 손실</dt><dd>-{draft.dailyLossLimitPercent}% 도달 시 차단</dd>
          <dt className="font-bold">레버리지</dt><dd>Bitget 최대 {draft.bitgetLeverage}배</dd>
          <dt className="font-bold">허용 전략</dt><dd>{draft.enabledStrategies.join(', ') || '위험검사 통과 전략 전체'}</dd>
          <dt className="font-bold">국내주식 증권사</dt><dd>{STOCK_BROKER_LABELS[draft.stockBrokerByMarket.domestic_stock]}</dd>
          <dt className="font-bold">미국주식 증권사</dt><dd>{STOCK_BROKER_LABELS[draft.stockBrokerByMarket.us_stock]}</dd>
          <dt className="font-bold">코인현물</dt><dd>Upbit 고정</dd>
          <dt className="font-bold">코인선물</dt><dd>Bitget 고정</dd>
          <dt className="font-bold">실전주문</dt><dd>거래키 + provider 서버게이트 + 주문 직전 Risk Gate 모두 필요</dd>
          <dt className="font-bold">긴급정지</dt><dd>누르면 4시장 신규 주문 즉시 OFF</dd>
        </dl>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setConfirming(false)} className="rounded-2xl border border-card-border px-4 py-3 font-extrabold">취소</button>
          <button type="button" onClick={() => void save(true)} className="rounded-2xl bg-destructive px-4 py-3 font-extrabold text-white">설정 적용</button>
        </div>
      </div>
    </div>}
  </section>;
}

function Switch({ active }: { active: boolean }) {
  return <span className={cn('h-6 w-11 shrink-0 rounded-full p-1 transition-colors', active ? 'bg-primary' : 'bg-muted')}>
    <span className={cn('block h-4 w-4 rounded-full bg-background transition-transform', active && 'translate-x-5')} />
  </span>;
}

function NumberField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (value: string) => void; suffix: string }) {
  return <label className="rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">
    {label}
    <span className="mt-2 flex items-center gap-1">
      <input type="number" min="0" value={value} onChange={(event) => onChange(event.target.value)} className="h-10 min-w-0 flex-1 rounded-xl border border-card-border bg-card px-2 text-right text-sm font-bold" />
      <span>{suffix}</span>
    </span>
  </label>;
}

export type { Status as TradeAutomationStatus };

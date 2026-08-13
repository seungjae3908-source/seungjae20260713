import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, LockKeyhole, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

export type AutoTradingV2Mode = 'OFF' | 'PAPER' | 'SHADOW' | 'LIVE';

type RuntimeConfig = {
  mode: Exclude<AutoTradingV2Mode, 'LIVE'>;
  equityKrw: number;
  riskPerTradePercent: number;
  leverage: number;
  stopMode: 'FIXED_STOP' | 'ATR_STOP';
  atrMultiplier: number;
  dailyPnlPercent: number;
  weeklyDrawdownPercent: number;
  consecutiveLosses: number;
  safeHalt: boolean;
  newEntryDisabled: boolean;
  haltReasons: string[];
  updatedAt: string;
};

type Position = {
  mode: 'PAPER' | 'SHADOW';
  symbol: string;
  direction: 'LONG' | 'SHORT';
  status: 'ACTIVE' | 'CLOSED';
  strategyId: string;
  strategyVersion: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  trailingStop: number | null;
  notionalKrw: number;
  requiredMarginKrw: number;
  leverage: number;
  riskPerTradePercent: number;
  realizedPnlKrw: number;
  unrealizedPnlKrw: number;
  fundingCostKrw: number;
  positionProtected: boolean;
  updatedAt: string;
};

type Snapshot = {
  symbol: string;
  observedAt: string;
  markPrice: number;
  indexPrice: number;
  spreadPercent: number;
  markIndexDislocationPercent: number;
  fundingRate: number;
  btc1dClose: number;
  btc1dMa20: number;
  btc1hClose: number;
  btc1hMa20: number;
  symbol1hClose: number;
  symbol1hMa20: number;
  atrPercent: number;
  expansionRvolPercent: number;
  volumeContraction: boolean;
  pullbackDistancePercent: number;
  continuationLong: boolean;
  continuationShort: boolean;
  dataStale: boolean;
};

type LatestRecord = {
  kind: string;
  id: string;
  updatedAt: string;
  payload: Record<string, unknown>;
};

export type AutoTradingV2Status = {
  ok: boolean;
  autoTradingUi: true;
  paperTrading: true;
  shadowTrading: true;
  liveTrading: false;
  liveLocked: true;
  privateTradingApiAllowed: false;
  realOrderCount: 0;
  realCancelCount: 0;
  privateTradingApiCount: 0;
  config: RuntimeConfig;
  effectiveMode: Exclude<AutoTradingV2Mode, 'LIVE'>;
  strategy: {
    id: string;
    version: string;
    eligibility: string;
    parameterSelection: string;
    rvolCandidatesPercent: readonly number[];
    selectedRvolPercent: number;
    researchOnlyProfitClaim: false;
  };
  supportedSymbols: readonly string[];
  marginMode: 'ISOLATED';
  leverageCap: number;
  positions: Position[];
  reconciliation: {
    state: 'SAFE' | 'SAFE_HALT';
    tradingEnabled: boolean;
    reasons: string[];
    privateTradingApiCount: 0;
  };
  latest: LatestRecord[];
  health: {
    app: string;
    marketData: string;
    signalEngine: string;
    riskEngine: string;
    executionEngine: string;
    reconciliation: string;
    database: string;
    telegram: string;
    overall: 'UP' | 'DEGRADED';
  };
};

export type AutoTradingV2Fixture = {
  status: AutoTradingV2Status;
  snapshots: Snapshot[];
};

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;

function number(value: number | null | undefined, maximumFractionDigits = 2) {
  if (value == null || !Number.isFinite(value)) return '-';
  return value.toLocaleString('ko-KR', { maximumFractionDigits });
}

function percent(value: number | null | undefined, digits = 3) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(digits)}%`;
}

function regime(snapshot: Snapshot | null) {
  if (!snapshot) return 'UNKNOWN';
  if (snapshot.btc1dClose > snapshot.btc1dMa20 && snapshot.btc1hClose > snapshot.btc1hMa20) return 'LONG_ONLY';
  if (snapshot.btc1dClose < snapshot.btc1dMa20 && snapshot.btc1hClose < snapshot.btc1hMa20) return 'SHORT_ONLY';
  return 'NO_TRADE';
}

function signalFor(status: AutoTradingV2Status | null, symbol: string) {
  const record = status?.latest.find((item) => item.payload.recordType === 'auto_trading_v2_signal' && item.payload.symbol === symbol);
  if (!record) return null;
  return {
    direction: typeof record.payload.direction === 'string' ? record.payload.direction : null,
    allowed: record.payload.allowed === true,
    blockReasons: Array.isArray(record.payload.blockReasons) ? record.payload.blockReasons.map(String) : [],
    observedAt: typeof record.payload.observedAt === 'string' ? record.payload.observedAt : record.updatedAt,
  };
}

function ModeButton({
  mode,
  active,
  disabled,
  onClick,
}: {
  mode: AutoTradingV2Mode;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const label = mode === 'OFF' ? 'OFF' : mode === 'PAPER' ? 'PAPER' : mode === 'SHADOW' ? 'SHADOW' : 'LIVE';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={`auto-trading-v2-mode-${mode.toLowerCase()}`}
      className={cn(
        'min-h-12 rounded-2xl border px-3 py-2 text-xs font-black transition',
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background',
        disabled && 'cursor-not-allowed opacity-45',
      )}
    >
      <span className="flex items-center justify-center gap-1.5">
        {mode === 'LIVE' ? <LockKeyhole className="h-3.5 w-3.5" /> : null}
        {label}
      </span>
      <span className="mt-0.5 block text-[9px] font-bold opacity-75">
        {mode === 'OFF' ? '중지' : mode === 'PAPER' ? '가상체결' : mode === 'SHADOW' ? '실시장 추적' : 'LOCKED'}
      </span>
    </button>
  );
}

export function AutoTradingV2Panel({ fixture }: { fixture?: AutoTradingV2Fixture }) {
  const [status, setStatus] = useState<AutoTradingV2Status | null>(fixture?.status ?? null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>(fixture?.snapshots ?? []);
  const [loading, setLoading] = useState(!fixture);
  const [actionBusy, setActionBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pollBusy = useRef(false);

  const load = useCallback(async () => {
    if (fixture) return;
    setLoading(true);
    try {
      const [statusResponse, marketResponse] = await Promise.all([
        authorizedFetch('/api/trade-automation/v2/status'),
        authorizedFetch('/api/trade-automation/v2/market'),
      ]);
      const statusPayload = await statusResponse.json() as AutoTradingV2Status & { error?: string };
      const marketPayload = await marketResponse.json() as { ok: boolean; snapshots?: Snapshot[]; error?: string };
      if (!statusResponse.ok || !statusPayload.ok) throw new Error(statusPayload.error ?? 'Auto Trading 상태를 불러오지 못했습니다.');
      setStatus(statusPayload);
      if (marketResponse.ok && marketPayload.ok && Array.isArray(marketPayload.snapshots)) setSnapshots(marketPayload.snapshots);
      setMessage(marketResponse.ok ? '' : marketPayload.error ?? '공개 시장 데이터가 일시적으로 지연되고 있습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Auto Trading 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [fixture]);

  const tick = useCallback(async () => {
    if (fixture || pollBusy.current) return;
    pollBusy.current = true;
    try {
      const response = await authorizedFetch('/api/trade-automation/v2/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: SYMBOLS }),
      });
      const payload = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? 'Paper/Shadow 평가에 실패했습니다.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Paper/Shadow 평가에 실패했습니다.');
    } finally {
      pollBusy.current = false;
    }
  }, [fixture, load]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (fixture || !status || !['PAPER', 'SHADOW'].includes(status.effectiveMode)) return undefined;
    const timer = window.setInterval(() => void tick(), 30_000);
    return () => window.clearInterval(timer);
  }, [fixture, status?.effectiveMode, tick]);

  async function setMode(mode: AutoTradingV2Mode) {
    if (fixture || mode === 'LIVE' || !status) return;
    setActionBusy(true);
    try {
      const response = await authorizedFetch('/api/trade-automation/v2/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          equityKrw: status.config.equityKrw,
          riskPerTradePercent: status.config.riskPerTradePercent,
          leverage: status.config.leverage,
          stopMode: status.config.stopMode,
          atrMultiplier: status.config.atrMultiplier,
        }),
      });
      const payload = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? '모드 변경에 실패했습니다.');
      setMessage(mode === 'OFF' ? 'Auto Trading 2.0을 중지했습니다.' : `${mode} 모드를 시작했습니다. 실주문은 발생하지 않습니다.`);
      await load();
      if (mode === 'PAPER' || mode === 'SHADOW') await tick();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '모드 변경에 실패했습니다.');
    } finally {
      setActionBusy(false);
    }
  }

  const positionBySymbol = useMemo(() => new Map((status?.positions ?? []).map((position) => [position.symbol, position])), [status?.positions]);
  const snapshotBySymbol = useMemo(() => new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot])), [snapshots]);
  const effectiveMode = status?.effectiveMode ?? 'OFF';
  const safe = status?.reconciliation.state === 'SAFE' && !status?.config.safeHalt;

  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="auto-trading-v2-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-black">Auto Trading 2.0 · Crypto Futures</h2>
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] font-black text-primary">USDT-M · ISOLATED</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">BTC 1D/1H Regime + 종목 1H Trend + 5m Pullback. 실제 공개 시장 데이터로 Paper/Shadow 체결 결과를 기록합니다.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading || actionBusy} aria-label="Auto Trading 2.0 새로고침" className="shrink-0 rounded-xl border border-card-border p-2 disabled:opacity-50">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/5 p-3" data-testid="auto-trading-v2-live-lock">
        <div className="flex items-start gap-2">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="text-xs font-black text-destructive">실거래는 현재 비활성화되어 있습니다.</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">LIVE는 화면뿐 아니라 서버에서도 잠겨 있습니다. Real Order 0 · Real Cancel 0 · Private Trading API 0</p>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2" aria-label="Auto Trading 2.0 mode">
        {(['OFF', 'PAPER', 'SHADOW', 'LIVE'] as const).map((mode) => (
          <ModeButton
            key={mode}
            mode={mode}
            active={effectiveMode === mode}
            disabled={actionBusy || mode === 'LIVE' || (mode !== 'OFF' && !safe)}
            onClick={() => void setMode(mode)}
          />
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Mode" value={effectiveMode} />
        <Metric label="Risk / Trade" value={`${status?.config.riskPerTradePercent ?? 0.25}%`} />
        <Metric label="Leverage" value={`${status?.config.leverage ?? 3}x / cap ${status?.leverageCap ?? 5}x`} />
        <Metric label="Reconciliation" value={status?.reconciliation.state ?? 'CHECKING'} good={safe} />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-2xl border border-card-border bg-background p-3 text-xs">
          <p className="font-black">Strategy</p>
          <p className="mt-1 break-all text-muted-foreground">{status?.strategy.id ?? 'crypto-futures-pullback-v1'} · v{status?.strategy.version ?? '1.0.0'}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Eligibility {status?.strategy.eligibility ?? 'PAPER_READY'} · RVOL {status?.strategy.selectedRvolPercent ?? 400}% · {status?.strategy.parameterSelection ?? 'PARAMETER_STABILITY'}</p>
        </div>
        <div className="rounded-2xl border border-card-border bg-background p-3 text-xs">
          <p className="font-black">Health / Kill Switch</p>
          <div className="mt-1 flex items-center gap-1.5">
            {status?.health.overall === 'UP' && safe ? <CheckCircle2 className="h-4 w-4 text-positive" /> : <AlertTriangle className="h-4 w-4 text-warning" />}
            <span className="text-muted-foreground">{status?.health.overall ?? 'CHECKING'} · Execution {status?.health.executionEngine ?? '-'}</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{status?.config.haltReasons.length ? status.config.haltReasons.join(', ') : 'Kill Switch 정상 · 신규 진입 허용 상태'}</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {SYMBOLS.map((symbol) => {
          const snapshot = snapshotBySymbol.get(symbol) ?? null;
          const position = positionBySymbol.get(symbol) ?? null;
          const signal = signalFor(status, symbol);
          const symbolRegime = regime(snapshot);
          const pnl = (position?.realizedPnlKrw ?? 0) + (position?.unrealizedPnlKrw ?? 0);
          const ownTrend = snapshot ? (symbolRegime === 'LONG_ONLY' ? snapshot.symbol1hClose > snapshot.symbol1hMa20 : symbolRegime === 'SHORT_ONLY' ? snapshot.symbol1hClose < snapshot.symbol1hMa20 : false) : false;
          return (
            <article key={symbol} className="rounded-2xl border border-card-border bg-background p-3" data-testid={`auto-trading-v2-symbol-${symbol}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-black">{symbol.replace('USDT', '')} <span className="text-[10px] text-muted-foreground">USDT-M</span></h3>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{snapshot ? `Mark ${number(snapshot.markPrice, 6)} · Spread ${percent(snapshot.spreadPercent)}` : '공개 시장 데이터 확인 중'}</p>
                </div>
                <span className={cn('rounded-full px-2 py-1 text-[9px] font-black', snapshot?.dataStale ? 'bg-warning/10 text-warning' : 'bg-positive/10 text-positive')}>
                  {snapshot?.dataStale ? 'STALE' : snapshot ? 'DATA GOOD' : 'CHECKING'}
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                <Row label="Regime" value={symbolRegime} />
                <Row label="Own 1H Gate" value={ownTrend ? 'PASS' : 'BLOCK'} />
                <Row label="Current Signal" value={signal ? `${signal.direction ?? 'NONE'} · ${signal.allowed ? 'READY' : 'WATCH'}` : 'NO SIGNAL'} />
                <Row label="Position" value={position ? `${position.mode} ${position.direction}` : 'NONE'} />
                <Row label="Entry" value={position ? number(position.entryPrice, 6) : '-'} />
                <Row label="Stop" value={position ? number(position.trailingStop ?? position.stopPrice, 6) : '-'} />
                <Row label="TP1" value={position ? number(position.targetPrice, 6) : '-'} />
                <Row label="Risk" value={position ? `${position.riskPerTradePercent}%` : `${status?.config.riskPerTradePercent ?? 0.25}%`} />
                <Row label="Leverage" value={`${position?.leverage ?? status?.config.leverage ?? 3}x`} />
                <Row label="Margin" value={position ? `${number(position.requiredMarginKrw)} KRW` : '-'} />
                <Row label="PnL" value={position ? `${number(pnl)} KRW` : '-'} />
                <Row label="Funding" value={position ? `${number(position.fundingCostKrw)} KRW` : snapshot ? percent(snapshot.fundingRate * 100, 4) : '-'} />
                <Row label="RVOL" value={snapshot ? percent(snapshot.expansionRvolPercent, 1) : '-'} />
                <Row label="ATR" value={snapshot ? percent(snapshot.atrPercent, 2) : '-'} />
                <Row label="Protection" value={position ? (position.positionProtected ? 'PROTECTED' : 'SAFE_HALT') : '-'} />
                <Row label="Last Update" value={snapshot ? new Date(snapshot.observedAt).toLocaleTimeString('ko-KR') : '-'} />
              </dl>
              {signal?.blockReasons.length ? <p className="mt-2 break-words rounded-xl bg-secondary p-2 text-[9px] text-muted-foreground">Block: {signal.blockReasons.join(', ')}</p> : null}
            </article>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <SafetyCounter label="REAL ORDER" value={status?.realOrderCount ?? 0} />
        <SafetyCounter label="REAL CANCEL" value={status?.realCancelCount ?? 0} />
        <SafetyCounter label="PRIVATE TRADING API" value={status?.privateTradingApiCount ?? 0} />
      </div>

      <div className="mt-3 rounded-2xl border border-card-border bg-background p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /><p className="text-xs font-black">Paper / Shadow Journal</p></div>
          <span className="text-[9px] font-bold text-muted-foreground">Telegram {status?.health.telegram ?? 'CHECKING'}</span>
        </div>
        <div className="mt-2 space-y-1.5">
          {(status?.latest ?? []).slice(0, 4).map((record) => (
            <div key={`${record.kind}:${record.id}`} className="flex items-center justify-between gap-3 rounded-xl bg-card px-2.5 py-2 text-[10px]">
              <span className="min-w-0 truncate font-bold">{String(record.payload.recordType ?? record.kind).replace('auto_trading_v2_', '').toUpperCase()}</span>
              <time className="shrink-0 text-muted-foreground">{new Date(record.updatedAt).toLocaleTimeString('ko-KR')}</time>
            </div>
          ))}
          {!status?.latest.length ? <p className="py-2 text-center text-[10px] text-muted-foreground">아직 Paper/Shadow 기록이 없습니다.</p> : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5 text-positive" />Closed candle only</span>
        <span>·</span><span>Risk default 0.25% / max 0.50%</span><span>·</span><span>Daily -1.5% / hard -2%</span><span>·</span><span>3 losses halt</span>
      </div>

      {message ? <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p> : null}

      <div className="mt-3 flex gap-2 sm:hidden">
        <button type="button" disabled={actionBusy || effectiveMode !== 'OFF' || !safe} onClick={() => void setMode('PAPER')} className="flex flex-1 items-center justify-center gap-1 rounded-2xl bg-primary px-3 py-3 text-xs font-black text-primary-foreground disabled:opacity-40"><Play className="h-3.5 w-3.5" />Paper 시작</button>
        <button type="button" disabled={actionBusy || effectiveMode === 'OFF'} onClick={() => void setMode('OFF')} className="flex flex-1 items-center justify-center gap-1 rounded-2xl border border-card-border px-3 py-3 text-xs font-black disabled:opacity-40"><Square className="h-3.5 w-3.5" />중지</button>
      </div>
    </section>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="rounded-2xl border border-card-border bg-background p-3"><p className="text-[9px] font-bold uppercase text-muted-foreground">{label}</p><p className={cn('mt-1 text-xs font-black', good === false && 'text-destructive')}>{value}</p></div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd className="truncate text-right font-bold" title={value}>{value}</dd></>;
}

function SafetyCounter({ label, value }: { label: string; value: number }) {
  return <div className="flex items-center justify-between rounded-2xl border border-positive/30 bg-positive/5 p-3"><span className="text-[10px] font-black">{label}</span><span className="rounded-full bg-positive/10 px-2 py-1 text-xs font-black text-positive">{value}</span></div>;
}

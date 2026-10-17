import { useState } from 'react';
import { OctagonX, Play, ShieldAlert, Square } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import type { TradeAutomationStatus } from '@/components/trade-automation-settings';

type Market = 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
type AutoRun = NonNullable<TradeAutomationStatus['autoRun']>;
export type AutoRunState = AutoRun['state'];

const MARKET_LABELS: Record<Market, string> = {
  domestic_stock: '국내주식',
  us_stock: '미국주식',
  crypto_spot: '코인현물',
  crypto_futures: '코인선물',
};
const MARKETS = Object.keys(MARKET_LABELS) as Market[];

const RUN_ERROR_LABELS: Record<string, string> = {
  GLOBAL_EMERGENCY_STOP_ACTIVE: '서버 전체 비상정지 중이라 작동할 수 없습니다. 관리자 해제가 필요합니다.',
  MEMBER_TRADING_RESUME_REQUIRED: '즉시정지 상태입니다. 설정 탭에서 재개 준비를 먼저 해주세요.',
  AUTO_RUN_MARKET_REQUIRED: '자동매매를 켤 시장이 없습니다. 설정 탭에서 시장을 먼저 켜고 저장해주세요.',
  AUTO_RUN_VALUE_REQUIRED: '요청 형식이 올바르지 않습니다.',
};

export const AUTO_RUN_STATE_LABELS: Record<AutoRunState, string> = {
  RUNNING: '작동 중 자동 실행',
  STOPPED: '정지됨',
  AUTO_STOPPED: '손실한도 자동정지',
  KILL_SWITCH: '즉시정지됨',
  GLOBAL_STOP: '서버 전체 정지',
};

function switchOnFromPolicy(policy: TradeAutomationStatus['policy'] | undefined) {
  return Boolean(policy && policy.mode === 'automatic' && policy.automaticEnabled
    && !policy.emergencyStopped && !policy.newEntriesStopped);
}

/**
 * Server-owned run view, with a conservative fallback (Paper lanes, no LIVE
 * claim) when an older server does not report `autoRun`.
 */
export function resolveAutoRun(status: TradeAutomationStatus | null): AutoRun | null {
  if (!status) return null;
  if (status.autoRun) return status.autoRun;
  const policy = status.policy;
  // A malformed or partial payload (no policy) must not crash the page; treat it as unknown.
  if (!policy) return null;
  const switchOn = switchOnFromPolicy(policy);
  const state: AutoRunState = policy.emergencyStopped || policy.newEntriesStopped ? 'KILL_SWITCH'
    : !switchOn ? 'STOPPED' : status.emergencyStopped ? 'GLOBAL_STOP' : 'RUNNING';
  const domestic = policy.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom';
  const exchanges: Record<Market, AutoRun['markets'][Market]['exchange']> = {
    domestic_stock: domestic, us_stock: 'kiwoom', crypto_spot: 'upbit', crypto_futures: 'bitget',
  };
  return {
    state,
    switchOn,
    running: state === 'RUNNING',
    perOrderApprovalRequired: false,
    orderMethod: state === 'RUNNING' ? 'AUTOMATIC_WHILE_RUNNING' : 'STOPPED',
    markets: Object.fromEntries(MARKETS.map((market) => [market, {
      enabled: Boolean(policy.marketEnabled?.[market]) && policy.exchangeEnabled?.[exchanges[market]] === true,
      exchange: exchanges[market],
      lane: 'paper' as const,
      liveConfirmed: false,
    }])) as AutoRun['markets'],
    lossLimit: {
      dailyLossLimitPercent: policy.dailyLossLimitPercent,
      totalDailyLossLimitPercent: policy.dailyLossLimitPercent,
      autoStopped: false,
      autoStopReason: null,
    },
    perSymbolMaxKrw: policy.maxOrderKrw,
    maxAssetPercent: policy.maxAssetPercent,
    lastAction: null,
    lastReason: null,
    changedAt: null,
  };
}

async function readStatus(): Promise<TradeAutomationStatus | null> {
  const response = await authorizedFetch('/api/trade-automation/status', { cache: 'no-store' });
  const payload = await response.json().catch(() => null) as TradeAutomationStatus | null;
  return response.ok && payload ? payload : null;
}

export function AutoTradingRunControl({
  status,
  fixture,
  loading,
  onStatus,
  onOpenSettings,
}: {
  status: TradeAutomationStatus | null;
  fixture: boolean;
  loading: boolean;
  onStatus: (status: TradeAutomationStatus) => void;
  onOpenSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [liveConfirm, setLiveConfirm] = useState<Market[] | null>(null);
  const autoRun = resolveAutoRun(status);
  const state: AutoRunState = autoRun?.state ?? 'STOPPED';
  const running = state === 'RUNNING' || state === 'GLOBAL_STOP';
  const killSwitch = state === 'KILL_SWITCH';
  const enabledMarkets = autoRun ? MARKETS.filter((market) => autoRun.markets[market].enabled) : [];
  const liveMarkets = enabledMarkets.filter((market) => autoRun?.markets[market].lane === 'live');

  function applyFixture(next: Partial<AutoRun>, policyPatch: Partial<TradeAutomationStatus['policy']>) {
    if (!status || !autoRun) return;
    onStatus({ ...status, policy: { ...status.policy, ...policyPatch }, autoRun: { ...autoRun, ...next } });
  }

  async function sendRun(nextRunning: boolean, liveConfirmed = false) {
    if (busy || !autoRun) return;
    setMessage('');
    if (nextRunning && !liveConfirmed) {
      const unconfirmed = liveMarkets.filter((market) => !autoRun.markets[market].liveConfirmed);
      if (unconfirmed.length > 0) {
        setLiveConfirm(unconfirmed);
        return;
      }
    }
    if (fixture) {
      if (nextRunning && enabledMarkets.length === 0) {
        setMessage(RUN_ERROR_LABELS.AUTO_RUN_MARKET_REQUIRED);
        return;
      }
      const markets = Object.fromEntries(MARKETS.map((market) => [market, {
        ...autoRun.markets[market],
        liveConfirmed: autoRun.markets[market].liveConfirmed || (liveConfirmed && autoRun.markets[market].lane === 'live'),
      }])) as AutoRun['markets'];
      applyFixture({
        state: nextRunning ? 'RUNNING' : 'STOPPED', switchOn: nextRunning, running: nextRunning,
        orderMethod: nextRunning ? 'AUTOMATIC_WHILE_RUNNING' : 'STOPPED',
        lastAction: nextRunning ? 'RUN' : 'STOP', markets,
      }, { mode: 'automatic', automaticEnabled: nextRunning, newEntriesStopped: false });
      setLiveConfirm(null);
      setMessage(nextRunning ? '작동: 켜진 시장의 신호를 주문별 승인 없이 자동 처리합니다.' : '정지: 새 자동 주문을 내지 않습니다.');
      return;
    }
    setBusy(true);
    try {
      const response = await authorizedFetch('/api/trade-automation/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextRunning
          ? { running: true, ...(liveConfirmed ? { confirmation: { liveAutomaticWithoutPerOrderApproval: true } } : {}) }
          : { running: false }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; liveMarkets?: Market[] } | null;
      if (response.status === 409 && payload?.error === 'AUTO_RUN_LIVE_CONFIRMATION_REQUIRED') {
        setLiveConfirm(payload.liveMarkets?.length ? payload.liveMarkets : liveMarkets);
        return;
      }
      if (!response.ok) throw new Error(RUN_ERROR_LABELS[payload?.error ?? ''] ?? '작동 상태를 바꾸지 못했습니다.');
      setLiveConfirm(null);
      setMessage(nextRunning ? '작동: 켜진 시장의 신호를 주문별 승인 없이 자동 처리합니다.' : '정지: 새 자동 주문을 내지 않습니다.');
      const latest = await readStatus().catch(() => null);
      if (latest) onStatus(latest);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '작동 상태를 바꾸지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function stopEverything() {
    if (busy || !autoRun) return;
    setMessage('');
    if (fixture) {
      const markets = Object.fromEntries(MARKETS.map((market) => [market, { ...autoRun.markets[market], enabled: false }])) as AutoRun['markets'];
      applyFixture({
        state: 'KILL_SWITCH', switchOn: false, running: false, orderMethod: 'STOPPED', lastAction: 'KILL_SWITCH', markets,
      }, {
        automaticEnabled: false, emergencyStopped: true,
        marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: false, crypto_futures: false },
      });
      setMessage('모든 자동매매를 즉시 정지했습니다. 4시장 신규 주문이 차단됩니다.');
      return;
    }
    setBusy(true);
    try {
      const response = await authorizedFetch('/api/trade-automation/emergency-stop', { method: 'POST' });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? '즉시 정지에 실패했습니다.');
      setMessage('모든 자동매매를 즉시 정지했습니다. 4시장 신규 주문이 차단됩니다.');
      const latest = await readStatus().catch(() => null);
      if (latest) onStatus(latest);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '즉시 정지에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  const stateDetail = state === 'RUNNING'
    ? '켜진 시장의 적격 신호를 주문별 승인 없이 자동 주문합니다. 매 주문 위험검사는 그대로입니다.'
    : state === 'GLOBAL_STOP'
      ? '작동은 켜져 있지만 서버 전체 비상정지로 새 주문이 나가지 않습니다.'
      : state === 'AUTO_STOPPED'
        ? '일일 손실한도에 도달해 자동으로 정지했습니다. 보유 포지션의 보호 청산은 계속됩니다.'
        : killSwitch
          ? '모든 자동매매가 즉시정지되었습니다. 설정 탭에서 재개 준비 후 다시 작동할 수 있습니다.'
          : '정지 상태에서는 자동 주문을 내지 않습니다.';

  return (
    <section
      aria-label="자동매매 작동"
      className="rounded-2xl border border-card-border bg-card p-3 sm:p-4"
      data-testid="auto-trading-run-control"
      data-run-state={state}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">자동매매 작동</h2>
        <span
          className={[
            'rounded-full px-2.5 py-1 text-xs font-bold',
            state === 'RUNNING' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : state === 'STOPPED' ? 'bg-muted text-muted-foreground' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
          ].join(' ')}
          data-testid="auto-trading-run-state"
        >
          {loading && !autoRun ? '확인 중' : AUTO_RUN_STATE_LABELS[state]}
        </span>
      </div>
      <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">{stateDetail}</p>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr]">
        {killSwitch ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex min-h-14 items-center justify-center gap-2 rounded-xl border border-card-border bg-secondary px-4 text-base font-bold"
            data-testid="auto-trading-run-resume"
          >
            설정 탭에서 재개 준비
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void sendRun(!running)}
            disabled={busy || loading || !autoRun}
            aria-pressed={running}
            className={[
              'flex min-h-14 items-center justify-center gap-2 rounded-xl px-4 text-base font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              running ? 'border border-card-border bg-background text-foreground' : 'bg-primary text-primary-foreground',
            ].join(' ')}
            data-testid="auto-trading-run-toggle"
          >
            {running ? <Square className="h-5 w-5" aria-hidden="true" /> : <Play className="h-5 w-5" aria-hidden="true" />}
            {busy ? '처리 중' : running ? '정지' : '작동'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void stopEverything()}
          disabled={busy || killSwitch || !autoRun}
          className="flex min-h-14 items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 text-sm font-bold text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="auto-trading-kill-switch"
        >
          <OctagonX className="h-4 w-4" aria-hidden="true" />모든 자동매매 즉시 정지
        </button>
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="시장별 실행 방식" data-testid="auto-trading-run-lanes">
        {MARKETS.map((market) => {
          const row = autoRun?.markets[market];
          const label = !row?.enabled ? '꺼짐' : row.lane === 'live' ? '실거래' : '모의';
          return (
            <li key={market} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-card-border bg-background px-2.5 py-2 text-xs"
              data-testid={`auto-trading-run-lane-${market}`}>
              <span className="truncate font-medium text-muted-foreground">{MARKET_LABELS[market]}</span>
              <span className={row?.enabled && row.lane === 'live' ? 'font-bold text-destructive' : 'font-semibold'}>{label}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">
        실거래/모의는 시장별 서버 실거래 스위치가 정합니다. 작동 버튼은 모의 시장을 실거래로 바꾸지 않습니다.
      </p>
      {message ? <p role="status" className="mt-2 break-keep rounded-lg bg-secondary p-2.5 text-xs font-semibold" data-testid="auto-trading-run-message">{message}</p> : null}

      {liveConfirm ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="실거래 자동 작동 확인">
          <div className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-5 shadow-2xl">
            <div className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-6 w-6" aria-hidden="true" />
              <h3 className="text-base font-bold">실거래 시장 자동 작동</h3>
            </div>
            <p className="mt-3 break-keep text-sm leading-6">
              <strong>{liveConfirm.map((market) => MARKET_LABELS[market]).join(', ')}</strong> 시장은 실거래로 운용됩니다.
              작동하면 주문별 승인 없이 실제 주문이 자동으로 전송됩니다.
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
              <li>매 주문마다 일일 손실한도·종목당 한도·중복주문 검사를 다시 합니다.</li>
              <li>일일 손실한도에 도달하면 자동으로 정지합니다.</li>
              <li>언제든 정지 또는 "모든 자동매매 즉시 정지"로 멈출 수 있습니다.</li>
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">이 확인은 시장별로 처음 한 번만 묻습니다.</p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setLiveConfirm(null)} className="min-h-12 rounded-xl border border-card-border px-4 font-bold">취소</button>
              <button type="button" onClick={() => void sendRun(true, true)} disabled={busy}
                className="min-h-12 rounded-xl bg-destructive px-4 font-bold text-white disabled:opacity-50"
                data-testid="auto-trading-run-live-confirm">확인하고 작동</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { AlertTriangle, BookOpenCheck, CheckCircle2, ClipboardList, Settings2, ShieldCheck, WalletCards } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { PaperJournalSyncAnalyticsPanel } from '@/components/paper-journal-sync-analytics-panel';
import { PaperTradingPanel } from '@/components/paper-trading-panel';
import { FormulaAiAutoRehearsalPanel } from '@/components/formula-ai-auto-rehearsal-panel';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import { TradeAutomationSettings } from '@/components/trade-automation-settings';
import { UnifiedTradeJournalPanel } from '@/components/unified-trade-journal-panel';
import { UserBrokerTelegramPanel } from '@/components/user-broker-telegram-panel';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAnalysisSelection } from '@/lib/analysis-selection';
import { useAuth } from '@/lib/auth';
import { createUserPaperStorage } from '@/lib/paper-journal-sync-storage';
import { getJournalSnapshot, syncJournalRecords } from '@/lib/paper-journal-sync';

type TradeAutomationFixture = ComponentProps<typeof TradeAutomationSettings>['fixture'];

type TradingMode = 'auto' | 'paper';
type AutomaticPaperAccountStatus = 'checking' | 'missing' | 'ready' | 'blocked' | 'failed' | 'fixture';
const AUTO_PAPER_ACCOUNT_ID = 'automatic-paper-account-v1';
const AUTO_PAPER_INITIAL_KRW = 500_000;

async function automaticPaperHistoryAllowsNewWallet(signal?: AbortSignal): Promise<boolean> {
  const response = await authorizedFetch('/api/trade-automation/status', { signal });
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    automaticPaperWalletBootstrap?: { safeToInitialize?: boolean };
  } | null;
  // Missing or stale backend preflight is not permission to reset Paper capital.
  return response.ok && body?.ok === true
    && body.automaticPaperWalletBootstrap?.safeToInitialize === true;
}

async function inspectAutomaticPaperAccount(signal?: AbortSignal): Promise<AutomaticPaperAccountStatus> {
  let cursor: string | null = null;
  let anyRows = false;
  for (let page = 0; page < 50; page += 1) {
    const snapshot = await getJournalSnapshot(cursor, 100, signal);
    anyRows ||= snapshot.records.length > 0;
    const wallet = snapshot.records.find((row) =>
      row.kind === 'account' && row.id === AUTO_PAPER_ACCOUNT_ID);
    if (wallet) {
      const payload = wallet.payload;
      return wallet.deletedAt == null
        && payload.id === AUTO_PAPER_ACCOUNT_ID
        && Number(payload.initialBalance) === AUTO_PAPER_INITIAL_KRW
        && Number.isFinite(Number(payload.equity)) && Number(payload.equity) > 0
        && Number.isFinite(Number(payload.cashBalance)) && Number(payload.cashBalance) >= 0
        ? 'ready' : 'blocked';
    }
    if (!snapshot.nextCursor) {
      const historySafe = await automaticPaperHistoryAllowsNewWallet(signal);
      return anyRows || !historySafe ? 'blocked' : 'missing';
    }
    cursor = snapshot.nextCursor;
  }
  return 'blocked';
}

type TradingMarket = 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
type TradingSection = 'dashboard' | 'orders' | 'journal' | 'rehearsal' | 'settings';

type AutoTradingPageProps = {
  fixture?: TradeAutomationFixture;
  embedded?: boolean;
  initialMode?: TradingMode;
};

const MARKETS: Array<{
  value: TradingMarket;
  label: string;
  journalMarket: 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
  selectionMarket: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  provider: string;
}> = [
  { value: 'domestic_stock', label: '국내주식', journalMarket: 'KR_STOCK', selectionMarket: 'KR', provider: 'Toss / Kiwoom' },
  { value: 'us_stock', label: '미국주식', journalMarket: 'US_STOCK', selectionMarket: 'US', provider: 'Kiwoom' },
  { value: 'crypto_spot', label: '코인현물', journalMarket: 'CRYPTO_SPOT', selectionMarket: 'UPBIT', provider: 'Upbit' },
  { value: 'crypto_futures', label: '코인선물', journalMarket: 'CRYPTO_FUTURES', selectionMarket: 'BITGET', provider: 'Bitget' },
];

const SECTIONS: Array<{ value: TradingSection; label: string }> = [
  { value: 'dashboard', label: '대시보드' },
  { value: 'orders', label: '포지션·주문' },
  { value: 'journal', label: '매매일지' },
  { value: 'rehearsal', label: '리허설' },
  { value: 'settings', label: '설정' },
];

function tradingRouteState(): { market: TradingMarket; section: TradingSection } {
  if (typeof window === 'undefined') return { market: 'domestic_stock', section: 'dashboard' };
  const params = new URLSearchParams(window.location.search);
  const market = params.get('market') as TradingMarket | null;
  const section = params.get('section') as TradingSection | null;
  return {
    market: MARKETS.some((item) => item.value === market) ? market! : 'domestic_stock',
    section: SECTIONS.some((item) => item.value === section) ? section! : 'dashboard',
  };
}

function StatusItem({
  label,
  value,
  tone = 'ok',
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'neutral';
}) {
  const Icon = tone === 'warn' ? AlertTriangle : CheckCircle2;
  const iconClass = tone === 'ok'
    ? 'text-emerald-500'
    : tone === 'warn'
      ? 'text-amber-500'
      : 'text-muted-foreground';
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-background p-2.5 text-center">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 flex min-w-0 items-center justify-center gap-1.5 text-xs font-semibold">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
}

function runtimeHealthFresh(value: string | null | undefined, nowMs = Date.now()) {
  if (!value) return false;
  const tickMs = Date.parse(value);
  return Number.isFinite(tickMs)
    && tickMs <= nowMs + 5_000
    && nowMs - tickMs <= 360_000;
}

function kstActivityTime(value: string | null | undefined) {
  if (!value) return '없음';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '확인 필요';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(time));
}

function SegmentedButton({
  active,
  disabled = false,
  children,
  onClick,
  testId,
}: {
  active: boolean;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={[
        'min-h-11 min-w-0 rounded-xl border px-3 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card text-foreground',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export default function AutoTradingPage({ fixture, embedded = false, initialMode = 'auto' }: AutoTradingPageProps) {
  const auth = useAuth();
  const { selection } = useAnalysisSelection();
  const [location, navigate] = useLocation();
  const userId = auth.user?.id ?? auth.profile?.id ?? '';
  const testFixtureAccess = Boolean(fixture);
  const canAuto = testFixtureAccess || auth.can('canAccessAutoTrading');
  const canPaper = testFixtureAccess || auth.can('canAccessPaperTrading');
  const canFutures = testFixtureAccess || auth.can('canAccessFutures');
  const canPlaceOrders = testFixtureAccess || auth.can('canPlaceOrders');
  const canManagePilot = testFixtureAccess || auth.can('canManageMembers');
  const [mode, setMode] = useState<TradingMode>(initialMode);
  const initialRouteState = useMemo(tradingRouteState, []);
  const [market, setMarket] = useState<TradingMarket>(initialRouteState.market);
  const [section, setSection] = useState<TradingSection>(initialRouteState.section);
  const [runtimeStatus, setRuntimeStatus] = useState<TradeAutomationFixture | null>(fixture ?? null);
  const [runtimeLoading, setRuntimeLoading] = useState(!fixture);
  const [runtimeReadError, setRuntimeReadError] = useState(false);
  const [runtimeClockMs, setRuntimeClockMs] = useState(() => Date.now());
  const runtimeRefreshInFlight = useRef(false);
  const [paperRevision, setPaperRevision] = useState(0);
  const [autoPaperStatus, setAutoPaperStatus] = useState<AutomaticPaperAccountStatus>(
    fixture ? 'fixture' : 'checking',
  );
  const [autoPaperMessage, setAutoPaperMessage] = useState('');
  const [autoPaperBusy, setAutoPaperBusy] = useState(false);
  const paperStorage = useMemo(
    () => userId ? createUserPaperStorage(window.localStorage, userId) : window.localStorage,
    [userId],
  );

  useEffect(() => {
    if (mode === 'auto' && !canAuto && canPaper) setMode('paper');
    if (mode === 'paper' && !canPaper && canAuto) setMode('auto');
  }, [canAuto, canPaper, mode]);

  useEffect(() => {
    const next = tradingRouteState();
    setMarket(next.market === 'crypto_futures' && !canFutures ? 'domestic_stock' : next.market);
    setSection(next.section);
  }, [canFutures, location]);

  useEffect(() => {
    if (fixture) {
      setRuntimeStatus(fixture);
      setRuntimeLoading(false);
      setRuntimeReadError(false);
      return;
    }
    if (!canAuto) return;
    const controller = new AbortController();
    const loadRuntimeStatus = async (initial: boolean) => {
      if (runtimeRefreshInFlight.current) return;
      runtimeRefreshInFlight.current = true;
      if (initial) setRuntimeLoading(true);
      try {
        const response = await authorizedFetch('/api/trade-automation/status', { signal: controller.signal });
        const payload = await response.json() as TradeAutomationFixture & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? '자동매매 상태를 불러오지 못했습니다.');
        if (!controller.signal.aborted) {
          setRuntimeStatus(payload);
          setRuntimeReadError(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setRuntimeReadError(true);
          if (initial) setRuntimeStatus(null);
        }
      } finally {
        runtimeRefreshInFlight.current = false;
        if (initial && !controller.signal.aborted) setRuntimeLoading(false);
      }
    };
    void loadRuntimeStatus(true);
    const timer = window.setInterval(() => {
      setRuntimeClockMs(Date.now());
      void loadRuntimeStatus(false);
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
      runtimeRefreshInFlight.current = false;
    };
  }, [canAuto, fixture]);

  useEffect(() => {
    if (fixture) {
      setAutoPaperStatus('fixture');
      return;
    }
    if (!userId || !canAuto) return;
    const controller = new AbortController();
    setAutoPaperStatus('checking');
    void inspectAutomaticPaperAccount(controller.signal)
      .then((status) => { if (!controller.signal.aborted) setAutoPaperStatus(status); })
      .catch(() => { if (!controller.signal.aborted) setAutoPaperStatus('failed'); });
    return () => controller.abort();
  }, [userId, canAuto, fixture]);

  async function prepareAutomaticPaperAccount() {
    if (autoPaperBusy || !userId || !canAuto || fixture || autoPaperStatus !== 'missing') return;
    setAutoPaperBusy(true);
    setAutoPaperMessage('');
    try {
      // Never overwrite a previously synced local simulator account or
      // silently replenish a member with existing Paper execution history.
      const before = await inspectAutomaticPaperAccount();
      if (before !== 'missing') {
        setAutoPaperStatus(before);
        setAutoPaperMessage('기존 모의기록이 확인되어 새 가상계좌를 덮어쓰지 않았습니다.');
        return;
      }
      const at = new Date().toISOString();
      const result = await syncJournalRecords({
        idempotencyKey: `automatic-paper-start-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        clientTime: at,
        records: [{
          kind: 'account', id: AUTO_PAPER_ACCOUNT_ID, version: 1,
          updatedAt: at, deletedAt: null,
          payload: {
            id: AUTO_PAPER_ACCOUNT_ID,
            initialBalance: AUTO_PAPER_INITIAL_KRW,
            cashBalance: AUTO_PAPER_INITIAL_KRW,
            realizedPnl: 0, unrealizedPnl: 0, equity: AUTO_PAPER_INITIAL_KRW,
            usedMargin: 0, availableMargin: AUTO_PAPER_INITIAL_KRW,
            createdAt: at, updatedAt: at,
          },
        }],
      });
      if (result.orderSubmitted !== false || result.exchangeRequestSent !== false
        || result.failed.length > 0 || result.conflicts.length > 0) {
        throw new Error('모의계좌 동기화 결과가 안전하게 확인되지 않았습니다.');
      }
      const after = await inspectAutomaticPaperAccount();
      setAutoPaperStatus(after);
      if (after !== 'ready') throw new Error('서버 모의계좌 저장·조회 검증이 완료되지 않았습니다.');
      setAutoPaperMessage('50만원 가상계좌 저장·조회를 확인했습니다. 실제 주문은 활성화되지 않습니다.');
    } catch (error) {
      setAutoPaperStatus('failed');
      setAutoPaperMessage(error instanceof Error ? error.message : '모의계좌 준비에 실패했습니다.');
    } finally {
      setAutoPaperBusy(false);
    }
  }

  const marketMeta = MARKETS.find((item) => item.value === market)!;
  const selectionMatchesMarket = Boolean(selection && selection.market === marketMeta.selectionMarket);
  const policy = runtimeStatus?.policy;
  const walletAudit = runtimeStatus?.automaticPaperWalletBootstrap;
  const marketEnabled = Boolean(policy?.marketEnabled?.[market]);
  const selectedProvider = market === 'crypto_spot'
    ? 'upbit'
    : market === 'crypto_futures'
      ? 'bitget'
      : policy?.stockBrokerByMarket?.[market] ?? 'kiwoom';
  const providerConnection = (runtimeStatus?.connections ?? []).find((item) => item.exchange === selectedProvider);
  const liveReadiness = runtimeStatus?.liveAutomaticReadinessByMarket?.[market]
    ?? runtimeStatus?.liveExecutionReadiness?.[selectedProvider];
  const providerVerified = liveReadiness?.providerVerified === true;
  const autoWorker = runtimeStatus?.autoTradingBackground;
  const telegramWorker = runtimeStatus?.userTelegramDelivery;
  const runtimeNowMs = runtimeClockMs;
  const autoWorkerFresh = runtimeHealthFresh(autoWorker?.lastTickAt, runtimeNowMs);
  const telegramWorkerFresh = runtimeHealthFresh(telegramWorker?.lastTickAt, runtimeNowMs);
  const automaticRuntimeReady = autoWorker?.enabled === true
    && autoWorker.liveModeRequested === true
    && autoWorker.tickOk === true
    && autoWorkerFresh
    && autoWorker.handoffReady === true
    && autoWorker.newEntriesFailClosed === false
    && autoWorker.liveEntryWarmupComplete === true
    && autoWorker.liveEntriesArmed === true
    && autoWorker.globalEmergencyStopActive === false;
  const telegramProofMs = Date.parse(telegramWorker?.lastConfirmedDeliveryAt ?? '');
  const telegramProofFresh = Number.isFinite(telegramProofMs)
    && telegramProofMs <= runtimeNowMs + 5_000
    && runtimeNowMs - telegramProofMs <= 24 * 60 * 60_000;
  const telegramRuntimeReady = telegramWorker?.enabled === true
    && telegramWorker.tickOk === true
    && telegramWorker.deliveryConfirmed === true
    && telegramProofFresh
    && telegramWorkerFresh
    && telegramWorker.errorCode == null;
  const liveAuthorityLabel = runtimeLoading
    ? '확인 중'
    : runtimeReadError
      ? '상태 조회 실패'
      : !canPlaceOrders
      ? '계정 주문 권한 없음'
      : !liveReadiness?.automaticServerGateEnabled
        ? '자동 Gate OFF'
        : !liveReadiness?.readyForAutomaticOrderEvaluation
          ? '자동 Gate 차단'
          : autoWorker?.enabled !== true || autoWorker.liveModeRequested !== true
            ? '자동 워커 OFF'
            : autoWorker.tickOk !== true || autoWorker.handoffReady !== true || autoWorker.newEntriesFailClosed === true
              ? '자동 워커 차단'
              : !autoWorkerFresh
                ? '자동 워커 상태 지연'
                : autoWorker.liveEntriesArmed !== true
                  ? '안전대기 · Arm 준비 중'
                  : !telegramWorkerFresh
                    ? 'Telegram 상태 지연'
                    : !telegramRuntimeReady
                      ? 'Telegram 전달 점검 필요'
                      : automaticRuntimeReady
                        ? '자동 실거래 작동 준비됨'
                        : '자동 워커 점검 필요';
  const lastOrder = runtimeStatus?.lastOrderByMarket?.[market] ?? (fixture ? runtimeStatus?.lastOrder ?? null : null);
  const marketActivity = runtimeStatus?.marketActivityByMarket?.[market] ?? null;
  const emergencyStopped = runtimeStatus?.emergencyStopped === true;
  const newEntriesStopped = policy?.newEntriesStopped === true;
  const effectiveEntryStopped = emergencyStopped || newEntriesStopped;

  const changeMode = (next: TradingMode) => {
    if (next === 'auto' && !canAuto) return;
    if (next === 'paper' && !canPaper) return;
    setMode(next);
    setSection('dashboard');
  };

  const dashboard = mode === 'auto' ? (
    <div className="space-y-3">
      <section
        aria-label="자동매매 실행 상태"
        className="rounded-2xl border border-primary/20 bg-primary/5 p-3"
        data-testid="auto-trading-safety-summary"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-sm font-bold">자동매매 실행 방식</h2>
          </div>
          <span className="rounded-full border border-primary/20 bg-background px-2.5 py-1 text-xs font-bold">
            {runtimeLoading ? '확인 중' : policy?.automaticEnabled ? '자동 실행 ON' : '자동 실행 OFF'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <StatusItem label="주문별 승인" value="불필요" />
          <StatusItem label="시장 제어" value="4시장" />
          <StatusItem label="위험검사" value="매 주문 재검증" />
        </div>
        <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">
          4시장 개별 ON/OFF로 시장별 자동 실행을 제어하며, 주문마다 승인을 요청하지 않습니다. 실제 주문 권한은 서버 Gate를 통과해야 합니다.
        </p>
      </section>

      <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="auto-trading-runtime-summary">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold">{marketMeta.label}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{marketMeta.provider}</p>
          </div>
          <span className={[
            'rounded-full px-2.5 py-1 text-xs font-bold',
            'bg-muted text-muted-foreground',
          ].join(' ')}>
            {marketEnabled && !effectiveEntryStopped ? '시장 설정 ON' : '시장 설정 OFF'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatusItem
            label="연결"
            value={providerVerified ? '검증됨' : providerConnection?.configured ? '설정만 됨' : '미설정'}
            tone={providerVerified ? 'ok' : 'warn'}
          />
          <StatusItem
            label="최근 주문"
            value={lastOrder?.state ?? '없음'}
            tone={lastOrder && ['REJECTED', 'RECOVERY_REQUIRED'].includes(lastOrder.state) ? 'warn' : lastOrder ? 'ok' : 'neutral'}
          />
          <StatusItem
            label="비상정지"
            value={emergencyStopped ? '작동 중' : newEntriesStopped ? '신규진입 차단' : '정상'}
            tone={effectiveEntryStopped ? 'warn' : 'ok'}
          />
          <StatusItem
            label="실거래 권한"
            value={liveAuthorityLabel}
            tone={!runtimeReadError && liveReadiness?.readyForAutomaticOrderEvaluation === true && automaticRuntimeReady && telegramRuntimeReady ? 'ok' : 'warn'}
          />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="auto-trading-market-activity">
          <StatusItem label="미결 주문" value={`${marketActivity?.pendingOrders ?? 0}건`} />
          <StatusItem label="복구 필요" value={`${marketActivity?.recoveryRequiredOrders ?? 0}건`} />
          <StatusItem label="오늘 주문" value={`${marketActivity?.todayOrders ?? 0}건`} />
          <StatusItem label="오늘 체결" value={`${marketActivity?.todayFilledOrders ?? 0}건 · ${kstActivityTime(marketActivity?.lastActivityAt)}`} />
        </div>
      </section>

      <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="automatic-paper-wallet-readiness">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold">자동모의매매 가상계좌</h2>
          <span className="text-xs font-semibold">
            {autoPaperStatus === 'ready' ? '서버 계좌 확인됨'
              : autoPaperStatus === 'missing' ? '계좌 준비 필요'
                : autoPaperStatus === 'blocked' ? '기존 기록 확인 필요'
                  : autoPaperStatus === 'failed' ? '계좌 점검 실패'
                    : autoPaperStatus === 'fixture' ? '테스트 화면' : '확인 중'}
          </span>
        </div>
        <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">
          자동모의매매 전용 50만원 가상자본입니다. 실계좌의 입금·출금이나 LIVE 주문 권한을 변경하지 않습니다.
          기존 수동 모의거래 기록이 있으면 자동으로 덮어쓰지 않습니다.
        </p>
        {autoPaperMessage ? <p role="status" className="mt-2 break-keep text-xs">{autoPaperMessage}</p> : null}
        {autoPaperStatus === 'blocked' && walletAudit?.safeToInitialize === false ? (
          <p className="mt-2 break-keep text-xs leading-5 text-amber-700" data-testid="automatic-paper-history-audit">
            과거 자동모의 계획 {walletAudit.automaticPaperPlanCount}건 · 체결 이력 {walletAudit.executedAutomaticPaperOrderCount}건
            {walletAudit.missingFilledQuantityEvidence > 0 ? ` · 수량 증거 누락 ${walletAudit.missingFilledQuantityEvidence}건` : ''}
            {walletAudit.missingFeeEvidence > 0 ? ` · 비용 증거 누락 ${walletAudit.missingFeeEvidence}건` : ''}
            . 과거 기록은 보존되며 50만원 가상계좌 재설정은 차단됩니다.
          </p>
        ) : null}
        {autoPaperStatus === 'blocked' && policy ? (
          <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground" data-testid="automatic-current-risk-policy">
            현재 저장된 자동매매 정책: 총 운용 {policy.totalCapitalKrw.toLocaleString('ko-KR')}원,
            1회 주문 상한 {policy.maxOrderKrw.toLocaleString('ko-KR')}원,
            코인선물 레버리지 {policy.bitgetLeverage}배. 이 화면에서 운용 한도를 변경하지 않습니다.
          </p>
        ) : null}
        {autoPaperStatus === 'missing' ? (
          <button
            type="button"
            className="mt-3 min-h-11 rounded-xl border border-card-border px-4 text-sm font-semibold"
            disabled={autoPaperBusy || !canAuto || Boolean(fixture)}
            onClick={() => void prepareAutomaticPaperAccount()}
            data-testid="prepare-automatic-paper-account"
          >
            {autoPaperBusy ? '가상계좌 검증 중' : '50만원 모의계좌 준비'}
          </button>
        ) : null}
      </section>
    </div>
  ) : (
    <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="paper-trading-dashboard">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold">Canonical 모의매매 · {marketMeta.label}</h2>
          <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
            국내주식·미국주식·코인현물·코인선물 모두 동일한 서버 검증형 Paper 경로를 사용합니다.
          </p>
        </div>
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-bold text-emerald-700">
          실제 주문 0
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatusItem label="시장" value={marketMeta.label} />
        <StatusItem label="Provider" value={marketMeta.provider} />
        <StatusItem label="선택 종목" value={selectionMatchesMarket ? selection?.ticker ?? '선택됨' : '미선택'} />
        <StatusItem label="경제적 증거" value="Settlement 후 판정" />
      </div>
    </section>
  );

  const orders = mode === 'auto' ? (
    <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="auto-trading-orders">
      <div className="flex items-center gap-2">
        <WalletCards className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">포지션·주문 · {marketMeta.label}</h2>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatusItem label="최근 상태" value={lastOrder?.state ?? '주문 없음'} />
        <StatusItem label="미결 주문" value={`${marketActivity?.pendingOrders ?? 0}건`} />
        <StatusItem label="오늘 주문" value={`${marketActivity?.todayOrders ?? 0}건`} />
        <StatusItem label="오늘 체결" value={`${marketActivity?.todayFilledOrders ?? 0}건`} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button type="button" className="min-h-11 rounded-xl border border-card-border px-3 text-sm font-bold" onClick={() => navigate('/scanner')}>신호 확인</button>
        <button type="button" className="min-h-11 rounded-xl border border-card-border px-3 text-sm font-bold" onClick={() => navigate('/ai-chart')}>AI 차트·포지션</button>
        <button type="button" className="min-h-11 rounded-xl border border-card-border px-3 text-sm font-bold" onClick={() => navigate('/account')}>실계좌 연결</button>
      </div>
      <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">
        주문·취소·정정은 기존 canonical OMS와 서버 Gate를 그대로 사용합니다. 이 화면은 별도 실행 권한을 만들지 않습니다.
      </p>
    </section>
  ) : (
    <div className="space-y-3" data-testid="paper-trading-orders">
      {selectionMatchesMarket && selection ? (
        <ScannerApprovalComposer selection={selection} />
      ) : (
        <section className="rounded-2xl border border-card-border bg-card p-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold">{marketMeta.label} 모의 포지션 준비</h2>
          </div>
          <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">
            AI 검색기에서 {marketMeta.label} 종목을 선택하면 동일 신호 identity와 위험·비용 evidence를 서버에서 다시 검증해 Paper 포지션을 준비합니다.
          </p>
          <button type="button" className="mt-3 min-h-11 w-full rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground" onClick={() => navigate('/scanner')}>
            {marketMeta.label} 신호 선택하기
          </button>
        </section>
      )}

      {market === 'crypto_futures' ? (
        <details className="rounded-2xl border border-card-border bg-card">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-xs font-bold [&::-webkit-details-marker]:hidden">
            <span>기존 코인선물 수동 시뮬레이터</span>
            <span className="text-muted-foreground">선택 기능 ⌄</span>
          </summary>
          <div className="border-t border-card-border p-2 [&>main]:!h-auto [&>main]:!overflow-visible [&>main]:!pb-0">
            <PaperTradingPanel key={userId + ':' + paperRevision} storage={paperStorage} futuresEnabled={canFutures} compact />
          </div>
        </details>
      ) : null}
    </div>
  );

  const settings = mode === 'auto' ? (
    <div className="space-y-3" data-testid="auto-trading-settings-column">
      <details
        className="rounded-2xl border border-card-border bg-card"
        data-testid="auto-trading-advanced-settings"
        open
      >
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <span>{marketMeta.label} · 자동매매 설정</span>
          <span aria-hidden className="text-muted-foreground">⌄</span>
        </summary>
        <div className="border-t border-card-border p-3 sm:p-4">
          <TradeAutomationSettings fixture={fixture} selectedMarket={market} canManagePilot={canManagePilot} />
        </div>
      </details>
      <details className="rounded-2xl border border-card-border bg-card">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <span>알림 · 텔레그램</span>
          <span aria-hidden className="text-muted-foreground">⌄</span>
        </summary>
        <div className="border-t border-card-border p-3 sm:p-4">
          <UserBrokerTelegramPanel />
        </div>
      </details>
    </div>
  ) : (
    <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="paper-trading-settings">
      <div className="flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">모의매매 설정</h2>
      </div>
      <div className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
        <p>시장 선택은 상단 4시장 버튼에서 통합 관리합니다.</p>
        <p>Canonical Paper는 실제 거래소 주문을 전송하지 않으며, 수량·레버리지·진입가격은 서버 evidence가 결정합니다.</p>
        <p>코인선물 수동 시뮬레이터는 포지션·주문 탭에서만 선택적으로 열 수 있습니다.</p>
      </div>
    </section>
  );

  const journal = (
    <div className="space-y-3" data-testid="trading-workspace-journal">
      <UnifiedTradeJournalPanel
        forcedMarket={marketMeta.journalMarket}
        title="매매일지"
        description={marketMeta.label + ' · 직접매매/자동매매/자동모의매매를 분리하고 기간조회·엑셀 다운로드를 지원합니다. 비용 근거가 없으면 순손익을 임의로 0으로 만들지 않습니다.'}
      />
      {mode === 'paper' && userId ? (
        <details className="rounded-2xl border border-card-border bg-card" data-testid="paper-journal-sync-tools">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <span>로컬 모의기록 동기화·분석</span>
            <span aria-hidden className="text-muted-foreground">선택 기능 ⌄</span>
          </summary>
          <div className="border-t border-card-border p-3">
            <PaperJournalSyncAnalyticsPanel
              userId={userId}
              rootStorage={window.localStorage}
              paperStorage={paperStorage}
              onLocalStateChanged={() => setPaperRevision((value) => value + 1)}
            />
          </div>
        </details>
      ) : null}
    </div>
  );

  const sectionContent = section === 'dashboard'
    ? dashboard
    : section === 'orders'
      ? orders
      : section === 'journal'
        ? journal
        : section === 'rehearsal'
          ? <FormulaAiAutoRehearsalPanel />
          : settings;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground" data-testid={initialMode === 'paper' ? 'paper-trading-shell' : 'auto-trading-page'}>
      {!embedded ? <CenteredPageHeader title={initialMode === 'paper' ? '모의매매' : '자동매매'} /> : null}

      <main className={embedded
        ? 'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4'
        : 'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:px-4 sm:pt-4'}>
        <div className="mx-auto w-full max-w-6xl space-y-3" data-testid="auto-trading-responsive-layout">
          <div className="grid grid-cols-2 gap-2" data-testid="trading-mode-tabs">
            <SegmentedButton active={mode === 'auto'} disabled={!canAuto} onClick={() => changeMode('auto')} testId="trading-mode-auto">자동매매</SegmentedButton>
            <SegmentedButton active={mode === 'paper'} disabled={!canPaper} onClick={() => changeMode('paper')} testId="trading-mode-paper">모의매매</SegmentedButton>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="매매 시장 선택" data-testid="trading-market-tabs">
            {MARKETS.map((item) => (
              <SegmentedButton
                key={item.value}
                active={market === item.value}
                disabled={item.value === 'crypto_futures' && !canFutures}
                onClick={() => setMarket(item.value)}
                testId={'trading-market-' + item.value}
              >
                {item.label}
              </SegmentedButton>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="매매 화면 선택" data-testid="trading-section-tabs">
            {SECTIONS.map((item) => (
              <SegmentedButton key={item.value} active={section === item.value} onClick={() => setSection(item.value)} testId={'trading-section-' + item.value}>
                {item.label}
              </SegmentedButton>
            ))}
          </div>

          {sectionContent}

          <section className="rounded-2xl border border-card-border bg-card p-3 text-xs text-muted-foreground" data-testid="trading-workspace-safety-note">
            <div className="flex items-start gap-2">
              <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="break-keep leading-5">
                자동매매와 모의매매는 같은 4시장 UI와 매매일지를 사용하지만 실행 권한은 분리됩니다. LIVE/AUTO/REAL/Private API Gate는 이 UI 변경으로 켜지지 않습니다.
              </p>
            </div>
          </section>
        </div>
      </main>
      {!embedded ? <BottomNav /> : null}
    </div>
  );
}

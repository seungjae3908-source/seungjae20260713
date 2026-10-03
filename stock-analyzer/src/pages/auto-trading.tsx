import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { CheckCircle2, ClipboardList, Settings2, ShieldCheck, WalletCards, X } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { PaperJournalSyncAnalyticsPanel } from '@/components/paper-journal-sync-analytics-panel';
import { PaperTradingPanel } from '@/components/paper-trading-panel';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import { TradeAutomationSettings } from '@/components/trade-automation-settings';
import { UnifiedTradeJournalPanel } from '@/components/unified-trade-journal-panel';
import { UserBrokerTelegramPanel } from '@/components/user-broker-telegram-panel';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAnalysisSelection } from '@/lib/analysis-selection';
import { useAuth } from '@/lib/auth';
import { createUserPaperStorage } from '@/lib/paper-journal-sync-storage';

type TradeAutomationFixture = ComponentProps<typeof TradeAutomationSettings>['fixture'];

type TradingMode = 'auto' | 'paper';
type TradingMarket = 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
type TradingSection = 'dashboard' | 'orders' | 'journal' | 'settings';

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
  { value: 'us_stock', label: '미국주식', journalMarket: 'US_STOCK', selectionMarket: 'US', provider: 'Toss / Kiwoom' },
  { value: 'crypto_spot', label: '코인현물', journalMarket: 'CRYPTO_SPOT', selectionMarket: 'UPBIT', provider: 'Upbit' },
  { value: 'crypto_futures', label: '코인선물', journalMarket: 'CRYPTO_FUTURES', selectionMarket: 'BITGET', provider: 'Bitget' },
];

const SECTIONS: Array<{ value: TradingSection; label: string }> = [
  { value: 'dashboard', label: '대시보드' },
  { value: 'orders', label: '포지션·주문' },
  { value: 'journal', label: '매매일지' },
  { value: 'settings', label: '설정' },
];

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-background p-2.5 text-center">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 flex min-w-0 items-center justify-center gap-1.5 text-xs font-semibold">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
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

function PopupPanel({
  title,
  open,
  onClose,
  children,
  testId,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      data-testid={testId ? `${testId}-overlay` : undefined}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-t-3xl border border-card-border bg-background shadow-2xl sm:rounded-3xl"
        data-testid={testId}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-card-border bg-background p-4">
          <h2 className="text-base font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border" aria-label="닫기">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-3 sm:p-4">{children}</div>
      </section>
    </div>
  );
}

export default function AutoTradingPage({ fixture, embedded = false, initialMode = 'auto' }: AutoTradingPageProps) {
  const auth = useAuth();
  const { selection } = useAnalysisSelection();
  const [, navigate] = useLocation();
  const userId = auth.user?.id ?? auth.profile?.id ?? '';
  const testFixtureAccess = Boolean(fixture);
  const canAuto = testFixtureAccess || auth.can('canAccessAutoTrading');
  const canPaper = testFixtureAccess || auth.can('canAccessPaperTrading');
  const canFutures = testFixtureAccess || auth.can('canAccessFutures');
  const [mode, setMode] = useState<TradingMode>(initialMode);
  const [market, setMarket] = useState<TradingMarket>('domestic_stock');
  const [section, setSection] = useState<TradingSection>('dashboard');
  const [runtimeStatus, setRuntimeStatus] = useState<TradeAutomationFixture | null>(fixture ?? null);
  const [runtimeLoading, setRuntimeLoading] = useState(!fixture);
  const [paperRevision, setPaperRevision] = useState(0);
  const [manualPaperOpen, setManualPaperOpen] = useState(false);
  const [settingsPopup, setSettingsPopup] = useState<'automation' | 'telegram' | null>(null);
  const [paperSyncOpen, setPaperSyncOpen] = useState(false);
  const paperStorage = useMemo(
    () => userId ? createUserPaperStorage(window.localStorage, userId) : window.localStorage,
    [userId],
  );

  useEffect(() => {
    if (mode === 'auto' && !canAuto && canPaper) setMode('paper');
    if (mode === 'paper' && !canPaper && canAuto) setMode('auto');
  }, [canAuto, canPaper, mode]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setManualPaperOpen(false);
      setSettingsPopup(null);
      setPaperSyncOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    if (fixture) {
      setRuntimeStatus(fixture);
      setRuntimeLoading(false);
      return;
    }
    if (!canAuto && !canPaper) return;
    const controller = new AbortController();
    setRuntimeLoading(true);
    void authorizedFetch('/api/trade-automation/status', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as TradeAutomationFixture & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? '자동매매 상태를 불러오지 못했습니다.');
        if (!controller.signal.aborted) setRuntimeStatus(payload);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRuntimeStatus(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRuntimeLoading(false);
      });
    return () => controller.abort();
  }, [canAuto, canPaper, fixture]);

  const marketMeta = MARKETS.find((item) => item.value === market)!;
  const selectionMatchesMarket = Boolean(selection && selection.market === marketMeta.selectionMarket);
  const policy = runtimeStatus?.policy;
  const marketEnabled = Boolean(policy?.marketEnabled?.[market]);
  const selected거래사 = market === 'crypto_spot'
    ? 'upbit'
    : market === 'crypto_futures'
      ? 'bitget'
      : policy?.stockBrokerByMarket?.[market] ?? 'kiwoom';
  const providerConnection = (runtimeStatus?.connections ?? []).find((item) => item.exchange === selected거래사);
  const lastOrder = runtimeStatus?.lastOrder;
  const emergencyStopped = runtimeStatus?.emergencyStopped === true;

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
            {runtimeLoading ? '확인 중' : policy?.automaticEnabled ? '자동 실행 켜짐' : '자동 실행 꺼짐'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <StatusItem label="주문별 승인" value="불필요" />
          <StatusItem label="시장 제어" value="4시장" />
          <StatusItem label="위험검사" value="매 주문 재검증" />
        </div>
        <p className="mt-3 break-keep text-xs leading-5 text-muted-foreground">
          4시장 개별 켜짐/OFF로 시장별 자동 실행을 제어하며, 주문마다 승인을 요청하지 않습니다. 실제 주문 권한은 서버 Gate를 통과해야 합니다.
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
            marketEnabled && !emergencyStopped ? 'bg-emerald-500/10 text-emerald-700' : 'bg-muted text-muted-foreground',
          ].join(' ')}>
            {marketEnabled && !emergencyStopped ? '시장 켜짐' : '시장 꺼짐'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatusItem label="연결" value={providerConnection?.configured ? '설정됨' : '미설정'} />
          <StatusItem label="최근 주문" value={lastOrder?.state ?? '없음'} />
          <StatusItem label="비상정지" value={emergencyStopped ? '작동 중' : '정상'} />
          <StatusItem label="실거래" value="별도 승인 필요" />
        </div>
      </section>
    </div>
  ) : (
    <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="paper-trading-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">자동 모의매매 · {marketMeta.label}</h2>
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-bold text-emerald-700">실주문 없음</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatusItem label="자동 실행" value={policy?.automaticEnabled && marketEnabled ? '켜짐' : '꺼짐'} />
        <StatusItem label="시장" value={marketEnabled ? '켜짐' : '꺼짐'} />
        <StatusItem label="연결" value={providerConnection?.configured ? '설정됨' : '미설정'} />
        <StatusItem label="최근 주문" value={lastOrder?.state ?? '없음'} />
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
        <StatusItem label="거래사" value={marketMeta.provider} />
        <StatusItem label="연결" value={providerConnection?.configured ? '설정됨' : '미설정'} />
        <StatusItem label="자동 실행" value={policy?.automaticEnabled && marketEnabled ? '켜짐' : '꺼짐'} />
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
            AI 검색기에서 {marketMeta.label} 종목을 선택하면 동일 신호 identity와 위험·비용 evidence를 서버에서 다시 검증해 모의 포지션을 준비합니다.
          </p>
          <button type="button" className="mt-3 min-h-11 w-full rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground" onClick={() => navigate('/scanner')}>
            {marketMeta.label} 신호 선택하기
          </button>
        </section>
      )}

      {market === 'crypto_futures' ? (
        <>
          <button type="button" onClick={() => setManualPaperOpen(true)} className="min-h-11 w-full rounded-xl border border-card-border bg-card px-4 text-sm font-bold">
            수동 모의매매
          </button>
          {manualPaperOpen ? (
            <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setManualPaperOpen(false); }}>
              <section role="dialog" aria-modal="true" aria-label="수동 모의매매" className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-t-3xl border border-card-border bg-background shadow-2xl sm:rounded-3xl">
                <div className="sticky top-0 z-10 flex items-center justify-between border-b border-card-border bg-background p-4"><h2 className="text-base font-bold">수동 모의매매</h2><button type="button" onClick={() => setManualPaperOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border" aria-label="닫기"><X className="h-4 w-4" /></button></div>
                <div className="[&>main]:!h-auto [&>main]:!overflow-visible [&>main]:!pb-0"><PaperTradingPanel key={userId + ':' + paperRevision} storage={paperStorage} futuresEnabled={canFutures} compact /></div>
              </section>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );

  const settings = (
    <section className="rounded-2xl border border-card-border bg-card p-4" data-testid={mode === 'auto' ? 'auto-trading-settings-column' : 'paper-trading-settings'}>
      <div className="mb-3 flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold">{mode === 'auto' ? '자동매매 설정' : '자동 모의매매 설정'}</h2>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setSettingsPopup('automation')}
          className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold"
          data-testid="open-trading-automation-settings"
        >
          {marketMeta.label} 설정
        </button>
        {mode === 'auto' ? (
          <button
            type="button"
            onClick={() => setSettingsPopup('telegram')}
            className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold"
            data-testid="open-trading-telegram-settings"
          >
            알림 · 텔레그램
          </button>
        ) : null}
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
        <button
          type="button"
          onClick={() => setPaperSyncOpen(true)}
          className="min-h-11 w-full rounded-xl border border-card-border bg-card px-4 text-sm font-bold"
          data-testid="open-paper-journal-sync"
        >
          모의기록 동기화·분석
        </button>
      ) : null}
    </div>
  );

  const sectionContent = section === 'dashboard'
    ? dashboard
    : section === 'orders'
      ? orders
      : section === 'journal'
        ? journal
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
              <SegmentedButton key={item.value} active={market === item.value} onClick={() => setMarket(item.value)} testId={'trading-market-' + item.value}>
                {item.label}
              </SegmentedButton>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="매매 화면 선택" data-testid="trading-section-tabs">
            {SECTIONS.map((item) => (
              <SegmentedButton key={item.value} active={section === item.value} onClick={() => setSection(item.value)} testId={'trading-section-' + item.value}>
                {item.label}
              </SegmentedButton>
            ))}
          </div>

          {sectionContent}


        </div>
      </main>
      <PopupPanel
        title={`${marketMeta.label} · ${mode === 'auto' ? '자동매매 설정' : '자동 모의매매 설정'}`}
        open={settingsPopup === 'automation'}
        onClose={() => setSettingsPopup(null)}
        testId="trading-automation-settings-dialog"
      >
        <TradeAutomationSettings fixture={fixture} selectedMarket={market} />
      </PopupPanel>

      <PopupPanel
        title="알림 · 텔레그램"
        open={settingsPopup === 'telegram'}
        onClose={() => setSettingsPopup(null)}
        testId="trading-telegram-settings-dialog"
      >
        <UserBrokerTelegramPanel />
      </PopupPanel>

      <PopupPanel
        title="모의기록 동기화·분석"
        open={paperSyncOpen}
        onClose={() => setPaperSyncOpen(false)}
        testId="paper-journal-sync-dialog"
      >
        {userId ? (
          <PaperJournalSyncAnalyticsPanel
            userId={userId}
            rootStorage={window.localStorage}
            paperStorage={paperStorage}
            onLocalStateChanged={() => setPaperRevision((value) => value + 1)}
          />
        ) : null}
      </PopupPanel>

      {!embedded ? <BottomNav /> : null}
    </div>
  );
}

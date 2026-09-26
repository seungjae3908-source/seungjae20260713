import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { BookOpenCheck, CheckCircle2, ClipboardList, Settings2, ShieldCheck, WalletCards } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
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
  const paperStorage = useMemo(
    () => userId ? createUserPaperStorage(window.localStorage, userId) : window.localStorage,
    [userId],
  );

  useEffect(() => {
    if (mode === 'auto' && !canAuto && canPaper) setMode('paper');
    if (mode === 'paper' && !canPaper && canAuto) setMode('auto');
  }, [canAuto, canPaper, mode]);

  useEffect(() => {
    if (fixture) {
      setRuntimeStatus(fixture);
      setRuntimeLoading(false);
      return;
    }
    if (!canAuto) return;
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
  }, [canAuto, fixture]);

  const marketMeta = MARKETS.find((item) => item.value === market)!;
  const selectionMatchesMarket = Boolean(selection && selection.market === marketMeta.selectionMarket);
  const policy = runtimeStatus?.policy;
  const marketEnabled = Boolean(policy?.marketEnabled?.[market]);
  const selectedProvider = market === 'crypto_spot'
    ? 'upbit'
    : market === 'crypto_futures'
      ? 'bitget'
      : policy?.stockBrokerByMarket?.[market] ?? 'kiwoom';
  const providerConnection = runtimeStatus?.connections.find((item) => item.exchange === selectedProvider);
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
            {runtimeLoading ? '확인 중' : policy?.automaticEnabled ? '자동 실행 ON' : '자동 실행 OFF'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <StatusItem label="주문별 승인" value="불필요" />
          <StatusItem label="시장 제어" value="4시장" />
          <StatusItem label="위험검사" value="매 주문 재검증" />
        </div>
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
            {marketEnabled && !emergencyStopped ? '시장 ON' : '시장 OFF'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatusItem label="연결" value={providerConnection?.configured ? '설정됨' : '미설정'} />
          <StatusItem label="최근 주문" value={lastOrder?.state ?? '없음'} />
          <StatusItem label="비상정지" value={emergencyStopped ? '작동 중' : '정상'} />
          <StatusItem label="실거래 권한" value="서버 Gate 필요" />
        </div>
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
        <StatusItem label="Provider" value={marketMeta.provider} />
        <StatusItem label="연결" value={providerConnection?.configured ? '설정됨' : '미설정'} />
        <StatusItem label="자동 실행" value={policy?.automaticEnabled && marketEnabled ? 'ON' : 'OFF'} />
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
            <PaperTradingPanel storage={paperStorage} futuresEnabled={canFutures} compact />
          </div>
        </details>
      ) : null}
    </div>
  );

  const settings = mode === 'auto' ? (
    <div className="space-y-3" data-testid="auto-trading-settings-column">
      <details className="rounded-2xl border border-card-border bg-card" open>
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <span>{marketMeta.label} · 자동매매 설정</span>
          <span aria-hidden className="text-muted-foreground">⌄</span>
        </summary>
        <div className="border-t border-card-border p-3 sm:p-4">
          <TradeAutomationSettings fixture={fixture} selectedMarket={market} />
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
    <div data-testid="trading-workspace-journal">
      <UnifiedTradeJournalPanel
        forcedMarket={marketMeta.journalMarket}
        forcedSource={mode === 'auto' ? 'APP_AUTO' : 'APP_PAPER'}
        title={mode === 'auto' ? '자동매매 매매일지' : '모의매매 매매일지'}
        description={marketMeta.label + ' 거래만 표시합니다. 비용 근거가 없으면 순손익을 임의로 0으로 만들지 않습니다.'}
      />
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
      {!embedded ? <CenteredPageHeader title="매매" /> : null}

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-24 sm:p-4">
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

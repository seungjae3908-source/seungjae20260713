import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowLeft,
  ChevronLeft,
  Home,
  Newspaper,
  Search,
  Settings,
  Star,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  useMemberPermissions,
  type AppFeature,
} from '@/lib/permissions';
import { cn } from '@/lib/utils';

type PopupKind = 'markets' | 'tech' | 'info';
type PopupStep = 'main' | 'stocks' | 'coins' | 'marketAnalysis';

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  feature: AppFeature;
  popup?: PopupKind;
  match: (path: string, location: string) => boolean;
};

type PopupItem = {
  label: string;
  href?: string;
  step?: PopupStep;
  feature?: AppFeature;
};

const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    label: '홈',
    icon: Home,
    feature: 'advancedAnalysis',
    match: (path) => path === '/' || path === '/home',
  },
  {
    href: '/search',
    label: '종목',
    icon: TrendingUp,
    feature: 'basicChart',
    popup: 'markets',
    match: (path) =>
      path === '/search' ||
      path === '/stocks' ||
      path.startsWith('/stocks/') ||
      path.startsWith('/coins/') ||
      path.startsWith('/stock/'),
  },
  {
    href: '/watchlist',
    label: '관심',
    icon: Star,
    feature: 'basicChart',
    match: (path) => path.startsWith('/watchlist') || path.startsWith('/alerts'),
  },
  {
    href: '/tech',
    label: '기술',
    icon: Search,
    feature: 'aiRealtimeChart',
    popup: 'tech',
    match: (path) =>
      path.startsWith('/tech') ||
      path.startsWith('/scanner') ||
      path.startsWith('/auto-trading'),
  },
  {
    href: '/stock-info',
    label: '정보',
    icon: Newspaper,
    feature: 'advancedAnalysis',
    popup: 'info',
    match: (path) =>
      path.startsWith('/stock-info') ||
      path.startsWith('/learn') ||
      path.startsWith('/analysis/') ||
      path.startsWith('/portfolio'),
  },
  {
    href: '/more',
    label: '설정',
    icon: Settings,
    feature: 'basicChart',
    match: (path) =>
      path.startsWith('/more') ||
      path.startsWith('/settings') ||
      path.startsWith('/account') ||
      path.startsWith('/login') ||
      path.startsWith('/admin'),
  },
];

const STOCK_ITEMS: PopupItem[] = [
  { label: '국내주식', href: '/stocks/kr' },
  { label: '해외주식', href: '/stocks/us' },
];

const COIN_ITEMS: PopupItem[] = [
  { label: '코인 현물', href: '/coins/spot' },
  { label: '코인 선물', href: '/coins/futures', feature: 'futures' },
];

const TECH_ITEMS: PopupItem[] = [
  { label: '신호검색', href: '/tech/signal-scan' },
  { label: '실시간 차트 분석', href: '/tech/chart-relay' },
  { label: '자동매매', href: '/tech/auto-trade', feature: 'autoTrading' },
];

const INFO_MAIN_ITEMS: PopupItem[] = [
  { label: '주식 정보', step: 'stocks' },
  { label: '코인 정보', step: 'coins' },
  { label: '공부', href: '/learn' },
  { label: '시황', step: 'marketAnalysis' },
  { label: '포트폴리오', href: '/portfolio' },
];

const INFO_STOCK_ITEMS: PopupItem[] = [
  {
    label: '국내주식 정보',
    href: '/stock-info?asset=stock&market=KR',
  },
  {
    label: '해외주식 정보',
    href: '/stock-info?asset=stock&market=US',
  },
];

const INFO_COIN_ITEMS: PopupItem[] = [
  {
    label: '코인 현물 정보',
    href: '/stock-info?asset=coin&coinMarket=spot',
  },
  {
    label: '코인 선물 정보',
    href: '/stock-info?asset=coin&coinMarket=futures',
    feature: 'futures',
  },
];

const MARKET_ANALYSIS_ITEMS: PopupItem[] = [
  { label: '국내 시황', href: '/analysis/KR' },
  { label: '해외 시황', href: '/analysis/US' },
];

function splitLocation(location: string) {
  const [pathPart, queryPart = ''] = location.split('?');
  return {
    path: pathPart || '/',
    query: queryPart,
  };
}

function isFullScreenLocation(location: string): boolean {
  const { path, query } = splitLocation(location);

  if (path === '/stocks' && query) return true;
  if (path === '/stock-info' && query) return true;

  return (
    path === '/stocks/kr' ||
    path === '/stocks/us' ||
    path.startsWith('/coins/') ||
    path.startsWith('/stock/') ||
    path.startsWith('/analysis/') ||
    path.startsWith('/tech/') ||
    path.startsWith('/scanner') ||
    path.startsWith('/auto-trading') ||
    path.startsWith('/alerts') ||
    path.startsWith('/portfolio') ||
    path.startsWith('/recommendations') ||
    path.startsWith('/account') ||
    path.startsWith('/admin') ||
    path.startsWith('/learn')
  );
}

function popupTitle(kind: PopupKind, step: PopupStep): string {
  if (kind === 'tech') return '기술 선택';
  if (kind === 'markets') {
    if (step === 'stocks') return '주식';
    if (step === 'coins') return '코인';
    return '종목 선택';
  }

  if (step === 'stocks') return '주식 정보';
  if (step === 'coins') return '코인 정보';
  if (step === 'marketAnalysis') return '시황';
  return '정보 선택';
}

export function BottomNav() {
  const [location, navigate] = useLocation();
  const permissions = useMemberPermissions();
  const { path } = splitLocation(location);
  const [popup, setPopup] = useState<PopupKind | null>(null);
  const [step, setStep] = useState<PopupStep>('main');

  const visibleItems = useMemo(
    () => NAV_ITEMS.filter((item) => permissions.has(item.feature)),
    [permissions],
  );

  const fullScreen = isFullScreenLocation(location);

  const closePopup = () => {
    setPopup(null);
    setStep('main');
  };

  const openPopup = (kind: PopupKind) => {
    if (popup === kind) {
      closePopup();
      return;
    }
    setPopup(kind);
    setStep('main');
  };

  const moveToPage = (href: string) => {
    closePopup();
    navigate(href);
  };

  const goBack = () => {
    closePopup();
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate('/search', { replace: true });
  };

  const currentItems = useMemo<PopupItem[]>(() => {
    if (popup === 'tech') return TECH_ITEMS;
    if (popup === 'markets') {
      if (step === 'stocks') return STOCK_ITEMS;
      if (step === 'coins') return COIN_ITEMS;
      return [
        { label: '주식', step: 'stocks' },
        { label: '코인', step: 'coins' },
      ];
    }
    if (popup === 'info') {
      if (step === 'stocks') return INFO_STOCK_ITEMS;
      if (step === 'coins') return INFO_COIN_ITEMS;
      if (step === 'marketAnalysis') return MARKET_ANALYSIS_ITEMS;
      return INFO_MAIN_ITEMS;
    }
    return [];
  }, [popup, step]);

  const allowedPopupItems = currentItems.filter(
    (item) => !item.feature || permissions.has(item.feature),
  );

  if (!visibleItems.length) return null;

  if (fullScreen && !popup) {
    return (
      <button
        type="button"
        onClick={goBack}
        aria-label="이전 화면"
        className="fixed left-4 top-[calc(env(safe-area-inset-top)+14px)] z-50 flex h-10 items-center gap-1.5 rounded-full border border-card-border bg-background/95 px-3 text-sm font-extrabold text-foreground shadow-lg backdrop-blur-xl transition active:scale-95"
      >
        <ArrowLeft className="h-5 w-5" />
        <span>이전</span>
      </button>
    );
  }

  return (
    <>
      {popup && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center px-5"
          onClick={closePopup}
          role="presentation"
        >
          <div className="absolute inset-0 bg-black/80 backdrop-blur-[2px]" />

          <section
            role="dialog"
            aria-modal="true"
            aria-label={popupTitle(popup, step)}
            className="relative z-10 w-full max-w-[350px] rounded-3xl border border-white/10 bg-[#090b10] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.8)]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={closePopup}
              aria-label="팝업 닫기"
              className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[#171a21] text-white transition active:scale-95"
            >
              <X className="h-5 w-5" />
            </button>

            {step !== 'main' && popup !== 'tech' && (
              <button
                type="button"
                onClick={() => setStep('main')}
                aria-label="이전 선택"
                className="absolute left-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[#171a21] text-white transition active:scale-95"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}

            <h2 className="mb-5 px-12 text-center text-lg font-extrabold text-white">
              {popupTitle(popup, step)}
            </h2>

            <div className="grid grid-cols-1 gap-3">
              {allowedPopupItems.map((item) => (
                <button
                  key={`${item.label}:${item.href ?? item.step}`}
                  type="button"
                  onClick={() => {
                    if (item.step) {
                      setStep(item.step);
                      return;
                    }
                    if (item.href) moveToPage(item.href);
                  }}
                  className="flex min-h-[56px] w-full items-center justify-center rounded-2xl border border-white/10 bg-[#171a21] px-4 py-3 text-base font-extrabold text-white transition hover:bg-[#20242d] active:scale-[0.98] active:bg-[#252a35]"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-card-border bg-background/90 px-1 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur-xl">
        <div
          className="mx-auto grid max-w-md gap-0.5"
          style={{
            gridTemplateColumns: `repeat(${visibleItems.length}, minmax(0, 1fr))`,
          }}
        >
          {visibleItems.map((item) => {
            const active = item.match(path, location);
            const Icon = item.icon;

            return (
              <button
                key={item.href}
                type="button"
                onClick={() => {
                  if (item.popup) {
                    openPopup(item.popup);
                    return;
                  }
                  closePopup();
                  navigate(item.href);
                }}
                className={cn(
                  'flex min-w-0 flex-col items-center justify-center rounded-2xl px-1 py-2 text-[10px] font-extrabold transition',
                  active
                    ? 'text-primary'
                    : 'text-muted-foreground active:text-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'mb-1 h-5 w-5',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}

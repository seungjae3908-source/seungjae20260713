import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowLeft,
  Home,
  Newspaper,
  Search,
  Settings,
  TrendingUp,
  Star,
} from 'lucide-react';
import {
  useMemberPermissions,
  type AppFeature,
} from '@/lib/permissions';
import { cn } from '@/lib/utils';

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  feature: AppFeature;
  match: (path: string) => boolean;
  popup?: 'markets' | 'tech';
};

type MarketStep = 'main' | 'stocks' | 'coins';

type PopupItem = {
  label: string;
  href: string;
};

const ITEMS: NavItem[] = [
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
      path.startsWith('/stock/') ||
      path.startsWith('/stocks/') ||
      path.startsWith('/coins/'),
  },
  {
    href: '/watchlist',
    label: '관심',
    icon: Star,
    feature: 'basicChart',
    match: (path) =>
      path.startsWith('/watchlist') ||
      path.startsWith('/alerts'),
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
    match: (path) => path.startsWith('/stock-info'),
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
      path.startsWith('/portfolio') ||
      path.startsWith('/admin'),
  },
];

const STOCK_ITEMS: PopupItem[] = [
  {
    label: '국내주식',
    href: '/stocks/kr',
  },
  {
    label: '해외주식',
    href: '/stocks/us',
  },
];

const COIN_ITEMS: PopupItem[] = [
  {
    label: '코인 현물',
    href: '/coins/spot',
  },
  {
    label: '코인 선물',
    href: '/coins/futures',
  },
];

const TECH_ITEMS: PopupItem[] = [
  {
    label: '신호검색',
    href: '/tech/signal-scan',
  },
  {
    label: '차트중계',
    href: '/tech/chart-relay',
  },
  {
    label: '자동매매',
    href: '/tech/auto-trade',
  },
];

const MAIN_PAGE_PATHS = new Set([
  '/',
  '/home',
  '/search',
  '/watchlist',
  '/tech',
  '/stock-info',
  '/more',
  '/settings',
]);

function cleanPath(path: string) {
  return path.split('?')[0] || '/';
}

function isFullScreenPath(path: string) {
  if (MAIN_PAGE_PATHS.has(path)) {
    return false;
  }

  return (
    path === '/stocks' ||
    path.startsWith('/stocks/') ||
    path.startsWith('/coins/') ||
    path.startsWith('/stock/') ||
    path.startsWith('/analysis/') ||
    path.startsWith('/tech/') ||
    path.startsWith('/scanner') ||
    path.startsWith('/auto-trading') ||
    path.startsWith('/alerts') ||
    path.startsWith('/portfolio/') ||
    path.startsWith('/recommendations') ||
    path.startsWith('/account') ||
    path.startsWith('/admin') ||
    path.startsWith('/learn')
  );
}

export function BottomNav() {
  const [location, navigate] = useLocation();
  const permissions = useMemberPermissions();
  const path = cleanPath(location);

  const [marketsOpen, setMarketsOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  const [marketStep, setMarketStep] =
    useState<MarketStep>('main');

  const visibleItems = useMemo(
    () =>
      ITEMS.filter((item) =>
        permissions.has(item.feature),
      ),
    [permissions],
  );

  const showBackButton = isFullScreenPath(path);
  const anyPopupOpen = marketsOpen || techOpen;

  const closeMarkets = () => {
    setMarketsOpen(false);
    setMarketStep('main');
  };

  const closeTech = () => {
    setTechOpen(false);
  };

  const closeAllPopups = () => {
    closeMarkets();
    closeTech();
  };

  const openMarkets = () => {
    if (marketsOpen) {
      closeMarkets();
      return;
    }

    closeTech();
    setMarketStep('main');
    setMarketsOpen(true);
  };

  const openTech = () => {
    if (techOpen) {
      closeTech();
      return;
    }

    closeMarkets();
    setTechOpen(true);
  };

  const moveToPage = (href: string) => {
    closeAllPopups();
    navigate(href);
  };

  const goBack = () => {
    closeAllPopups();

    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    navigate('/search', {
      replace: true,
    });
  };

  const renderPopupButtons = (
    items: PopupItem[],
  ) => {
    return (
      <div className="grid grid-cols-1 gap-3">
        {items.map((item) => (
          <button
            key={item.href}
            type="button"
            onClick={() => moveToPage(item.href)}
            className="
              flex min-h-[54px] w-full
              items-center justify-center
              rounded-2xl
              border border-white/10
              bg-[#171a21]
              px-4 py-3
              text-base font-extrabold text-white
              transition
              hover:bg-[#20242d]
              active:scale-[0.98]
              active:bg-[#252a35]
            "
          >
            {item.label}
          </button>
        ))}
      </div>
    );
  };

  if (!visibleItems.length) {
    return null;
  }

  return (
    <>
      {showBackButton && !anyPopupOpen && (
        <button
          type="button"
          onClick={goBack}
          aria-label="이전 화면"
          className="
            fixed left-4 top-[calc(env(safe-area-inset-top)+14px)]
            z-50
            flex h-10 items-center gap-1.5
            rounded-full
            border border-card-border
            bg-background/95
            px-3
            text-sm font-extrabold text-foreground
            shadow-lg
            backdrop-blur-xl
            transition
            active:scale-95
          "
        >
          <ArrowLeft className="h-5 w-5" />
          <span>이전</span>
        </button>
      )}

      {marketsOpen && (
        <div
          className="
            fixed inset-0 z-[60]
            flex items-center justify-center
            px-5
          "
          onClick={closeMarkets}
          role="presentation"
        >
          <div className="absolute inset-0 bg-black/80 backdrop-blur-[2px]" />

          <div
            className="
              relative z-10
              w-full max-w-[340px]
              rounded-3xl
              border border-white/10
              bg-[#090b10]
              p-5
              shadow-[0_24px_80px_rgba(0,0,0,0.8)]
            "
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            <button
              type="button"
              onClick={closeMarkets}
              aria-label="팝업 닫기"
              className="
                absolute right-4 top-4
                flex h-9 w-9
                items-center justify-center
                rounded-full
                border border-white/10
                bg-[#171a21]
                text-xl font-bold text-white
                transition
                hover:bg-[#252a35]
                active:scale-95
              "
            >
              ×
            </button>

            {marketStep === 'main' && (
              <>
                <p className="mb-5 px-10 text-center text-lg font-extrabold text-white">
                  종목 선택
                </p>

                <div className="grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      setMarketStep('stocks')
                    }
                    className="
                      flex min-h-[58px] w-full
                      items-center justify-center
                      rounded-2xl
                      border border-white/10
                      bg-[#171a21]
                      px-4 py-3
                      text-lg font-extrabold text-white
                      transition
                      hover:bg-[#20242d]
                      active:scale-[0.98]
                      active:bg-[#252a35]
                    "
                  >
                    주식
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setMarketStep('coins')
                    }
                    className="
                      flex min-h-[58px] w-full
                      items-center justify-center
                      rounded-2xl
                      border border-white/10
                      bg-[#171a21]
                      px-4 py-3
                      text-lg font-extrabold text-white
                      transition
                      hover:bg-[#20242d]
                      active:scale-[0.98]
                      active:bg-[#252a35]
                    "
                  >
                    코인
                  </button>
                </div>
              </>
            )}

            {marketStep === 'stocks' && (
              <>
                <p className="mb-5 px-10 text-center text-lg font-extrabold text-white">
                  주식
                </p>

                {renderPopupButtons(STOCK_ITEMS)}
              </>
            )}

            {marketStep === 'coins' && (
              <>
                <p className="mb-5 px-10 text-center text-lg font-extrabold text-white">
                  코인
                </p>

                {renderPopupButtons(COIN_ITEMS)}
              </>
            )}
          </div>
        </div>
      )}

      {techOpen && (
        <div
          className="
            fixed inset-0 z-[60]
            flex items-center justify-center
            px-5
          "
          onClick={closeTech}
          role="presentation"
        >
          <div className="absolute inset-0 bg-black/80 backdrop-blur-[2px]" />

          <div
            className="
              relative z-10
              w-full max-w-[340px]
              rounded-3xl
              border border-white/10
              bg-[#090b10]
              p-5
              shadow-[0_24px_80px_rgba(0,0,0,0.8)]
            "
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            <button
              type="button"
              onClick={closeTech}
              aria-label="팝업 닫기"
              className="
                absolute right-4 top-4
                flex h-9 w-9
                items-center justify-center
                rounded-full
                border border-white/10
                bg-[#171a21]
                text-xl font-bold text-white
                transition
                hover:bg-[#252a35]
                active:scale-95
              "
            >
              ×
            </button>

            <p className="mb-5 px-10 text-center text-lg font-extrabold text-white">
              기술
            </p>

            {renderPopupButtons(TECH_ITEMS)}
          </div>
        </div>
      )}

      <nav
        className="
          fixed inset-x-0 bottom-0 z-40
          border-t border-card-border
          bg-background/90
          px-1
          pb-[env(safe-area-inset-bottom)]
          pt-2
          backdrop-blur-xl
        "
      >
        <div
          className="mx-auto grid max-w-md gap-0.5"
          style={{
            gridTemplateColumns: `repeat(${visibleItems.length}, minmax(0, 1fr))`,
          }}
        >
          {visibleItems.map((item) => {
            const active = item.match(path);
            const Icon = item.icon;

            return (
              <button
                key={item.href}
                type="button"
                onClick={() => {
                  if (item.popup === 'markets') {
                    openMarkets();
                    return;
                  }

                  if (item.popup === 'tech') {
                    openTech();
                    return;
                  }

                  closeAllPopups();
                  navigate(item.href);
                }}
                className={cn(
                  `
                    flex min-w-0 flex-col
                    items-center justify-center
                    rounded-2xl
                    px-1 py-2
                    text-[10px] font-extrabold
                    transition
                  `,
                  active
                    ? 'text-primary'
                    : 'text-muted-foreground active:text-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'mb-1 h-5 w-5',
                    active
                      ? 'text-primary'
                      : 'text-muted-foreground',
                  )}
                />

                <span className="truncate">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
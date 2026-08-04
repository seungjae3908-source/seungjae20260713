import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import {
  BarChart3, BookOpen, Bot, BriefcaseBusiness, CandlestickChart, Home, Layers3, Newspaper,
  Power, Search, Settings, Star, TrendingUp, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { MARKET_INFORMATION_ROUTES } from '@/lib/market-information';
import type { MemberCapability } from '../../../packages/member-access/src/index.js';

const INFO_PATHS = [
  ...MARKET_INFORMATION_ROUTES.map((route) => route.href),
  '/stock-info', '/learn', '/market-overview', '/portfolio', '/assets', '/ai-chat',
];
const TECH_PATHS = ['/scanner', '/ai-chart', '/auto-trading'];

const TECH_MENU_ITEMS = [
  { href: '/scanner', label: 'AI 검색기', icon: Search },
  { href: '/ai-chart', label: 'AI 차트 분석기', icon: CandlestickChart },
  { href: '/auto-trading', label: '자동매매', icon: Power },
] as const;

const ITEMS: Array<{
  href: string;
  label: string;
  icon: typeof Home;
  match: (path: string) => boolean;
  popup?: boolean;
  capability?: MemberCapability;
}> = [
  { href: '/', label: '홈', icon: Home, match: (path) => path === '/' },
  { href: '/search', label: '종목', icon: TrendingUp, match: (path) => path === '/search' || path.startsWith('/stock/') },
  { href: '/themes', label: '테마', icon: Layers3, match: (path) => path.startsWith('/themes') },
  { href: '/watchlist', label: '관심', icon: Star, match: (path) => path.startsWith('/watchlist') || path.startsWith('/alerts') },
  { href: '/scanner', label: '기술', icon: Search, popup: true, capability: 'canAccessRiskPreview', match: (path) => TECH_PATHS.some((item) => path.startsWith(item)) },
  { href: '/stocks/kr', label: '정보', icon: Newspaper, popup: true, capability: 'canAccessBasicInfo', match: (path) => INFO_PATHS.some((item) => path.startsWith(item)) },
  { href: '/more', label: '설정', icon: Settings, match: (path) => path.startsWith('/more') || path.startsWith('/settings') || path.startsWith('/account') || path.startsWith('/login') },
];

function cleanPath(path: string) {
  return path.split('?')[0] || '/';
}

export function BottomNav() {
  const [location, navigate] = useLocation();
  const auth = useAuth();
  const path = cleanPath(location);
  const [openMenu, setOpenMenu] = useState<'tech' | 'info' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const visibleItems = ITEMS.filter((item) => !item.capability || auth.can(item.capability));
  const visibleMarketInformationRoutes = MARKET_INFORMATION_ROUTES.filter((route) => auth.can(route.capability));

  useEffect(() => { setOpenMenu(null); }, [location]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpenMenu(null);
    }
    function handleKeyDown(event: KeyboardEvent) { if (event.key === 'Escape') setOpenMenu(null); }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  function moveTo(href: string) { setOpenMenu(null); navigate(href); }

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-card-border bg-background/90 px-1 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur-xl">
      <div
        className="mx-auto grid max-w-md gap-0.5"
        style={{ gridTemplateColumns: `repeat(${Math.max(visibleItems.length, 1)}, minmax(0, 1fr))` }}
      >
        {visibleItems.map((item) => {
          const active = item.match(path);
          const Icon = item.icon;
          if (item.popup) {
            const menuType = item.label === '기술' ? 'tech' : 'info';
            const menuOpen = openMenu === menuType;
            return (
              <div key={item.href} ref={menuOpen ? menuRef : undefined} className="relative min-w-0">
                {menuOpen && menuType === 'tech' && (
                  <div role="menu" aria-label="기술 메뉴" className="absolute bottom-full right-0 z-50 mb-3 w-48 overflow-hidden rounded-2xl border border-card-border bg-card p-2 shadow-2xl">
                    {TECH_MENU_ITEMS.map((menuItem) => {
                      const MenuIcon = menuItem.icon;
                      const menuActive = path.startsWith(menuItem.href);
                      return (
                        <button key={menuItem.href} type="button" role="menuitem" onClick={() => moveTo(menuItem.href)} className={cn('flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-extrabold transition', menuActive ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted active:bg-muted')}>
                          <MenuIcon className="h-4 w-4 shrink-0" /><span>{menuItem.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {menuOpen && menuType === 'info' && (
                  <div role="menu" aria-label="정보 메뉴" className="absolute bottom-full right-0 z-50 mb-3 w-56 overflow-hidden rounded-2xl border border-card-border bg-card p-2 shadow-2xl">
                    <div className="mb-1 flex min-h-11 items-center justify-between px-2">
                      <p className="text-sm font-black">시장 정보</p>
                      <button type="button" onClick={() => setOpenMenu(null)} aria-label="정보 메뉴 닫기" className="flex h-11 w-11 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted active:bg-muted">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {(['주식', '코인'] as const).map((group) => {
                      const routes = visibleMarketInformationRoutes.filter((route) => route.group === group);
                      if (routes.length === 0) return null;
                      return (
                        <div key={group} className="mb-2 last:mb-0">
                          <p className="px-3 pb-1 pt-2 text-[10px] font-black text-muted-foreground">{group}</p>
                          <div className="grid grid-cols-2 gap-1">
                            {routes.map((route) => {
                              const menuActive = path === route.href;
                              return (
                                <button key={route.href} type="button" role="menuitem" onClick={() => moveTo(route.href)} className={cn('min-h-11 rounded-xl px-3 py-3 text-center text-sm font-extrabold transition', menuActive ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted active:bg-muted')}>
                                  {route.shortLabel}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setOpenMenu((previous) => previous === menuType ? null : menuType)} className={cn('flex w-full min-w-0 flex-col items-center justify-center rounded-2xl px-1 py-2 text-[10px] font-extrabold transition', active || menuOpen ? 'text-primary' : 'text-muted-foreground active:text-foreground')}>
                  <Icon className={cn('mb-1 h-5 w-5', active || menuOpen ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="truncate">{item.label}</span>
                </button>
              </div>
            );
          }
          return (
            <button key={item.href} type="button" onClick={() => moveTo(item.href)} className={cn('flex min-w-0 flex-col items-center justify-center rounded-2xl px-1 py-2 text-[10px] font-extrabold transition', active ? 'text-primary' : 'text-muted-foreground active:text-foreground')}>
              <Icon className={cn('mb-1 h-5 w-5', active ? 'text-primary' : 'text-muted-foreground')} />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

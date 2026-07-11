import { useLocation } from 'wouter';
import {
  Home,
  Newspaper,
  Search,
  Settings,
  TrendingUp,
  WalletCards,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  {
    href: '/',
    label: '홈',
    icon: Home,
    match: (path: string) => path === '/',
  },
  {
    href: '/search',
    label: '주식',
    icon: TrendingUp,
    match: (path: string) =>
      path === '/search' ||
      path.startsWith('/stock/') ||
      path.startsWith('/watchlist'),
  },
  {
    href: '/scanner',
    label: '검색기',
    icon: Search,
    match: (path: string) => path.startsWith('/scanner'),
  },
  {
    href: '/stock-info',
    label: '정보',
    icon: Newspaper,
    match: (path: string) => path.startsWith('/stock-info'),
  },
  {
    href: '/portfolio',
    label: '자산',
    icon: WalletCards,
    match: (path: string) =>
      path.startsWith('/portfolio') ||
      path.startsWith('/account') ||
      path.startsWith('/login') ||
      path.startsWith('/alerts'),
  },
  {
    href: '/more',
    label: '설정',
    icon: Settings,
    match: (path: string) =>
      path.startsWith('/more') || path.startsWith('/settings'),
  },
];

function cleanPath(path: string) {
  return path.split('?')[0] || '/';
}

export function BottomNav() {
  const [location, navigate] = useLocation();
  const path = cleanPath(location);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-card-border bg-background/90 px-1 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur-xl">
      <div className="mx-auto grid max-w-md grid-cols-6 gap-0.5">
        {ITEMS.map((item) => {
          const active = item.match(path);
          const Icon = item.icon;

          return (
            <button
              key={item.href}
              type="button"
              onClick={() => navigate(item.href)}
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
  );
}

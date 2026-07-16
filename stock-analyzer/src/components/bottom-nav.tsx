import { useLocation } from 'wouter';
import { Bot, Home, ListTree, Newspaper, Settings, WalletCards } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  {
    href: '/home',
    label: '홈',
    icon: Home,
    match: (path: string) => path === '/' || path === '/home',
  },
  {
    href: '/stocks',
    label: '종목',
    icon: ListTree,
    match: (path: string) =>
      path === '/stocks' ||
      path.startsWith('/search') ||
      path.startsWith('/scanner') ||
      path.startsWith('/themes') ||
      path.startsWith('/stock/') ||
      path.startsWith('/watchlist'),
  },
  {
    href: '/auto-trading',
    label: '자동매매',
    icon: Bot,
    match: (path: string) => path.startsWith('/auto-trading'),
  },
  {
    href: '/stock-info',
    label: '정보',
    icon: Newspaper,
    match: (path: string) => path.startsWith('/stock-info') || path.startsWith('/learn'),
  },
  {
    href: '/assets',
    label: '자산',
    icon: WalletCards,
    match: (path: string) => path.startsWith('/assets') || path.startsWith('/portfolio'),
  },
  {
    href: '/settings',
    label: '설정',
    icon: Settings,
    match: (path: string) =>
      path.startsWith('/settings') ||
      path.startsWith('/more') ||
      path.startsWith('/account') ||
      path.startsWith('/admin') ||
      path.startsWith('/alerts'),
  },
];

function cleanPath(path: string) {
  return path.split('?')[0] || '/';
}

export function BottomNav() {
  const [location, navigate] = useLocation();
  const path = cleanPath(location);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-card-border bg-background/95 px-1 pb-[max(env(safe-area-inset-bottom),0.35rem)] pt-1.5 backdrop-blur-xl">
      <div className="mx-auto grid max-w-md grid-cols-6 gap-0.5">
        {ITEMS.map((item) => {
          const active = item.match(path);
          const Icon = item.icon;
          return (
            <button
              key={item.href}
              type="button"
              onClick={() => navigate(item.href)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-w-0 flex-col items-center justify-center rounded-xl px-0.5 py-1.5 text-[9px] font-extrabold transition',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground active:bg-secondary active:text-foreground',
              )}
            >
              <Icon className="mb-0.5 h-[18px] w-[18px]" />
              <span className="max-w-full truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

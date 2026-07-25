import { useLocation } from "wouter";
import {
  Home,
  Layers3,
  Newspaper,
  Search,
  Settings,
  TrendingUp,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from '@/lib/auth';

const ITEMS = [
  {
    href: "/",
    label: "홈",
    icon: Home,
    match: (path: string) => path === "/",
  },
  {
    href: "/search",
    label: "종목",
    icon: TrendingUp,
    match: (path: string) => path === "/search" || path.startsWith("/stock/"),
  },
  {
    href: "/themes",
    label: "테마",
    icon: Layers3,
    match: (path: string) => path.startsWith("/themes"),
  },
  {
    href: "/watchlist",
    label: "관심",
    icon: Star,
    match: (path: string) =>
      path.startsWith("/watchlist") || path.startsWith("/alerts"),
  },
  {
    href: "/scanner",
    label: "기술",
    icon: Search,
    match: (path: string) => path.startsWith("/scanner"),
  },
  {
    href: "/stock-info",
    label: "정보",
    icon: Newspaper,
    match: (path: string) => path.startsWith("/stock-info"),
  },
  {
    href: "/more",
    label: "설정",
    icon: Settings,
    match: (path: string) =>
      path.startsWith("/more") ||
      path.startsWith("/settings") ||
      path.startsWith("/account") ||
      path.startsWith("/login") ||
      path.startsWith("/portfolio"),
  },
];

function cleanPath(path: string) {
  return path.split("?")[0] || "/";
}

function resetPagePosition() {
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  document.querySelectorAll<HTMLElement>(".overflow-y-auto, .overflow-auto").forEach((element) => {
    element.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
  document.querySelectorAll<HTMLElement>(".overflow-x-auto").forEach((element) => {
    element.scrollLeft = 0;
  });
}

export function BottomNav() {
  const [location, navigate] = useLocation();
  const auth = useAuth();
  const path = cleanPath(location);
  const visibleItems = auth.isFullMember ? ITEMS : ITEMS.filter((item) => item.href !== '/scanner' && item.href !== '/themes');

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-card-border bg-background/90 px-1 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur-xl">
      <div className={cn('mx-auto grid max-w-md gap-0.5', visibleItems.length === 7 ? 'grid-cols-7' : 'grid-cols-5')}>
        {visibleItems.map((item) => {
          const active = item.match(path);
          const Icon = item.icon;

          return (
            <button
              key={item.href}
              type="button"
              onClick={() => {
                resetPagePosition();
                navigate(item.href);
              }}
              className={cn(
                "flex min-w-0 flex-col items-center justify-center rounded-2xl px-1 py-2 text-[10px] font-extrabold transition",
                active
                  ? "text-primary"
                  : "text-muted-foreground active:text-foreground",
              )}
            >
              <Icon
                className={cn(
                  "mb-1 h-5 w-5",
                  active ? "text-primary" : "text-muted-foreground",
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

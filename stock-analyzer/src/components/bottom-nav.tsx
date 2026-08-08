import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocation } from 'wouter';
import {
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  CandlestickChart,
  Home,
  Layers3,
  Newspaper,
  Power,
  Search,
  Settings,
  Star,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import {
  APP_NAVIGATION,
  cleanAppPath,
  navigationGroupMatches,
  navigationMenuItemMatches,
  resolveAppRoutePresentation,
  type NavigationGroupId,
  type NavigationIconId,
  type NavigationMenuItem,
} from '@/lib/app-navigation';

const ICONS: Record<NavigationIconId, LucideIcon> = {
  home: Home,
  assets: TrendingUp,
  technical: Search,
  information: Newspaper,
  settings: Settings,
  search: Search,
  ranking: BarChart3,
  themes: Layers3,
  watchlist: Star,
  alerts: Bell,
  chart: CandlestickChart,
  power: Power,
  learn: BookOpen,
  market: BarChart3,
  chat: Bot,
  portfolio: BriefcaseBusiness,
};

export function BottomNav() {
  const [location, navigate] = useLocation();
  const auth = useAuth();
  const path = cleanAppPath(location);
  const presentation = resolveAppRoutePresentation(location);
  const [openMenu, setOpenMenu] = useState<NavigationGroupId | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Partial<Record<NavigationGroupId, HTMLButtonElement | null>>>({});
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleGroups = APP_NAVIGATION.filter((item) => !item.capability || auth.can(item.capability));

  useEffect(() => {
    setOpenMenu(null);
    menuItemRefs.current = [];
  }, [location]);

  useEffect(() => {
    if (!presentation?.title) return;
    document.title = `${presentation.title} · Stock AI`;
  }, [presentation?.title]);

  useEffect(() => {
    function closeAndRestoreFocus(groupId: NavigationGroupId | null = openMenu) {
      if (!groupId) return;
      const trigger = triggerRefs.current[groupId];
      setOpenMenu(null);
      menuItemRefs.current = [];
      window.requestAnimationFrame(() => trigger?.focus());
    }

    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeAndRestoreFocus();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  function moveTo(href: string) {
    setOpenMenu(null);
    menuItemRefs.current = [];
    navigate(href);
  }

  function focusMenuItem(index: number) {
    window.requestAnimationFrame(() => menuItemRefs.current[index]?.focus());
  }

  function openGroupMenu(groupId: NavigationGroupId, focusIndex = 0) {
    menuItemRefs.current = [];
    setOpenMenu(groupId);
    focusMenuItem(focusIndex);
  }

  function closeGroupMenu(groupId: NavigationGroupId) {
    const trigger = triggerRefs.current[groupId];
    setOpenMenu(null);
    menuItemRefs.current = [];
    window.requestAnimationFrame(() => trigger?.focus());
  }

  function handleTriggerKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    groupId: NavigationGroupId,
    itemCount: number,
  ) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openGroupMenu(groupId, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openGroupMenu(groupId, Math.max(0, itemCount - 1));
    }
  }

  function handleMenuKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
    itemCount: number,
    groupId: NavigationGroupId,
  ) {
    let targetIndex: number | null = null;
    if (event.key === 'ArrowDown') targetIndex = (index + 1) % itemCount;
    if (event.key === 'ArrowUp') targetIndex = (index - 1 + itemCount) % itemCount;
    if (event.key === 'Home') targetIndex = 0;
    if (event.key === 'End') targetIndex = itemCount - 1;
    if (event.key === 'Tab') {
      targetIndex = event.shiftKey
        ? (index - 1 + itemCount) % itemCount
        : (index + 1) % itemCount;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGroupMenu(groupId);
      return;
    }
    if (targetIndex != null) {
      event.preventDefault();
      menuItemRefs.current[targetIndex]?.focus();
    }
  }

  return (
    <nav
      aria-label="주요 메뉴"
      data-route-title={presentation?.title ?? undefined}
      data-breadcrumb={presentation?.breadcrumb.join(' / ') ?? undefined}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-card-border bg-background/90 px-1 pb-[env(safe-area-inset-bottom)] pt-1 backdrop-blur-xl"
    >
      {presentation?.breadcrumb.length ? (
        <ol aria-label="현재 위치" className="sr-only">
          {presentation.breadcrumb.map((item, index) => (
            <li key={`${item}-${index}`} aria-current={index === presentation.breadcrumb.length - 1 ? 'page' : undefined}>
              {item}
            </li>
          ))}
        </ol>
      ) : null}
      <div
        className="mx-auto grid max-w-md gap-0.5"
        style={{ gridTemplateColumns: `repeat(${Math.max(visibleGroups.length, 1)}, minmax(0, 1fr))` }}
      >
        {visibleGroups.map((group) => {
          const active = navigationGroupMatches(group, path);
          const Icon = ICONS[group.icon];
          const visibleMenuItems = (group.menu ?? []).filter(
            (item) => !item.capability || auth.can(item.capability),
          );
          const hasMenu = visibleMenuItems.length > 0;

          if (hasMenu) {
            const menuOpen = openMenu === group.id;
            const menuId = `bottom-nav-${group.id}-menu`;
            return (
              <div key={group.id} ref={menuOpen ? menuRef : undefined} className="relative min-w-0">
                {menuOpen && (
                  <div
                    id={menuId}
                    role="menu"
                    aria-label={`${group.label} 메뉴`}
                    aria-orientation="vertical"
                    className="absolute bottom-full left-1/2 z-50 mb-3 max-h-[min(70dvh,32rem)] w-52 -translate-x-1/2 overflow-y-auto rounded-2xl border border-card-border bg-card p-2 shadow-2xl"
                  >
                    {visibleMenuItems.map((menuItem: NavigationMenuItem, index) => {
                      const MenuIcon = ICONS[menuItem.icon];
                      const menuActive = navigationMenuItemMatches(menuItem, path);
                      return (
                        <button
                          key={menuItem.id}
                          ref={(node) => { menuItemRefs.current[index] = node; }}
                          type="button"
                          role="menuitem"
                          aria-current={menuActive ? 'page' : undefined}
                          onClick={() => moveTo(menuItem.href)}
                          onKeyDown={(event) => handleMenuKeyDown(
                            event,
                            index,
                            visibleMenuItems.length,
                            group.id,
                          )}
                          className={cn(
                            'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-extrabold transition',
                            menuActive
                              ? 'bg-primary/10 text-primary'
                              : 'text-foreground hover:bg-muted active:bg-muted',
                          )}
                        >
                          <MenuIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>{menuItem.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  ref={(node) => { triggerRefs.current[group.id] = node; }}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-controls={menuId}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    if (menuOpen) {
                      closeGroupMenu(group.id);
                    } else {
                      openGroupMenu(group.id, 0);
                    }
                  }}
                  onKeyDown={(event) => handleTriggerKeyDown(event, group.id, visibleMenuItems.length)}
                  className={cn(
                    'flex min-h-11 w-full min-w-0 flex-col items-center justify-center rounded-2xl px-1 py-1 text-[10px] font-extrabold transition',
                    active || menuOpen ? 'text-primary' : 'text-muted-foreground active:text-foreground',
                  )}
                >
                  <Icon className={cn('mb-0.5 h-5 w-5', active || menuOpen ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                  <span className="truncate">{group.label}</span>
                </button>
              </div>
            );
          }

          return (
            <button
              key={group.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => moveTo(group.href)}
              className={cn(
                'flex min-h-11 min-w-0 flex-col items-center justify-center rounded-2xl px-1 py-1 text-[10px] font-extrabold transition',
                active ? 'text-primary' : 'text-muted-foreground active:text-foreground',
              )}
            >
              <Icon className={cn('mb-0.5 h-5 w-5', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
              <span className="truncate">{group.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

import { useEffect, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import {
  SIDEBAR_NAVIGATION,
  navigationMenuItemIsUserVisible,
  resolveAppRoutePresentation,
  sidebarItemMatches,
} from '@/lib/app-navigation';
import { NAVIGATION_ICONS } from '@/components/bottom-nav';

const DESKTOP_SHELL_QUERY = '(min-width: 1200px)';

function subscribeDesktop(callback: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const media = window.matchMedia(DESKTOP_SHELL_QUERY);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}

function desktopSnapshot() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(DESKTOP_SHELL_QUERY).matches);
}

/** True at the canonical desktop breakpoint (>=1200px) where the sidebar replaces the tab bar. */
export function useDesktopShell(): boolean {
  return useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
}

function menuItems(menu: Element | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
}

/** Section headings move focus into their always-visible menu (no collapse). */
function focusMenuItem(menuId: string, index: number) {
  const items = menuItems(document.getElementById(menuId));
  items[Math.max(0, Math.min(index, items.length - 1))]?.focus();
}

function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const items = menuItems(event.currentTarget);
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (current < 0 || items.length === 0) return;
  let next: number | null = null;
  if (event.key === 'ArrowDown') next = (current + 1) % items.length;
  if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = items.length - 1;
  if (next == null) return;
  event.preventDefault();
  items[next]?.focus();
}

/**
 * Desktop left navigation (216px). It owns the "주요 메뉴" landmark on desktop;
 * the mobile tab bar rendered by pages is hidden at the same breakpoint.
 */
export function AppSidebar() {
  const [location] = useLocation();
  const auth = useAuth();
  const presentation = resolveAppRoutePresentation(location);

  useEffect(() => {
    if (!presentation?.title) return;
    document.title = `${presentation.title} · Stock AI`;
  }, [presentation?.title]);

  const sections = SIDEBAR_NAVIGATION
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => (!item.capability || auth.can(item.capability)) && navigationMenuItemIsUserVisible(item),
      ),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <nav
      aria-label="주요 메뉴"
      data-testid="desktop-sidebar"
      data-route-title={presentation?.title ?? undefined}
      data-breadcrumb={presentation?.breadcrumb.join(' / ') ?? undefined}
      className="no-scrollbar flex h-full w-[216px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar px-3 pb-5 pt-4"
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
      <Link
        href="/"
        aria-label="STOCK AI 홈"
        className="mb-3 flex min-h-10 items-center gap-2.5 rounded-lg px-2 text-[15px] font-bold tracking-[0.02em] text-foreground"
      >
        <span aria-hidden="true" className="block h-7 w-7 rounded-lg bg-brand" />
        STOCK AI
      </Link>
      {sections.map((section) => {
        const menuId = `sidebar-${section.id}-menu`;
        const menuLabel = `${section.label ?? '홈'} 메뉴`;
        return (
          <div key={section.id} className="flex flex-col gap-0.5">
            {section.label ? (
              <button
                type="button"
                id={`sidebar-${section.id}-trigger`}
                aria-controls={menuId}
                aria-expanded="true"
                onClick={() => focusMenuItem(menuId, 0)}
                className="px-2.5 pb-1 pt-3 text-left text-[11px] font-semibold text-muted-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                {section.label}
              </button>
            ) : null}
            <div
              id={menuId}
              role="menu"
              aria-label={menuLabel}
              aria-orientation="vertical"
              onKeyDown={handleMenuKeyDown}
              className="flex flex-col gap-0.5"
            >
              {section.items.map((item) => {
                const active = sidebarItemMatches(item, location);
                const Icon = NAVIGATION_ICONS[item.icon];
                return (
                  <Link
                    key={`${section.id}-${item.id}`}
                    href={item.href}
                    role="menuitem"
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-sidebar-active font-semibold text-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground',
                    )}
                  >
                    <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

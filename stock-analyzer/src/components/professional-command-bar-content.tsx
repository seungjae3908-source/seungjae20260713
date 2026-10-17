import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useIsFetching, useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Bell,
  BriefcaseBusiness,
  Command,
  Home,
  LogOut,
  Maximize2,
  Minimize2,
  Radar,
  Search,
  Settings,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { useAuth } from '@/lib/auth';
import { APP_ROUTES, resolveAppRoutePresentation } from '@/lib/app-navigation';
import type { SummaryItem } from '@/lib/api';
import { getMarketSummary, validMarketSummaryItems } from '@/lib/market-summary';
import '@/professional-focus-mode.css';

interface CommandAction {
  id: string;
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  visible: boolean;
}

type ProfessionalCommandBarContentProps = {
  initialOpen?: boolean;
};

const FOCUS_ROUTES = [
  APP_ROUTES.aiChart,
  APP_ROUTES.scanner,
  APP_ROUTES.portfolio,
  APP_ROUTES.researchCenter,
] as const;

function editableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

function formatClock() {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

function formatTapeValue(item: SummaryItem) {
  const digits = item.unit === 'krw' && item.price >= 1000 ? 0 : 2;
  return item.price.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Index ticker tape. It only reads market-summary data already cached by the
 * home and market-overview screens, so the shell never adds its own request.
 */
function IndexTickerTape() {
  const home = useQuery({ queryKey: ['home-dashboard-market'], queryFn: getMarketSummary, enabled: false });
  const overview = useQuery({ queryKey: ['market-overview-summary'], queryFn: getMarketSummary, enabled: false });
  const items = validMarketSummaryItems(home.data?.items ?? overview.data?.items ?? []).slice(0, 7);
  return (
    <div data-testid="index-ticker-tape" aria-label="주요 지수" className="no-scrollbar flex min-w-0 flex-1 items-center gap-5 overflow-hidden whitespace-nowrap text-[12.5px]">
      {items.length ? items.map((item) => {
        const change = Number(item.changePercent);
        const tone = change > 0 ? 'text-rise' : change < 0 ? 'text-fall' : 'text-muted-foreground';
        return (
          <span key={item.key} className="inline-flex items-baseline gap-1.5">
            <b className="font-medium text-sidebar-foreground">{item.label}</b>
            <span className={`num ${tone}`}>
              {formatTapeValue(item)} {Number.isFinite(change) ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%` : ''}
            </span>
          </span>
        );
      }) : <span className="text-muted-foreground">지수 정보는 홈 화면을 열면 표시됩니다</span>}
    </div>
  );
}

function supportsFocusMode(location: string) {
  const path = location.split(/[?#]/, 1)[0] || '/';
  return FOCUS_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

export function ProfessionalCommandBarContent({ initialOpen = false }: ProfessionalCommandBarContentProps) {
  const [location, navigate] = useLocation();
  const auth = useAuth();
  const activeRequests = useIsFetching();
  const [open, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [clock, setClock] = useState(formatClock);
  const inputRef = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const presentation = resolveAppRoutePresentation(location);
  const focusEligible = supportsFocusMode(location);
  const currentPath = location.split(/[?#]/, 1)[0] || '/';
  const showGlobalLogout = currentPath !== APP_ROUTES.account;

  const actions: CommandAction[] = [
    { id: 'home', label: '홈', description: '투자 대시보드', href: APP_ROUTES.homeAlias, icon: Home, visible: true },
    { id: 'search', label: '통합검색', description: '종목·코인 찾기', href: APP_ROUTES.assets, icon: Search, visible: auth.can('canAccessBasicInfo') },
    { id: 'scanner', label: 'AI 신호검색기', description: '시장 신호 탐색', href: APP_ROUTES.scanner, icon: Radar, visible: auth.can('canAccessBasicInfo') },
    { id: 'ai-chart', label: 'AI 차트', description: '차트·분석 워크스페이스', href: APP_ROUTES.aiChart, icon: BarChart3, visible: auth.can('canAccessRiskPreview') },
    { id: 'portfolio', label: '포트폴리오', description: '자산·손익·위험 확인', href: APP_ROUTES.portfolio, icon: BriefcaseBusiness, visible: auth.can('canAccessPaperTrading') },
    { id: 'alerts', label: '가격 알림', description: '알림 상태 확인', href: APP_ROUTES.alerts, icon: Bell, visible: true },
    { id: 'research', label: '연구센터', description: '검증 근거와 연구 상태', href: APP_ROUTES.researchCenter, icon: Sparkles, visible: auth.can('canAccessBasicInfo') },
    { id: 'settings', label: '앱 설정', description: '화면·계정 설정', href: APP_ROUTES.settings, icon: Settings, visible: true },
  ];
  const visibleActions = actions.filter((item) => item.visible);
  const needle = query.trim().toLocaleLowerCase('ko-KR');
  const filteredActions = needle
    ? visibleActions.filter((item) => `${item.label} ${item.description}`.toLocaleLowerCase('ko-KR').includes(needle))
    : visibleActions;

  useEffect(() => {
    if (activeRequests > 0) return;
    setClock(formatClock());
  }, [activeRequests]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    function handleGlobalShortcut(event: globalThis.KeyboardEvent) {
      if (editableTarget(event.target)) return;
      if (!window.matchMedia('(min-width: 1200px)').matches) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!focusMode) setOpen(true);
        return;
      }
      if (
        event.key.toLowerCase() === 'f'
        && focusEligible
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
      ) {
        event.preventDefault();
        setOpen(false);
        setFocusMode((current) => !current);
        return;
      }
      if (event.key === 'Escape') {
        if (open) {
          setOpen(false);
          return;
        }
        if (focusMode && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
          setFocusMode(false);
        }
      }
    }
    window.addEventListener('keydown', handleGlobalShortcut);
    return () => window.removeEventListener('keydown', handleGlobalShortcut);
  }, [focusEligible, focusMode, open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
      return;
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1200px)');
    const enforceDesktopBoundary = () => {
      if (!media.matches) {
        setOpen(false);
        setFocusMode(false);
      }
    };
    media.addEventListener('change', enforceDesktopBoundary);
    return () => media.removeEventListener('change', enforceDesktopBoundary);
  }, []);

  useEffect(() => {
    if (!focusEligible && focusMode) setFocusMode(false);
  }, [focusEligible, focusMode]);

  useEffect(() => {
    const anchor = document.querySelector<HTMLElement>(
      focusMode ? '[data-testid="professional-focus-exit"]' : '[data-testid="professional-command-bar"]',
    );
    const shell = anchor?.parentElement ?? null;
    if (shellRef.current && shellRef.current !== shell) {
      delete shellRef.current.dataset.professionalFocusShell;
    }
    shellRef.current = shell;
    if (shell) {
      if (focusMode) shell.dataset.professionalFocusShell = 'true';
      else delete shell.dataset.professionalFocusShell;
    }
    if (focusMode) document.documentElement.dataset.professionalFocus = 'true';
    else delete document.documentElement.dataset.professionalFocus;

    return () => {
      if (!focusMode) return;
      delete document.documentElement.dataset.professionalFocus;
      if (shellRef.current) delete shellRef.current.dataset.professionalFocusShell;
    };
  }, [focusMode]);

  useEffect(() => {
    if (activeIndex >= filteredActions.length) setActiveIndex(Math.max(0, filteredActions.length - 1));
  }, [activeIndex, filteredActions.length]);

  function move(href: string) {
    setOpen(false);
    setFocusMode(false);
    navigate(href);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => filteredActions.length ? (current + 1) % filteredActions.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => filteredActions.length ? (current - 1 + filteredActions.length) % filteredActions.length : 0);
    } else if (event.key === 'Enter' && filteredActions[activeIndex]) {
      event.preventDefault();
      move(filteredActions[activeIndex].href);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }

  if (!auth.isApproved || location.startsWith('/__')) return null;

  if (focusMode && focusEligible) {
    return (
      <button
        type="button"
        data-testid="professional-focus-exit"
        aria-label="집중 모드 종료"
        onClick={() => setFocusMode(false)}
        className="fixed right-4 top-4 z-[110] hidden min-[1200px]:inline-flex min-h-10 items-center gap-2 rounded-xl border border-card-border bg-background/95 px-3 text-xs font-semibold shadow-xl backdrop-blur transition hover:border-primary/40 hover:text-primary"
      >
        <Minimize2 className="h-4 w-4" aria-hidden="true" />
        <span>집중 모드 종료</span>
        <kbd className="rounded-md border border-card-border bg-card px-1.5 py-0.5 text-xs">F</kbd>
      </button>
    );
  }

  return (
    <>
      <div
        data-testid="professional-command-bar"
        className="hidden min-[1200px]:flex h-14 shrink-0 items-center gap-4 border-b border-border bg-sidebar px-5"
        aria-label="상단 바"
      >
        <div className="hidden min-w-0 max-w-[10rem] shrink-0 2xl:block">
          <p className="truncate text-[11px] font-medium text-muted-foreground">{presentation?.breadcrumb.slice(0, -1).join(' / ') || 'STOCK AI'}</p>
          <p className="truncate text-sm font-semibold">{presentation?.title ?? '홈'}</p>
        </div>
        <span className="sr-only 2xl:hidden">{presentation?.title ?? '홈'}</span>

        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex h-9 w-[min(26vw,20rem)] min-w-52 shrink-0 items-center gap-2 rounded-lg border border-input bg-background px-3 text-left text-[13px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">종목·화면 검색</span>
          <kbd className="num shrink-0 rounded border border-input px-1.5 py-0.5 text-[11px] font-medium">Ctrl K</kbd>
        </button>

        <IndexTickerTape />

        <div className="flex shrink-0 items-center gap-2 text-xs">
          {focusEligible ? (
            <button
              type="button"
              data-testid="professional-focus-enter"
              aria-label="집중 모드 시작"
              title="집중 모드 시작 (F)"
              onClick={() => { setOpen(false); setFocusMode(true); }}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-input text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
          <span className="inline-flex min-h-8 items-center gap-1.5 px-1 font-medium text-sidebar-foreground" data-testid="professional-network-status">
            <span className={`h-2 w-2 rounded-full ${online ? (activeRequests > 0 ? 'bg-warning' : 'bg-positive') : 'bg-destructive'}`} aria-hidden="true" />
            {online ? '온라인' : '오프라인'}
          </span>
          <span className="inline-flex min-h-8 items-center px-1 font-medium text-muted-foreground" data-testid="professional-query-status">
            {activeRequests > 0 ? `불러오는 중 · ${activeRequests}건` : `진행 중인 요청 없음 · ${clock} 기준`}
          </span>
          <button type="button" aria-label="계정 열기" onClick={() => navigate(APP_ROUTES.account)} className="min-h-8 max-w-36 truncate rounded-lg border border-input px-3 font-semibold text-foreground hover:bg-sidebar-hover">
            {auth.displayName ?? '계정'}
          </button>
          {showGlobalLogout ? (
            <button
              type="button"
              aria-label="로그아웃"
              title="로그아웃"
              onClick={() => void auth.signOut()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground transition hover:border-destructive/40 hover:text-destructive"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="fixed inset-0 z-[100] hidden min-[1200px]:flex items-start justify-center bg-black/55 px-6 pt-[12vh]" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-label="빠른 실행" className="w-full max-w-2xl overflow-hidden rounded-2xl border border-card-border bg-card shadow-2xl" data-testid="professional-command-palette">
            <div className="flex items-center gap-3 border-b border-card-border px-4">
              <Command className="h-5 w-5 shrink-0 text-primary" />
              <label className="sr-only" htmlFor="professional-command-search">빠른 실행 검색</label>
              <input
                ref={inputRef}
                id="professional-command-search"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
                onKeyDown={handleInputKeyDown}
                placeholder="화면이나 기능 이름을 입력하세요"
                className="h-14 min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
              />
              <button type="button" aria-label="빠른 실행 닫기" onClick={() => setOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>

            <div role="listbox" aria-label="빠른 실행 결과" className="max-h-[min(62vh,30rem)] overflow-y-auto p-2">
              {filteredActions.length ? filteredActions.map((action, index) => {
                const Icon = action.icon;
                const active = index === activeIndex;
                return (
                  <button
                    key={action.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => move(action.href)}
                    className={`flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left transition ${active ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'}`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background text-primary"><Icon className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-semibold">{action.label}</strong><span className="mt-0.5 block truncate text-xs font-medium text-muted-foreground">{action.description}</span></span>
                  </button>
                );
              }) : (
                <p className="p-6 text-center text-sm text-muted-foreground">일치하는 기능이 없습니다.</p>
              )}
            </div>
            <footer className="flex items-center justify-between border-t border-card-border px-4 py-2 text-xs text-muted-foreground">
              <span>↑↓ 이동 · Enter 열기 · Esc 닫기</span>
              <span>읽기·분석 화면 빠른 이동</span>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

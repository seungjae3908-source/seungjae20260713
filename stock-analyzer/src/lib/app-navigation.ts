import type { MemberCapability } from '../../../packages/member-access/src/index.js';

export const APP_ROUTES = {
  home: '/',
  homeAlias: '/home',
  assets: '/stocks',
  legacyMarketRankings: '/search',
  unifiedSearchAlias: '/search',
  unifiedMarketRankings: '/market-rankings',
  unifiedMarketBrowser: '/market-browser',
  themes: '/themes',
  watchlist: '/watchlist',
  alerts: '/alerts',
  stockDetailPrefix: '/stock/',
  stockInfo: '/stock-info',
  scanner: '/scanner',
  aiChart: '/ai-chart',
  autoTrading: '/auto-trading',
  learn: '/learn',
  marketOverview: '/market-overview',
  aiChat: '/ai-chat',
  portfolio: '/portfolio',
  assetsPortfolio: '/assets',
  settings: '/more',
  settingsAlias: '/settings',
  account: '/account',
  login: '/login',
} as const;

export const UNIFIED_SEARCH_ROUTE_CONTRACT = {
  primaryEntry: APP_ROUTES.assets,
  searchAlias: APP_ROUTES.unifiedSearchAlias,
  marketRankingsAfterIntegration: APP_ROUTES.unifiedMarketRankings,
  marketBrowserAfterIntegration: APP_ROUTES.unifiedMarketBrowser,
} as const;

export type NavigationGroupId = 'home' | 'assets' | 'technical' | 'information' | 'settings';
export type NavigationIconId =
  | 'home'
  | 'assets'
  | 'technical'
  | 'information'
  | 'settings'
  | 'search'
  | 'ranking'
  | 'themes'
  | 'watchlist'
  | 'alerts'
  | 'chart'
  | 'power'
  | 'learn'
  | 'market'
  | 'chat'
  | 'portfolio';

export interface NavigationMenuItem {
  id: string;
  href: string;
  label: string;
  icon: NavigationIconId;
  capability?: MemberCapability;
  /** Route owned by PR #58 after unified-search integration. */
  postUnifiedSearchHref?: string;
}

export interface NavigationGroup {
  id: NavigationGroupId;
  href: string;
  label: string;
  icon: NavigationIconId;
  capability?: MemberCapability;
  exactPaths?: readonly string[];
  pathPrefixes?: readonly string[];
  menu?: readonly NavigationMenuItem[];
}

export const APP_NAVIGATION: readonly NavigationGroup[] = [
  {
    id: 'home',
    href: APP_ROUTES.home,
    label: '홈',
    icon: 'home',
    exactPaths: [APP_ROUTES.home, APP_ROUTES.homeAlias],
  },
  {
    id: 'assets',
    href: APP_ROUTES.assets,
    label: '종목',
    icon: 'assets',
    exactPaths: [
      APP_ROUTES.assets,
      APP_ROUTES.legacyMarketRankings,
      APP_ROUTES.unifiedMarketRankings,
      APP_ROUTES.unifiedMarketBrowser,
      APP_ROUTES.themes,
      APP_ROUTES.watchlist,
      APP_ROUTES.alerts,
      APP_ROUTES.stockInfo,
    ],
    pathPrefixes: [APP_ROUTES.stockDetailPrefix],
    menu: [
      { id: 'asset-search', href: APP_ROUTES.assets, label: '종목 검색·탐색', icon: 'search' },
      {
        id: 'market-rankings',
        href: APP_ROUTES.legacyMarketRankings,
        label: '시장 순위',
        icon: 'ranking',
        postUnifiedSearchHref: APP_ROUTES.unifiedMarketRankings,
      },
      { id: 'themes', href: APP_ROUTES.themes, label: '테마', icon: 'themes' },
      { id: 'watchlist', href: APP_ROUTES.watchlist, label: '관심종목', icon: 'watchlist' },
      { id: 'alerts', href: APP_ROUTES.alerts, label: '알림', icon: 'alerts' },
    ],
  },
  {
    id: 'technical',
    href: APP_ROUTES.scanner,
    label: '기술',
    icon: 'technical',
    capability: 'canAccessRiskPreview',
    exactPaths: [APP_ROUTES.scanner, APP_ROUTES.aiChart, APP_ROUTES.autoTrading],
    menu: [
      { id: 'scanner', href: APP_ROUTES.scanner, label: 'AI 검색기', icon: 'search' },
      { id: 'ai-chart', href: APP_ROUTES.aiChart, label: 'AI 차트 분석기', icon: 'chart' },
      { id: 'auto-trading', href: APP_ROUTES.autoTrading, label: '승인형 주문', icon: 'power' },
    ],
  },
  {
    id: 'information',
    href: APP_ROUTES.marketOverview,
    label: '정보',
    icon: 'information',
    exactPaths: [
      APP_ROUTES.learn,
      APP_ROUTES.marketOverview,
      APP_ROUTES.aiChat,
      APP_ROUTES.portfolio,
      APP_ROUTES.assetsPortfolio,
    ],
    menu: [
      { id: 'market-overview', href: APP_ROUTES.marketOverview, label: '시황', icon: 'market' },
      { id: 'learn', href: APP_ROUTES.learn, label: '공부', icon: 'learn' },
      { id: 'ai-chat', href: APP_ROUTES.aiChat, label: 'AI 정보', icon: 'chat' },
      {
        id: 'portfolio',
        href: APP_ROUTES.portfolio,
        label: '포트폴리오',
        icon: 'portfolio',
        capability: 'canAccessPaperTrading',
      },
    ],
  },
  {
    id: 'settings',
    href: APP_ROUTES.settings,
    label: '설정',
    icon: 'settings',
    exactPaths: [APP_ROUTES.settings, APP_ROUTES.settingsAlias, APP_ROUTES.account, APP_ROUTES.login],
  },
] as const;

export function cleanAppPath(location: string): string {
  return location.split('?')[0] || APP_ROUTES.home;
}

export function navigationGroupMatches(group: NavigationGroup, location: string): boolean {
  const path = cleanAppPath(location);
  return Boolean(
    group.exactPaths?.includes(path) ||
    group.pathPrefixes?.some((prefix) => path.startsWith(prefix)),
  );
}

export function navigationMenuItemMatches(item: NavigationMenuItem, location: string): boolean {
  const path = cleanAppPath(location);
  return path === item.href || path === item.postUnifiedSearchHref;
}

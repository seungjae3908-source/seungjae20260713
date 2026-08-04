import type { MemberCapability } from '../../../packages/member-access/src/index.js';

export const APP_ROUTES = {
  home: '/',
  homeAlias: '/home',
  assets: '/stocks',
  legacyMarketRankings: '/search',
  unifiedSearchAlias: '/search',
  unifiedMarketRankings: '/market-rankings',
  unifiedMarketBrowser: '/market-browser',
  recommendations: '/recommendations',
  themes: '/themes',
  watchlist: '/watchlist',
  alerts: '/alerts',
  stockDetailPrefix: '/stock/',
  stockInfo: '/stock-info',
  scanner: '/scanner',
  aiChart: '/ai-chart',
  autoTrading: '/auto-trading',
  backtests: '/backtests',
  paperTrading: '/paper-trading',
  learn: '/learn',
  marketOverview: '/market-overview',
  aiChat: '/ai-chat',
  portfolio: '/portfolio',
  assetsPortfolio: '/assets',
  settings: '/more',
  settingsAlias: '/settings',
  account: '/account',
  login: '/login',
  admin: '/admin',
  install: '/install',
  cryptoHomeRedirect: '/crypto',
  cryptoSearchRedirect: '/crypto/search',
  cryptoDetailPrefix: '/crypto/',
  testRoutePrefix: '/__',
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

export interface AppRoutePresentation {
  id: string;
  title: string;
  breadcrumb: readonly string[];
  groupId?: NavigationGroupId;
  exactPaths?: readonly string[];
  pathPrefixes?: readonly string[];
  transient?: boolean;
  testOnly?: boolean;
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
      APP_ROUTES.recommendations,
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
    exactPaths: [
      APP_ROUTES.scanner,
      APP_ROUTES.aiChart,
      APP_ROUTES.autoTrading,
      APP_ROUTES.backtests,
      APP_ROUTES.paperTrading,
    ],
    menu: [
      {
        id: 'scanner',
        href: APP_ROUTES.scanner,
        label: 'AI 검색기',
        icon: 'search',
        capability: 'canAccessRiskPreview',
      },
      {
        id: 'ai-chart',
        href: APP_ROUTES.aiChart,
        label: 'AI 차트 분석기',
        icon: 'chart',
        capability: 'canAccessRiskPreview',
      },
      {
        id: 'auto-trading',
        href: APP_ROUTES.autoTrading,
        label: '승인형 주문',
        icon: 'power',
        capability: 'canAccessPaperTrading',
      },
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
    exactPaths: [
      APP_ROUTES.settings,
      APP_ROUTES.settingsAlias,
      APP_ROUTES.account,
      APP_ROUTES.login,
      APP_ROUTES.admin,
    ],
  },
] as const;

export const APP_ROUTE_PRESENTATIONS: readonly AppRoutePresentation[] = [
  { id: 'home', title: '홈', breadcrumb: ['홈'], groupId: 'home', exactPaths: [APP_ROUTES.home, APP_ROUTES.homeAlias] },
  { id: 'asset-search', title: '종목 검색·탐색', breadcrumb: ['종목', '종목 검색·탐색'], groupId: 'assets', exactPaths: [APP_ROUTES.assets] },
  { id: 'market-rankings', title: '시장 순위', breadcrumb: ['종목', '시장 순위'], groupId: 'assets', exactPaths: [APP_ROUTES.legacyMarketRankings, APP_ROUTES.unifiedMarketRankings] },
  { id: 'market-browser', title: '시장 탐색', breadcrumb: ['종목', '시장 탐색'], groupId: 'assets', exactPaths: [APP_ROUTES.unifiedMarketBrowser] },
  { id: 'recommendations', title: 'AI 추천', breadcrumb: ['종목', 'AI 추천'], groupId: 'assets', exactPaths: [APP_ROUTES.recommendations] },
  { id: 'themes', title: '테마', breadcrumb: ['종목', '테마'], groupId: 'assets', exactPaths: [APP_ROUTES.themes] },
  { id: 'watchlist', title: '관심종목', breadcrumb: ['종목', '관심종목'], groupId: 'assets', exactPaths: [APP_ROUTES.watchlist] },
  { id: 'alerts', title: '알림', breadcrumb: ['종목', '알림'], groupId: 'assets', exactPaths: [APP_ROUTES.alerts] },
  { id: 'stock-detail', title: '종목 상세', breadcrumb: ['종목', '종목 상세'], groupId: 'assets', pathPrefixes: [APP_ROUTES.stockDetailPrefix] },
  { id: 'stock-info', title: '종목 정보', breadcrumb: ['종목', '종목 정보'], groupId: 'assets', exactPaths: [APP_ROUTES.stockInfo] },
  { id: 'scanner', title: 'AI 검색기', breadcrumb: ['기술', 'AI 검색기'], groupId: 'technical', exactPaths: [APP_ROUTES.scanner] },
  { id: 'ai-chart', title: 'AI 차트 분석기', breadcrumb: ['기술', 'AI 차트 분석기'], groupId: 'technical', exactPaths: [APP_ROUTES.aiChart] },
  { id: 'auto-trading', title: '승인형 주문', breadcrumb: ['기술', '승인형 주문'], groupId: 'technical', exactPaths: [APP_ROUTES.autoTrading] },
  { id: 'backtests', title: '코인 선물 백테스트 연구', breadcrumb: ['기술', '백테스트'], groupId: 'technical', exactPaths: [APP_ROUTES.backtests] },
  { id: 'paper-trading', title: '모의매매', breadcrumb: ['기술', '모의매매'], groupId: 'technical', exactPaths: [APP_ROUTES.paperTrading] },
  { id: 'market-overview', title: '시황', breadcrumb: ['정보', '시황'], groupId: 'information', exactPaths: [APP_ROUTES.marketOverview] },
  { id: 'learn', title: '공부', breadcrumb: ['정보', '공부'], groupId: 'information', exactPaths: [APP_ROUTES.learn] },
  { id: 'ai-chat', title: 'AI 정보', breadcrumb: ['정보', 'AI 정보'], groupId: 'information', exactPaths: [APP_ROUTES.aiChat] },
  { id: 'portfolio', title: '포트폴리오', breadcrumb: ['정보', '포트폴리오'], groupId: 'information', exactPaths: [APP_ROUTES.portfolio, APP_ROUTES.assetsPortfolio] },
  { id: 'settings', title: '설정', breadcrumb: ['설정'], groupId: 'settings', exactPaths: [APP_ROUTES.settings, APP_ROUTES.settingsAlias] },
  { id: 'account', title: '계정', breadcrumb: ['설정', '계정'], groupId: 'settings', exactPaths: [APP_ROUTES.account, APP_ROUTES.login] },
  { id: 'admin', title: '회원 관리', breadcrumb: ['설정', '회원 관리'], groupId: 'settings', exactPaths: [APP_ROUTES.admin] },
  { id: 'install', title: '앱 설치', breadcrumb: ['앱 설치'], exactPaths: [APP_ROUTES.install] },
  { id: 'crypto-home-redirect', title: '암호화폐 홈 이동', breadcrumb: ['홈'], exactPaths: [APP_ROUTES.cryptoHomeRedirect], transient: true },
  { id: 'crypto-search-redirect', title: '암호화폐 검색 이동', breadcrumb: ['종목', '종목 검색·탐색'], exactPaths: [APP_ROUTES.cryptoSearchRedirect], transient: true },
  { id: 'crypto-detail-redirect', title: '암호화폐 상세 이동', breadcrumb: ['종목', '종목 정보'], pathPrefixes: [APP_ROUTES.cryptoDetailPrefix], transient: true },
  { id: 'test-only', title: '테스트 전용', breadcrumb: ['테스트 전용'], pathPrefixes: [APP_ROUTES.testRoutePrefix], testOnly: true },
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

export function resolveAppRoutePresentation(location: string): AppRoutePresentation | null {
  const path = cleanAppPath(location);
  return APP_ROUTE_PRESENTATIONS.find((item) => Boolean(
    item.exactPaths?.includes(path) ||
    item.pathPrefixes?.some((prefix) => path.startsWith(prefix)),
  )) ?? null;
}

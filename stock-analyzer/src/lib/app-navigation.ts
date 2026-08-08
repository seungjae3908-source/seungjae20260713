import type { MemberCapability } from '../../../packages/member-access/src/index.js';
import { MARKET_INFORMATION_ROUTES, type MarketInformationId } from './market-information';

function requiredMarketRoom(id: MarketInformationId) {
  const route = MARKET_INFORMATION_ROUTES.find((item) => item.id === id);
  if (!route) throw new Error(`시장정보 route가 없습니다: ${id}`);
  return route;
}

const MARKET_ROOMS = {
  kr: requiredMarketRoom('stocks-kr'),
  us: requiredMarketRoom('stocks-us'),
  spot: requiredMarketRoom('coins-spot'),
  futures: requiredMarketRoom('coins-futures'),
} as const;

export const APP_ROUTES = {
  home: '/',
  homeAlias: '/home',
  assets: '/stocks',
  unifiedSearchAlias: '/search',
  marketRankings: '/market-rankings',
  marketBrowser: '/market-browser',
  stocksKr: MARKET_ROOMS.kr.href,
  stocksUs: MARKET_ROOMS.us.href,
  coinsSpot: MARKET_ROOMS.spot.href,
  coinsFutures: MARKET_ROOMS.futures.href,
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
  marketRankings: APP_ROUTES.marketRankings,
  marketBrowser: APP_ROUTES.marketBrowser,
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

const MARKET_ROOM_MENU: readonly NavigationMenuItem[] = [
  {
    id: 'stocks-kr',
    href: MARKET_ROOMS.kr.href,
    label: '국내주식',
    icon: 'market',
    capability: MARKET_ROOMS.kr.capability,
  },
  {
    id: 'stocks-us',
    href: MARKET_ROOMS.us.href,
    label: '미국주식',
    icon: 'market',
    capability: MARKET_ROOMS.us.capability,
  },
  {
    id: 'coins-spot',
    href: MARKET_ROOMS.spot.href,
    label: '코인 현물',
    icon: 'market',
    capability: MARKET_ROOMS.spot.capability,
  },
  {
    id: 'coins-futures',
    href: MARKET_ROOMS.futures.href,
    label: '코인 선물',
    icon: 'market',
    capability: MARKET_ROOMS.futures.capability,
  },
] as const;

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
      APP_ROUTES.unifiedSearchAlias,
      APP_ROUTES.marketRankings,
      APP_ROUTES.marketBrowser,
      APP_ROUTES.stocksKr,
      APP_ROUTES.stocksUs,
      APP_ROUTES.coinsSpot,
      APP_ROUTES.coinsFutures,
      APP_ROUTES.marketOverview,
      APP_ROUTES.recommendations,
      APP_ROUTES.themes,
      APP_ROUTES.watchlist,
      APP_ROUTES.alerts,
      APP_ROUTES.stockInfo,
    ],
    pathPrefixes: [APP_ROUTES.stockDetailPrefix],
    menu: [
      { id: 'asset-search', href: APP_ROUTES.assets, label: '통합검색', icon: 'search', capability: 'canAccessBasicInfo' },
      ...MARKET_ROOM_MENU,
      { id: 'market-overview', href: APP_ROUTES.marketOverview, label: '지수·시황', icon: 'market' },
      { id: 'market-rankings', href: APP_ROUTES.marketRankings, label: '시장 순위', icon: 'ranking' },
      { id: 'market-browser', href: APP_ROUTES.marketBrowser, label: '시장 탐색', icon: 'ranking' },
      { id: 'themes', href: APP_ROUTES.themes, label: '테마', icon: 'themes' },
      { id: 'watchlist', href: APP_ROUTES.watchlist, label: '관심종목', icon: 'watchlist' },
      { id: 'alerts', href: APP_ROUTES.alerts, label: '가격 알림', icon: 'alerts' },
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
        label: 'AI 신호검색기',
        icon: 'search',
        capability: 'canAccessRiskPreview',
      },
      {
        id: 'ai-chart',
        href: APP_ROUTES.aiChart,
        label: 'AI 차트',
        icon: 'chart',
        capability: 'canAccessRiskPreview',
      },
      {
        id: 'auto-trading',
        href: APP_ROUTES.autoTrading,
        label: '승인형 주문',
        icon: 'power',
        capability: 'canAccessRiskPreview',
      },
      {
        id: 'backtests',
        href: APP_ROUTES.backtests,
        label: '백테스트',
        icon: 'chart',
        capability: 'canAccessBacktests',
      },
      {
        id: 'paper-trading',
        href: APP_ROUTES.paperTrading,
        label: '모의매매',
        icon: 'power',
        capability: 'canAccessPaperTrading',
      },
    ],
  },
  {
    id: 'information',
    href: APP_ROUTES.learn,
    label: '정보',
    icon: 'information',
    exactPaths: [
      APP_ROUTES.learn,
      APP_ROUTES.aiChat,
      APP_ROUTES.portfolio,
      APP_ROUTES.assetsPortfolio,
    ],
    menu: [
      { id: 'learn', href: APP_ROUTES.learn, label: '투자 공부', icon: 'learn' },
      { id: 'ai-chat', href: APP_ROUTES.aiChat, label: 'AI 정보', icon: 'chat', capability: 'canAccessBasicInfo' },
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
    menu: [
      { id: 'settings', href: APP_ROUTES.settings, label: '앱 설정', icon: 'settings' },
      { id: 'account', href: APP_ROUTES.account, label: '계정', icon: 'settings' },
      { id: 'admin', href: APP_ROUTES.admin, label: '회원 관리', icon: 'settings', capability: 'canManageMembers' },
    ],
  },
] as const;

export const APP_ROUTE_PRESENTATIONS: readonly AppRoutePresentation[] = [
  { id: 'home', title: '홈', breadcrumb: ['홈'], groupId: 'home', exactPaths: [APP_ROUTES.home, APP_ROUTES.homeAlias] },
  { id: 'asset-search', title: '통합검색', breadcrumb: ['종목', '통합검색'], groupId: 'assets', exactPaths: [APP_ROUTES.assets, APP_ROUTES.unifiedSearchAlias] },
  { id: 'stocks-kr', title: MARKET_ROOMS.kr.label, breadcrumb: ['종목', MARKET_ROOMS.kr.label], groupId: 'assets', exactPaths: [APP_ROUTES.stocksKr] },
  { id: 'stocks-us', title: MARKET_ROOMS.us.label, breadcrumb: ['종목', MARKET_ROOMS.us.label], groupId: 'assets', exactPaths: [APP_ROUTES.stocksUs] },
  { id: 'coins-spot', title: MARKET_ROOMS.spot.label, breadcrumb: ['종목', MARKET_ROOMS.spot.label], groupId: 'assets', exactPaths: [APP_ROUTES.coinsSpot] },
  { id: 'coins-futures', title: MARKET_ROOMS.futures.label, breadcrumb: ['종목', MARKET_ROOMS.futures.label], groupId: 'assets', exactPaths: [APP_ROUTES.coinsFutures] },
  { id: 'market-overview', title: '지수·시황', breadcrumb: ['종목', '지수·시황'], groupId: 'assets', exactPaths: [APP_ROUTES.marketOverview] },
  { id: 'market-rankings', title: '시장 순위', breadcrumb: ['종목', '시장 순위'], groupId: 'assets', exactPaths: [APP_ROUTES.marketRankings] },
  { id: 'market-browser', title: '시장 탐색', breadcrumb: ['종목', '시장 탐색'], groupId: 'assets', exactPaths: [APP_ROUTES.marketBrowser] },
  { id: 'recommendations', title: 'AI 추천', breadcrumb: ['종목', 'AI 추천'], groupId: 'assets', exactPaths: [APP_ROUTES.recommendations] },
  { id: 'themes', title: '테마', breadcrumb: ['종목', '테마'], groupId: 'assets', exactPaths: [APP_ROUTES.themes] },
  { id: 'watchlist', title: '관심종목', breadcrumb: ['종목', '관심종목'], groupId: 'assets', exactPaths: [APP_ROUTES.watchlist] },
  { id: 'alerts', title: '가격 알림', breadcrumb: ['종목', '가격 알림'], groupId: 'assets', exactPaths: [APP_ROUTES.alerts] },
  { id: 'stock-detail', title: '종목 상세', breadcrumb: ['종목', '종목 상세'], groupId: 'assets', pathPrefixes: [APP_ROUTES.stockDetailPrefix] },
  { id: 'stock-info', title: '종목 정보', breadcrumb: ['종목', '종목 정보'], groupId: 'assets', exactPaths: [APP_ROUTES.stockInfo] },
  { id: 'scanner', title: 'AI 신호검색기', breadcrumb: ['기술', 'AI 신호검색기'], groupId: 'technical', exactPaths: [APP_ROUTES.scanner] },
  { id: 'ai-chart', title: 'AI 차트', breadcrumb: ['기술', 'AI 차트'], groupId: 'technical', exactPaths: [APP_ROUTES.aiChart] },
  { id: 'auto-trading', title: '승인형 주문', breadcrumb: ['기술', '승인형 주문'], groupId: 'technical', exactPaths: [APP_ROUTES.autoTrading] },
  { id: 'backtests', title: '백테스트', breadcrumb: ['기술', '백테스트'], groupId: 'technical', exactPaths: [APP_ROUTES.backtests] },
  { id: 'paper-trading', title: '모의매매', breadcrumb: ['기술', '모의매매'], groupId: 'technical', exactPaths: [APP_ROUTES.paperTrading] },
  { id: 'learn', title: '투자 공부', breadcrumb: ['정보', '투자 공부'], groupId: 'information', exactPaths: [APP_ROUTES.learn] },
  { id: 'ai-chat', title: 'AI 정보', breadcrumb: ['정보', 'AI 정보'], groupId: 'information', exactPaths: [APP_ROUTES.aiChat] },
  { id: 'portfolio', title: '포트폴리오', breadcrumb: ['정보', '포트폴리오'], groupId: 'information', exactPaths: [APP_ROUTES.portfolio, APP_ROUTES.assetsPortfolio] },
  { id: 'settings', title: '앱 설정', breadcrumb: ['설정', '앱 설정'], groupId: 'settings', exactPaths: [APP_ROUTES.settings, APP_ROUTES.settingsAlias] },
  { id: 'account', title: '계정', breadcrumb: ['설정', '계정'], groupId: 'settings', exactPaths: [APP_ROUTES.account, APP_ROUTES.login] },
  { id: 'admin', title: '회원 관리', breadcrumb: ['설정', '회원 관리'], groupId: 'settings', exactPaths: [APP_ROUTES.admin] },
  { id: 'install', title: '앱 설치', breadcrumb: ['앱 설치'], exactPaths: [APP_ROUTES.install] },
  { id: 'crypto-home-redirect', title: '암호화폐 홈 이동', breadcrumb: ['홈'], exactPaths: [APP_ROUTES.cryptoHomeRedirect], transient: true },
  { id: 'crypto-search-redirect', title: '암호화폐 검색 이동', breadcrumb: ['종목', '통합검색'], exactPaths: [APP_ROUTES.cryptoSearchRedirect], transient: true },
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
  return cleanAppPath(location) === item.href;
}

export function resolveAppRoutePresentation(location: string): AppRoutePresentation | null {
  const path = cleanAppPath(location);
  return APP_ROUTE_PRESENTATIONS.find((item) => Boolean(
    item.exactPaths?.includes(path) ||
    item.pathPrefixes?.some((prefix) => path.startsWith(prefix)),
  )) ?? null;
}

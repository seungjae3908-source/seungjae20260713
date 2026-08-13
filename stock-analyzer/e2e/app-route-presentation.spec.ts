import { test, expect } from '@playwright/test';
import {
  APP_NAVIGATION,
  APP_ROUTES,
  navigationGroupMatches,
  resolveAppRoutePresentation,
} from '../src/lib/app-navigation';

const group = (id: 'assets' | 'technical' | 'information' | 'settings') => {
  const found = APP_NAVIGATION.find((item) => item.id === id);
  if (!found) throw new Error(`navigation group not found: ${id}`);
  return found;
};

test('actual product routes keep the correct top-level navigation state', () => {
  for (const path of [
    APP_ROUTES.assets,
    APP_ROUTES.stocksKr,
    APP_ROUTES.stocksUs,
    APP_ROUTES.coinsSpot,
    APP_ROUTES.coinsFutures,
    APP_ROUTES.marketRankings,
    APP_ROUTES.marketBrowser,
    APP_ROUTES.recommendations,
  ]) {
    expect(navigationGroupMatches(group('assets'), path), path).toBe(true);
  }
  expect(navigationGroupMatches(group('technical'), APP_ROUTES.scanner)).toBe(true);
  expect(navigationGroupMatches(group('technical'), APP_ROUTES.aiChart)).toBe(true);
  expect(navigationGroupMatches(group('technical'), APP_ROUTES.autoTrading)).toBe(true);
  expect(navigationGroupMatches(group('technical'), APP_ROUTES.backtests)).toBe(true);
  expect(navigationGroupMatches(group('technical'), APP_ROUTES.paperTrading)).toBe(true);
  expect(navigationGroupMatches(group('information'), APP_ROUTES.learn)).toBe(true);
  expect(navigationGroupMatches(group('information'), APP_ROUTES.aiChat)).toBe(true);
  expect(navigationGroupMatches(group('information'), APP_ROUTES.portfolio)).toBe(true);
  expect(navigationGroupMatches(group('information'), APP_ROUTES.marketOverview)).toBe(true);
  expect(navigationGroupMatches(group('assets'), APP_ROUTES.marketOverview)).toBe(false);
  expect(navigationGroupMatches(group('settings'), APP_ROUTES.admin)).toBe(true);
});

test('route presentation metadata follows final Information Hub ownership', () => {
  const expectations = [
    [APP_ROUTES.stocksKr, '국내주식 정보', ['종목', '국내주식 정보']],
    [APP_ROUTES.stocksUs, '미국주식 정보', ['종목', '미국주식 정보']],
    [APP_ROUTES.coinsSpot, '코인 현물 정보', ['종목', '코인 현물 정보']],
    [APP_ROUTES.coinsFutures, '코인 선물 정보', ['종목', '코인 선물 정보']],
    [APP_ROUTES.scanner, 'AI 신호검색기', ['기술', 'AI 신호검색기']],
    [APP_ROUTES.aiChart, 'AI 차트', ['기술', 'AI 차트']],
    [APP_ROUTES.autoTrading, '승인형 주문', ['기술', '승인형 주문']],
    [APP_ROUTES.marketOverview, '시장 브리핑', ['정보', '시장 브리핑']],
    [APP_ROUTES.aiChat, 'AI 상담', ['정보', 'AI 상담']],
    [APP_ROUTES.portfolio, '포트폴리오', ['정보', '포트폴리오']],
  ] as const;

  for (const [path, title, breadcrumb] of expectations) {
    expect(resolveAppRoutePresentation(path), path).toMatchObject({ title, breadcrumb });
  }
});

test('aliases, transient routes, and test routes do not become duplicate product menu entries', () => {
  expect(resolveAppRoutePresentation('/search')).toMatchObject({ title: '통합검색', groupId: 'assets' });
  expect(resolveAppRoutePresentation('/crypto/search')).toMatchObject({ transient: true });
  expect(resolveAppRoutePresentation('/crypto/BTC')).toMatchObject({ transient: true });
  expect(resolveAppRoutePresentation('/__phase12-trade-automation-e2e')).toMatchObject({ testOnly: true });

  const menuHrefs = APP_NAVIGATION.flatMap((item) => item.menu?.map((child) => child.href) ?? []);
  expect(menuHrefs).not.toContain(APP_ROUTES.unifiedSearchAlias);
  expect(new Set(menuHrefs).size).toBe(menuHrefs.length);
  for (const navGroup of APP_NAVIGATION) {
    expect(navigationGroupMatches(navGroup, '/__phase12-trade-automation-e2e')).toBe(false);
  }
});

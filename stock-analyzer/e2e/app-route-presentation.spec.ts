import { readFileSync } from 'node:fs';
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
    APP_ROUTES.marketOverview,
    APP_ROUTES.marketRankings,
    APP_ROUTES.marketBrowser,
    APP_ROUTES.recommendations,
    APP_ROUTES.themes,
    APP_ROUTES.newsInformation,
  ]) {
    expect(navigationGroupMatches(group('assets'), path), path).toBe(true);
  }
  for (const path of [
    APP_ROUTES.scanner,
    APP_ROUTES.aiChart,
    APP_ROUTES.autoTrading,
    APP_ROUTES.backtests,
    APP_ROUTES.paperTrading,
    APP_ROUTES.strategyPromotion,
  ]) {
    expect(navigationGroupMatches(group('technical'), path), path).toBe(true);
  }
  for (const path of [
    APP_ROUTES.learn,
    APP_ROUTES.aiChat,
    APP_ROUTES.researchCenter,
    APP_ROUTES.portfolio,
    APP_ROUTES.position,
  ]) {
    expect(navigationGroupMatches(group('information'), path), path).toBe(true);
  }
  for (const path of [APP_ROUTES.admin, APP_ROUTES.adminUiLayouts]) {
    expect(navigationGroupMatches(group('settings'), path), path).toBe(true);
  }
});

test('route presentation metadata follows final-main market and deep-route ownership', () => {
  const expectations = [
    [APP_ROUTES.stocksKr, '국내주식 정보', ['종목', '국내주식 정보']],
    [APP_ROUTES.stocksUs, '미국주식 정보', ['종목', '미국주식 정보']],
    [APP_ROUTES.coinsSpot, '코인 현물 정보', ['종목', '코인 현물 정보']],
    [APP_ROUTES.coinsFutures, '코인 선물 정보', ['종목', '코인 선물 정보']],
    [APP_ROUTES.scanner, 'AI 신호검색기', ['기술', 'AI 신호검색기']],
    [APP_ROUTES.aiChart, 'AI 차트', ['기술', 'AI 차트']],
    [APP_ROUTES.autoTrading, '자동매매', ['기술', '자동매매']],
    [APP_ROUTES.marketOverview, '지수·시황', ['종목', '지수·시황']],
    [APP_ROUTES.newsInformation, '테마', ['종목', '테마']],
    [APP_ROUTES.strategyPromotion, 'Strategy Promotion Center', ['기술', 'Strategy Promotion Center']],
    [APP_ROUTES.position, '포지션', ['정보', '포지션']],
    [APP_ROUTES.adminUiLayouts, 'UI Builder Layout 통합', ['설정', 'UI Builder Layout 통합']],
  ] as const;

  for (const [path, title, breadcrumb] of expectations) {
    expect(resolveAppRoutePresentation(path), path).toMatchObject({ title, breadcrumb });
  }
});

test('every static product Route in App.tsx has canonical presentation metadata', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const paths = [...appSource.matchAll(/<Route\s+path="(\/[^"?]+)"/g)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path))
    .filter((path) => !path.startsWith('/__'))
    .filter((path) => !path.includes(':'));

  expect(paths.length).toBeGreaterThan(20);
  for (const path of paths) {
    expect(resolveAppRoutePresentation(path), `missing route presentation: ${path}`).not.toBeNull();
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

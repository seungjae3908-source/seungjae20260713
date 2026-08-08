import { test, expect } from '@playwright/test';
import {
  APP_NAVIGATION,
  APP_ROUTES,
  navigationGroupMatches,
  resolveAppRoutePresentation,
} from '../src/lib/app-navigation';

const group = (id: 'assets' | 'technical' | 'settings') => {
  const found = APP_NAVIGATION.find((item) => item.id === id);
  if (!found) throw new Error(`navigation group not found: ${id}`);
  return found;
};

test('active product routes keep the correct top-level navigation state', () => {
  expect(navigationGroupMatches(group('assets'), APP_ROUTES.stocksKr)).toBe(true);
  expect(navigationGroupMatches(group('assets'), APP_ROUTES.stocksUs)).toBe(true);
  expect(navigationGroupMatches(group('assets'), APP_ROUTES.coinsSpot)).toBe(true);
  expect(navigationGroupMatches(group('assets'), APP_ROUTES.coinsFutures)).toBe(true);
  expect(navigationGroupMatches(group('assets'), APP_ROUTES.recommendations)).toBe(true);
  expect(navigationGroupMatches(group('technical'), APP_ROUTES.backtests)).toBe(true);
  expect(navigationGroupMatches(group('technical'), APP_ROUTES.paperTrading)).toBe(true);
  expect(navigationGroupMatches(group('settings'), APP_ROUTES.admin)).toBe(true);
});

test('route presentation metadata defines titles and breadcrumbs without changing App.tsx', () => {
  expect(resolveAppRoutePresentation('/stocks/kr')).toMatchObject({
    title: '국내주식 정보',
    breadcrumb: ['종목', '국내주식'],
    groupId: 'assets',
  });
  expect(resolveAppRoutePresentation('/stocks/us')).toMatchObject({
    title: '미국주식 정보',
    breadcrumb: ['종목', '미국주식'],
    groupId: 'assets',
  });
  expect(resolveAppRoutePresentation('/coins/spot')).toMatchObject({
    title: '코인 현물 정보',
    breadcrumb: ['종목', '코인 현물'],
    groupId: 'assets',
  });
  expect(resolveAppRoutePresentation('/coins/futures')).toMatchObject({
    title: '코인 선물 정보',
    breadcrumb: ['종목', '코인 선물'],
    groupId: 'assets',
  });
  expect(resolveAppRoutePresentation('/recommendations')).toMatchObject({
    title: 'AI 추천',
    breadcrumb: ['종목', 'AI 추천'],
    groupId: 'assets',
  });
  expect(resolveAppRoutePresentation('/backtests?symbol=BTCUSDT')).toMatchObject({
    title: '백테스트',
    breadcrumb: ['기술', '백테스트'],
    groupId: 'technical',
  });
  expect(resolveAppRoutePresentation('/paper-trading')).toMatchObject({
    title: '모의매매',
    breadcrumb: ['기술', '모의매매'],
    groupId: 'technical',
  });
  expect(resolveAppRoutePresentation('/stock/005930?back=%2Fstocks')).toMatchObject({
    title: '종목 상세',
    breadcrumb: ['종목', '종목 상세'],
    groupId: 'assets',
  });
  expect(resolveAppRoutePresentation('/admin')).toMatchObject({
    title: '회원 관리',
    breadcrumb: ['설정', '회원 관리'],
    groupId: 'settings',
  });
});

test('transient and test-only routes stay out of product menu contracts', () => {
  expect(resolveAppRoutePresentation('/crypto/search')).toMatchObject({ transient: true });
  expect(resolveAppRoutePresentation('/crypto/BTC')).toMatchObject({ transient: true });
  expect(resolveAppRoutePresentation('/__phase12-trade-automation-e2e')).toMatchObject({ testOnly: true });

  for (const navGroup of APP_NAVIGATION) {
    expect(navigationGroupMatches(navGroup, '/__phase12-trade-automation-e2e')).toBe(false);
  }
});

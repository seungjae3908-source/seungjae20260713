import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const navigationPath = fileURLToPath(new URL('../src/lib/app-navigation.ts', import.meta.url));

test('primary user-facing navigation uses Korean-first terminology without changing internal routes', async () => {
  const navigation = await readFile(navigationPath, 'utf8');

  for (const label of [
    '국내주식',
    '미국주식',
    '코인현물',
    '코인선물',
    '검색기',
    'AI차트',
    '자동매매',
    '모의자동매매',
    '과거검증',
    '연구센터',
    '포트폴리오',
    '포지션',
    '전략 승격센터',
    '화면 배치 편집',
    '작업 자동화 허브',
  ]) {
    expect(navigation).toContain(`'${label}'`);
  }

  for (const legacyLabel of [
    "label: 'AI 신호검색기'",
    "label: 'AI 차트'",
    "label: '백테스트'",
    "label: '모의매매'",
    "title: 'Strategy Promotion Center'",
    "title: 'UI Builder Layout 통합'",
    "title: 'Agent Hub'",
  ]) {
    expect(navigation).not.toContain(legacyLabel);
  }

  for (const internalRoute of [
    "scanner: '/scanner'",
    "aiChart: '/ai-chart'",
    "autoTrading: '/auto-trading'",
    "backtests: '/backtests'",
    "paperTrading: '/paper-trading'",
    "researchCenter: '/research-center'",
    "portfolio: '/portfolio'",
  ]) {
    expect(navigation).toContain(internalRoute);
  }
});

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const navigationPath = fileURLToPath(new URL('../src/lib/app-navigation.ts', import.meta.url));
const stagingReadinessPath = fileURLToPath(new URL('./phase10-staging-readiness.spec.ts', import.meta.url));
const labelsPath = fileURLToPath(new URL('../src/lib/labels.ts', import.meta.url));
const promotionPagePath = fileURLToPath(new URL('../src/pages/strategy-promotion.tsx', import.meta.url));
const promotionContractPath = fileURLToPath(new URL('../src/lib/strategy-promotion.ts', import.meta.url));

test('primary user-facing navigation uses Korean-first terminology without changing internal routes', async () => {
  const [navigation, stagingReadiness] = await Promise.all([
    readFile(navigationPath, 'utf8'),
    readFile(stagingReadinessPath, 'utf8'),
  ]);

  for (const label of [
    '국내주식',
    '미국주식',
    '코인현물',
    '코인선물',
    '검색기',
    'AI차트',
    '자동매매',
    '모의매매',
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
    "label: '모의자동매매'",
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

  for (const canonicalStagingLabel of [
    "name: 'AI차트'",
    "openMenuRoute('technical', 'AI차트'",
    "openMenuRoute('technical', '모의자동매매'",
    "['검색기', 'AI차트', '과거검증', '모의매매']",
  ]) {
    expect(stagingReadiness).toContain(canonicalStagingLabel);
  }

  for (const staleStagingLabel of [
    "name: 'AI 차트'",
    "openMenuRoute('technical', 'AI 차트'",
    "openMenuRoute('technical', '모의매매'",
    "['AI 신호검색기', 'AI 차트', '백테스트', '모의자동매매']",
  ]) {
    expect(stagingReadiness).not.toContain(staleStagingLabel);
  }
});

test('strategy promotion uses Korean-first presentation while preserving internal evidence codes', async () => {
  const [labels, promotionPage, promotionContract] = await Promise.all([
    readFile(labelsPath, 'utf8'),
    readFile(promotionPagePath, 'utf8'),
    readFile(promotionContractPath, 'utf8'),
  ]);
  const presentation = `${labels}\n${promotionPage}`;

  for (const label of [
    '전략 승격센터',
    '연구 설계',
    '과거검증',
    '독립구간 검증',
    '누수 방지 순차검증',
    '비용 스트레스 검증',
    '시장상태 검증',
    '최종검증',
    '모의매매',
    '실시간 추적검증',
    '추천 결과 검증',
    '근거 필요',
    '표본 부족',
    '승격 검토 후보',
    '근거 출처 및 담당',
    '주문 실행 권한 없음',
  ]) {
    expect(presentation).toContain(label);
  }

  for (const legacyCopy of [
    'Strategy Promotion Center',
    'Research design',
    'Historical backtest',
    'Out-of-sample',
    'Purged walk-forward',
    'Cost stress',
    'Regime validation',
    'Final holdout',
    'Evidence required',
    'Promotion evidence timeline',
    'Evidence and timeline',
    'Loading linked evidence',
    'Promotion evidence unavailable',
    'Evidence source ownership',
  ]) {
    expect(promotionPage).not.toContain(legacyCopy);
  }

  for (const internalCode of [
    "'KR_STOCK'",
    "'US_STOCK'",
    "'CRYPTO_SPOT'",
    "'CRYPTO_FUTURES'",
    "'PASS'",
    "'BLOCKED'",
    "'PROMOTION_CANDIDATE'",
  ]) {
    expect(promotionContract).toContain(internalCode);
  }

  for (const stageMapperEntry of [
    "PAPER: '모의매매'",
    "SHADOW: '실시간 추적검증'",
  ]) {
    expect(labels).toContain(stageMapperEntry);
  }
});

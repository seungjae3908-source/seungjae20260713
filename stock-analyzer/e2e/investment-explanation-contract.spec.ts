import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

test('shared investment explanation registry covers market, research, portfolio and AI concepts', () => {
  const registry = source('src/lib/investment-explanations.ts');
  for (const required of [
    'tradingValue',
    'fundingRate',
    'macroF1',
    'balancedAccuracy',
    'profitFactor',
    'expectancy',
    'maxDrawdown',
    'naturalPaper',
    'settlement',
    'profitability',
    'concentration',
    'correlation',
    'dataQuality',
    'aiConfidence',
    'targetPrice',
    'stopLoss',
  ]) {
    expect(registry).toContain(`${required}:`);
  }
  expect(registry).toContain('방향만으로 좋고 나쁨을 판정하지 않습니다');
  expect(registry).toContain('미수집 상태를 유지');
});

test('AI information fails closed instead of rendering client fabricated target and stop fallbacks', () => {
  const aiTab = source('src/components/tabs/ai-tab.tsx');
  expect(aiTab).toContain('ai-strategy-missing-evidence');
  expect(aiTab).toContain('데이터 부족을 현재가 기준 임의 퍼센트로 보정하지 않습니다');
  expect(aiTab).not.toContain('data.targetPrice');
  expect(aiTab).not.toContain('data.stopLossPrice');
  expect(aiTab).toContain('반대 근거 / 매도 근거');
  expect(aiTab).toContain('판단 무효화 조건');
});

test('explanation UI is deterministic and canonical market information keeps zero AI outbound authority', () => {
  const sheet = source('src/components/investment-explanation-sheet.tsx');
  const marketContract = source('src/lib/market-information.ts');
  expect(sheet).toContain('AI 호출·주문·계좌 조회를 발생시키지 않습니다');
  expect(sheet).toContain('role="dialog"');
  expect(sheet).toContain('왜?');
  expect(marketContract).toMatch(/aiRequests:\s*0/);
  expect(marketContract).toMatch(/privateExchangeRequests:\s*0/);
  expect(marketContract).toMatch(/orderRequests:\s*0/);
});

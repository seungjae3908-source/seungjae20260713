import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('legacy holdings aggregate stays hidden until FX-normalized truth is available', async () => {
  const [holdingsSource, intelligenceSource, geometryCss] = await Promise.all([
    readFile(new URL('../src/pages/portfolio.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/portfolio-v2.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../public/production-ui-geometry.css', import.meta.url), 'utf8'),
  ]);

  expect(holdingsSource).toContain('data-testid="portfolio-holdings-summary"');
  expect(holdingsSource).toContain('국내 원화와 미국 달러 보유분을 단순 합산한 값입니다.');
  expect(holdingsSource).toContain('환율 환산은 다음 단계에서 연결합니다.');

  expect(geometryCss).toMatch(
    /\[data-testid="portfolio-holdings-summary"\]\s*\{\s*display:\s*none\s*!important;\s*\}/,
  );

  expect(intelligenceSource).toContain('normalizedKRW');
  expect(intelligenceSource).toContain('knownNormalizedKRW');
  expect(intelligenceSource).toContain('fx:');
});

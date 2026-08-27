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
    'volume',
    'marketCap',
    'fundingRate',
    'openInterest',
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
    'freshness',
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

test('AI info calls only on send and reuses only freshness-bounded duplicate context', () => {
  const aiInfo = source('src/pages/ai-chat.tsx');
  expect(aiInfo).toContain('responseCacheRef');
  expect(aiInfo).toContain('cacheKey(message)');
  expect(aiInfo).toContain('AI_CHAT_CACHE_TTL_MS = 60_000');
  expect(aiInfo).toContain('now - cached.cachedAt <= AI_CHAT_CACHE_TTL_MS');
  expect(aiInfo).toContain('responseCacheRef.current.delete(key)');
  expect(aiInfo).toContain('캐시 재사용 · AI 호출 0');
  expect(aiInfo).toContain("authorizedFetch('/api/ai/chat'");
  expect(aiInfo).toContain('질문할 때만 AI를 호출하고');
  expect(aiInfo).toContain("new URLSearchParams(window.location.search).get('prompt')");
  expect(aiInfo).not.toContain('void send();\n  }, []);');
});

test('research center explains canonical metrics without creating fake profitability evidence', () => {
  const research = source('src/pages/research-center.tsx');
  expect(research).toContain('metric="macroF1"');
  expect(research).toContain('metric="balancedAccuracy"');
  expect(research).toContain('metric="settlement"');
  expect(research).toContain('metric="profitability"');
  expect(research).toContain('실제 Gemini/Groq 리뷰가 Research Production에 기록되기 전에는 AI 의견을 임의로 만들지 않습니다.');
});

test('market information explains ranking basis and freshness while preserving zero AI outbound authority', () => {
  const marketPage = source('src/pages/market-information.tsx');
  const marketContract = source('src/lib/market-information.ts');
  expect(marketPage).toContain('market-ranking-explanation');
  expect(marketPage).toContain('순위가 높다는 이유만으로 매수·매도 신호로 해석하지 않습니다');
  expect(marketPage).toContain('metric="freshness"');
  expect(marketPage).toContain('metric="fundingRate"');
  expect(marketPage).toContain('metric="openInterest"');
  expect(marketPage).toContain('화면 조회 자체가 AI 호출이나 주문을 만들지 않습니다');
  expect(marketContract).toMatch(/aiRequests:\s*0/);
  expect(marketContract).toMatch(/privateExchangeRequests:\s*0/);
  expect(marketContract).toMatch(/accountRequests:\s*0/);
  expect(marketContract).toMatch(/orderRequests:\s*0/);
});

test('portfolio copilot exposes evidence quality and missing checks before interpretation', () => {
  const portfolio = source('src/components/portfolio-ai-diagnosis.tsx');
  expect(portfolio).toContain('portfolio-evidence-summary');
  expect(portfolio).toContain('portfolio-action-checks');
  expect(portfolio).toContain('AI 답변보다 원본 데이터 품질과 누락 근거를 먼저 봅니다');
  expect(portfolio).toContain('질문할 때만 AI를 호출합니다');
  expect(portfolio).toContain('누락된 현금·계좌·시장 데이터를 0으로 바꾸거나 추정해서 채우지 않습니다');
});

test('explanation UI is deterministic and accessible as a dialog', () => {
  const sheet = source('src/components/investment-explanation-sheet.tsx');
  expect(sheet).toContain('AI 호출·주문·계좌 조회를 발생시키지 않습니다');
  expect(sheet).toContain('role="dialog"');
  expect(sheet).toContain('aria-modal="true"');
  expect(sheet).toContain('왜?');
});

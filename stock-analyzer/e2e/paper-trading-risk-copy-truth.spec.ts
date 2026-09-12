import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync(
  new URL('../src/components/paper-trading-panel.tsx', import.meta.url),
  'utf8',
);

test('paper confirmation describes the local evaluator truthfully', () => {
  expect(source).toContain('execute = evaluatePaperTrading');
  expect(source).toContain('현재 모의 리스크 규칙으로 수량과 차단 여부를 계산하며 실거래 서버 검증이나 주문 권한은 사용하지 않습니다.');
  expect(source).not.toContain('최종 수량과 차단 여부는 서버 리스크 엔진이 다시 계산합니다.');
  expect(source).toContain('모의매매입니다. 실제 거래소 주문은 전송되지 않습니다.');
});

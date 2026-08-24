import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function analyzerDirectory() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

test('Research Center exposes the full evidence maturity ladder without fabricating missing metrics', () => {
  const analyzer = analyzerDirectory();
  const source = fs.readFileSync(
    path.join(analyzer, 'src/lib/research-center-view.ts'),
    'utf8',
  );
  const dashboardSource = fs.readFileSync(
    path.resolve(analyzer, '../research-dashboard/server.mjs'),
    'utf8',
  );

  const orderedStages = [
    '1. 외부 연구 (EXTERNAL RESEARCH)',
    '2. 백테스트 (BACKTEST)',
    '3. OOS',
    '4. Purged Walk-Forward',
    '5. Final Holdout',
    '6. Shadow',
    '7. Natural Paper',
    '8. Settlement',
    '9. Profitability Evidence',
    '10. Strategy Health',
    '11. Promotion',
    '12. Champion',
  ];

  let previous = -1;
  for (const label of orderedStages) {
    const index = source.indexOf(label);
    expect(index, `${label} should exist in maturity order`).toBeGreaterThan(previous);
    previous = index;
  }

  expect(source).toContain('실전 수익성 검증 안 됨');
  expect(source).toContain('CURRENT_VALIDATED_CHAMPION = NONE');
  expect(source).toContain("value: 'CURRENT_VALIDATED_CHAMPION = NONE'");
  expect(source).toContain('Missing Evidence');
  expect(source).toContain('표본 N 미수집');
  expect(source).toContain('PF 미수집');
  expect(source).toContain('EV 미수집');
  expect(source).toContain('MDD 미수집');
  expect(source).toContain('승률 미수집');
  expect(source).toContain('비용조정 미수집');
  expect(source).toContain('데이터셋/구간 미수집');
  expect(source).toContain('코드 SHA는 상세 증거에서 확인');
  expect(source).toContain('N/A and INSUFFICIENT_DATA are never rewritten to zero or PASS');
  expect(source).toContain('authorityEvidenceComplete');
  expect(source).toContain('안전 증거 미수집');
  expect(source).toContain("return value == null ? '미수집'");

  expect(dashboardSource).toContain('function optionalIntegerCount');
  expect(dashboardSource).toContain('safetyEvidenceComplete');
  expect(dashboardSource).toContain("'safety_evidence_incomplete'");
  expect(dashboardSource).not.toContain('function integerCount');

  expect(source).not.toContain("overview.profitability.proven ? 'Champion 근거 미수집'");
  expect(source).not.toContain("value: '0'");
  expect(source).not.toContain("tone: 'good', note: 'Missing Evidence'");
});
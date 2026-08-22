import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('AI Chart position panel stays explicit read-only and fail-closed', () => {
  const panel = source('src/components/ai-chart-position-panel.tsx');

  expect(panel).toContain("import { authorizedFetch } from '@/lib/auth-fetch';");
  expect(panel).toContain('authorizedFetch(`/api/accounts/read-only/${provider}`');
  expect(panel).toContain('data-testid="ai-chart-load-position"');
  expect(panel).toContain('onClick={() => void loadPosition()}');
  expect(panel).toContain('차트를 열기만 해서는 계좌를 조회하지 않습니다.');
  expect(panel).not.toContain('void loadPosition();');

  expect(panel).toContain('snapshot.orderRequests !== 0');
  expect(panel).toContain('snapshot.cancelRequests !== 0');
  expect(panel).toContain('snapshot.amendRequests !== 0');
  expect(panel).toContain('snapshot.transferRequests !== 0');
  expect(panel).toContain('snapshot.withdrawalRequests !== 0');
  expect(panel).toContain('snapshot.liveTradingEnabled !== false');
  expect(panel).toContain('snapshot.autoTradingEnabled !== false');
  expect(panel).toContain("code: 'ACCOUNT_SNAPSHOT_SAFETY_MISMATCH'");

  expect(panel).not.toContain("method: 'POST'");
  expect(panel).not.toContain("method: 'PUT'");
  expect(panel).not.toContain("method: 'PATCH'");
  expect(panel).not.toContain("method: 'DELETE'");
});

test('AI Chart matches four-market positions without inventing missing values', () => {
  const panel = source('src/components/ai-chart-position-panel.tsx');

  expect(panel).toContain("if (market === 'UPBIT') return 'upbit';");
  expect(panel).toContain("if (market === 'BITGET') return 'bitget';");
  expect(panel).toContain("return 'toss';");
  expect(panel).toContain("if (upper.startsWith('KRW-'))");
  expect(panel).toContain('if (matches.length > 1) return { position: null, ambiguous: true };');
  expect(panel).toContain("code: 'MULTIPLE_MATCHING_POSITIONS'");
  expect(panel).toContain("return parsed == null ? '미제공'");
  expect(panel).toContain('평단 대비 가격은 차트/계좌 가격의 단순 가격거리이며 수수료·레버리지 ROE를 임의 계산하지 않습니다.');
});

test('AI Chart draws only evidence-backed average-entry and liquidation position lines', () => {
  const canvas = source('src/components/pattern-aware-unified-chart-canvas.tsx');

  expect(canvas).toContain('positionPriceLines: IPriceLine[];');
  expect(canvas).toContain('removePriceLines(instance.candle, instance.positionPriceLines);');
  expect(canvas).toContain("title: positionOverlay.stale ? '내 평단 · 오래된 값' : '내 평단'");
  expect(canvas).toContain("market === 'BITGET' && validPlanPrice(liquidation)");
  expect(canvas).toContain("title: positionOverlay.stale ? '청산가 · 오래된 값' : '청산가'");
  expect(canvas).toContain('data-position-average={positionOverlay?.position.averageEntryPrice ?? \'\'}');
  expect(canvas).toContain('data-position-liquidation={positionOverlay?.position.liquidationPrice ?? \'\'}');

  expect(canvas).toContain("title: 'Scanner 손절'");
  expect(canvas).toContain('title: `Scanner 목표 ${index + 1}`');
});

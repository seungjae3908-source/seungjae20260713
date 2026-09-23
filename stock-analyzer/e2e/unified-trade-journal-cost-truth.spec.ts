import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const types = readFileSync(new URL('../src/lib/paper-journal-sync.ts', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/components/unified-trade-journal-panel.tsx', import.meta.url), 'utf8');

test('unified journal never turns unavailable canonical costs into numeric zero', () => {
  expect(types).toContain('fees:number|null; tax:number|null; costEvidence:UnifiedJournalCostEvidence; netPnl:number|null');
  expect(types).toContain('maximumConsecutiveLosses:number|null');
  expect(panel).toContain("return value == null ? 'N/A'");
  expect(panel).toContain("trade.costEvidence.status !== 'READY'");
  expect(panel).toContain('value={costMoney(trade)}');
  expect(panel).toContain('value={metric(data.analytics.maximumConsecutiveLosses)}');
  expect(panel).not.toContain('money(trade.fees + trade.tax');
});

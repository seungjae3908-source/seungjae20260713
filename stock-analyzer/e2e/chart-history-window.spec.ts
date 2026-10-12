import { test, expect } from '@playwright/test';
import { historyCursorBeforeTime, mergeBoundedChartHistory } from '../src/lib/chart-history-window';
import { readFileSync } from 'node:fs';

const rows = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({ time: start + index, close: start + index }));

test('history continues past 1,800 genuine bars with bounded sliding archive', () => {
  const prior = rows(201, 1800);
  const earlier = rows(1, 200);
  expect(mergeBoundedChartHistory(prior, earlier, false, 1800)[0]?.time).toBe(201);
  const archive = mergeBoundedChartHistory(prior, earlier, true, 1800);
  expect(archive).toHaveLength(1800);
  expect(archive[0]?.time).toBe(1);
  expect(archive.at(-1)?.time).toBe(1800);
  const yetEarlier = mergeBoundedChartHistory(archive, rows(-199, 200), true, 1800);
  expect(yetEarlier).toHaveLength(1800);
  expect(yetEarlier[0]?.time).toBe(-199);
  expect(yetEarlier.at(-1)?.time).toBe(1600);
  expect(new Set(yetEarlier.map(x => x.time)).size).toBe(1800);
});

test('historical archive never supplies old price context as live decision or stream candle', () => {
  const source = readFileSync(new URL('../src/components/unified-analysis-chart.tsx', import.meta.url), 'utf8');
  expect(source).toContain("const continueAsArchive = archiveMode || historyStatus === 'capped';");
  expect(source).toContain('candles: analysisCandles');
  expect(source).toContain('for (const row of snapshotCandles) combined.set(row.time, row);');
  expect(source).not.toContain('if (!archiveMode) return recentCandles;');
  expect(source).toContain('const analysisIndicators = useMemo(() => computeChartIndicators(analysisCandles)');
  expect(source).toContain('if (!archiveModeRef.current && !realtimeCanvasRef.current?.applyRealtimeCandle(');
  expect(source).toContain('analysis={archiveMode ? null : analysis}');
  expect(source).toContain('const pricePlan = archiveMode ? undefined : selection.pricePlan;');
  expect(source).toContain('data-testid="chart-history-return-current"');
  expect(source).toContain('data-testid="chart-history-archive-mode"');
});

// A bounded visible window can exclude genuinely older bars already loaded.
// The exclusive next cursor must use the oldest fetched history, not visible[0].
test('historical cursor never re-fetches already stored bars after viewport truncation', () => {
  const fetchedHistory = rows(101, 1800);
  const renderedWindow = rows(401, 2000);
  expect(historyCursorBeforeTime(renderedWindow, fetchedHistory)).toBe(101);
  expect(historyCursorBeforeTime(rows(501, 200), [])).toBe(501);
  expect(historyCursorBeforeTime([], [])).toBeNull();
  expect(historyCursorBeforeTime(rows(501, 20), [{ time: 0 }])).toBeNull();
  const chart = readFileSync(new URL('../src/components/unified-analysis-chart.tsx', import.meta.url), 'utf8');
  expect(chart).toContain('const beforeTime = historyCursorBeforeTime(candles, olderCandles)');
});

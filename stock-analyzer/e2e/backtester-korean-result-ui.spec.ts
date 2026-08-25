import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('backtester result UI localizes raw result codes without changing the calculation contract', () => {
  const panel = source('src/components/backtest-research-panel.tsx');
  const backtest = source('src/lib/backtest.ts');

  expect(panel).toContain('sideLabel(trade.side)');
  expect(panel).toContain('exitReasonLabel(trade.exitReason)');
  expect(panel).toContain('regimeLabel(trade.marketRegime)');
  expect(panel).toContain('regimeLabel(item.regime)');
  expect(panel).toContain('validationLabel(item.name)');

  expect(panel).not.toContain('>{trade.side}<');
  expect(panel).not.toContain('>{trade.exitReason}<');
  expect(panel).not.toContain('>{trade.marketRegime}<');
  expect(panel).not.toContain('>{item.regime}<');

  expect(panel).toContain("stop_loss: '손절'");
  expect(panel).toContain("take_profit: '목표가'");
  expect(panel).toContain("bull: '상승장'");
  expect(panel).toContain("bear: '하락장'");
  expect(panel).toContain("sideways: '횡보장'");
  expect(panel).toContain("training: '학습'");
  expect(panel).toContain("validation: '검증'");
  expect(panel).toContain("test: '테스트'");
  expect(panel).toContain('손익비(PF)');
  expect(panel).toContain('샤프지수');
  expect(panel).toContain('소르티노지수');
  expect(panel).toContain('칼마지수');

  expect(panel).toContain("const inputClass = 'h-11");
  expect(panel).toContain('className="mt-4 flex h-12 w-full');

  expect(backtest).toContain("mode: 'backtest-only'");
  expect(backtest).toContain('orderSubmitted: false');
  expect(backtest).toContain("authorizedFetch('/api/backtests/run'");
});

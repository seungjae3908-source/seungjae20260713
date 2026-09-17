import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../api-server/node_modules/esbuild/lib/main.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

test('rendered Paper reference preserves missing values and exposes no manual execution fallback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paper-reference-ui-'));
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  try {
    const outfile = path.join(directory, 'render.cjs');
    await build({
      stdin: { contents: `
        import { renderToStaticMarkup } from 'react-dom/server';
        import { Router } from 'wouter';
        import { BacktestPaperCandidatePreview } from './src/components/backtest-paper-candidate-preview';
        export const render = (imported) => renderToStaticMarkup(<Router ssrPath="/paper-trading"><BacktestPaperCandidatePreview imported={imported} /></Router>);
      `, loader: 'tsx', resolveDir: path.resolve('stock-analyzer') },
      outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node20',
    });
    const { render } = createRequire(import.meta.url)(outfile);
    const invalid = render({ active: true, handoff: null, error: 'INVALID_BACKTEST_PAPER_HANDOFF' });
    assert.match(invalid, /INVALID_BACKTEST_PAPER_HANDOFF/u);
    assert.doesNotMatch(invalid, /paper-order-form|BTCUSDT|모의주문/u);
    const missing = render({ active: true, error: null, handoff: {
      candidateId: null, strategyId: null, parameterHash: null, market: 'CRYPTO_FUTURES', symbol: 'ETHUSDT',
      timeframe: null, side: null, leverage: null, riskPolicyRef: null, costPolicyRef: null, exitPolicyRef: null,
      blockers: ['CANONICAL_STRATEGY_PAPER_CONSUMER_UNAVAILABLE'],
    } });
    for (const field of ['candidateId', 'strategyId', 'parameterHash', 'timeframe', 'side', 'leverage']) {
      assert.match(missing, new RegExp(`data-testid="paper-candidate-${field}">MISSING<`, 'u'));
    }
    assert.match(missing, /REFERENCE_ONLY/u); assert.match(missing, /evidenceCredit=0/u);
    assert.match(missing, /ETHUSDT/u); assert.doesNotMatch(missing, /paper-order-form|BTCUSDT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

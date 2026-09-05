import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test.describe('Paper flat recovery safety contract', () => {
  test('manual close is rebound to the open position symbol before API submission', () => {
    const source = read('../src/lib/paper-trading.ts');
    expect(source).toContain('getFuturesMarketSnapshot');
    expect(source).toContain('loadMarket(position.symbol)');
    expect(source).toContain('const resolvedAction = await resolvePaperTradingActionMarket(state, action)');
    expect(source).toContain('JSON.stringify({ state, action: resolvedAction })');
    expect(source.indexOf('loadMarket(position.symbol)')).toBeLessThan(source.indexOf("authorizedFetch('/api/paper-trading/evaluate'"));
  });

  test('backend rejects a close market whose symbol differs from the position', () => {
    const source = read('../../api-server/src/services/paper-trading-candle.service.ts');
    expect(source).toContain("PaperTradingError('MARKET_SYMBOL_MISMATCH'");
    expect(source).toContain("String(position.symbol ?? '').trim().toUpperCase()");
    expect(source).toContain("String(action.market.symbol ?? '').trim().toUpperCase()");
    expect(source.indexOf("PaperTradingError('MARKET_SYMBOL_MISMATCH'")).toBeLessThan(source.indexOf('referencePrice(action.market'));
  });

  test('Paper snapshot publish truth is user-visible and fail-closed', () => {
    const source = read('../src/lib/paper-trading.ts');
    expect(source).toContain("status: 'PUBLISHED' | 'BLOCKED_DATA'");
    expect(source).toContain("'Natural Paper 스냅샷: PUBLISHED'");
    expect(source).toContain('Natural Paper 스냅샷: BLOCKED_DATA');
    expect(source).toContain("'Natural Paper 스냅샷: UNKNOWN'");
    expect(source).toContain("executionAuthority !== 'NONE'");
    expect(source).toContain('candidate.privateApiAllowed !== false');
    expect(source).toContain('candidate.liveTrading !== false');
    expect(source).toContain('candidate.financialMutationAllowed !== false');
  });

  test('publisher binding preparation remains approval-gated and binding-only', () => {
    const workflow = read('../../.github/workflows/paper-forward-publisher-binding-preparation.yml');
    const script = read('../../ops/prepare-paper-forward-publisher-binding.sh');
    expect(workflow).toContain("/prepare-paper-forward-publisher-binding ");
    expect(workflow).toContain("github.event.issue.number == 23");
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('Required CI 6/6');
    expect(workflow).toContain('Staging PostgreSQL Auth Gate');
    expect(workflow).toContain('Staging Readiness');
    expect(workflow).toContain("grep -Fc '# stock-app-paper-forward-v1'");
    expect(workflow).not.toContain('deploy-production.sh');
    expect(script).toContain("STATE_ROOT=\"${PAPER_FORWARD_STATE_ROOT:-/opt/stock-app-data/paper-forward-v1}\"");
    expect(script).toContain("executionAuthority: 'NONE'");
    expect(script).toContain('privateApiAllowed: false');
    expect(script).toContain('liveTrading: false');
    expect(script).toContain('financialMutationAllowed: false');
    expect(script).not.toMatch(/\bcrontab\s+-|\bpm2\s+(?:start|restart|reload|delete|stop)|\bsystemctl\b/);
  });
});

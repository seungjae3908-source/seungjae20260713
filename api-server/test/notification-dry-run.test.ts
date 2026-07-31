import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runPriceAlertMonitorOnce,
  type PriceAlertMonitorDependencies,
  type PriceAlertRow,
} from '../src/services/notification.service';

function alert(
  id: string,
  overrides: Partial<PriceAlertRow> = {},
): PriceAlertRow {
  return {
    id,
    member_id: `member-${id}`,
    asset_type: 'stock',
    market: 'US',
    symbol: id,
    direction: 'above',
    target_price: 100,
    repeat_enabled: true,
    app_enabled: true,
    push_enabled: true,
    enabled: true,
    expires_at: null,
    last_triggered_at: null,
    condition_met: false,
    ...overrides,
  };
}

test('dry-run evaluates and deduplicates without sending or writing', async () => {
  const rows = [
    alert('WOULD_SEND'),
    alert('DEDUPLICATED', { condition_met: true }),
    alert('NOT_MET'),
    alert('EXPIRED', {
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    }),
  ];
  let loads = 0;
  let priceReads = 0;
  const dependencies: PriceAlertMonitorDependencies = {
    configured: () => true,
    loadAlerts: async () => {
      loads += 1;
      return rows;
    },
    readPrice: async (row) => {
      priceReads += 1;
      return row.id === 'NOT_MET' ? 90 : 110;
    },
  };

  const first = await runPriceAlertMonitorOnce({
    dryRun: true,
    dependencies,
  });
  const restarted = await runPriceAlertMonitorOnce({
    dryRun: true,
    dependencies,
  });

  assert.deepEqual(first, {
    checked: 4,
    eligible: 2,
    deduplicated: 1,
    wouldSend: 1,
    skipped: 2,
    actualSent: 0,
    dryRun: true,
  });
  assert.deepEqual(restarted, first);
  assert.equal(loads, 2);
  assert.equal(priceReads, 6);
});

test('dry-run and normal mode both block when provider is not configured', async () => {
  const dependencies: PriceAlertMonitorDependencies = {
    configured: () => false,
    loadAlerts: async () => {
      throw new Error('must not load');
    },
    readPrice: async () => {
      throw new Error('must not read');
    },
  };

  const dryRun = await runPriceAlertMonitorOnce({
    dryRun: true,
    dependencies,
  });
  const normal = await runPriceAlertMonitorOnce({
    dryRun: false,
    dependencies,
  });

  assert.equal(dryRun.actualSent, 0);
  assert.equal(dryRun.skipReason, 'SUPABASE_NOT_CONFIGURED');
  assert.equal(normal.actualSent, 0);
  assert.equal(normal.skipReason, 'SUPABASE_NOT_CONFIGURED');
});

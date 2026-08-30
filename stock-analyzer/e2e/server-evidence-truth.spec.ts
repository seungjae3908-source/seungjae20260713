import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { evidenceInstant } from '../src/lib/server-evidence';
import { calculatePaperStatistics } from '../src/lib/paper-statistics';
import { parseBackupEvidence, verifyBackupAcknowledgement } from '../src/lib/backup-evidence';

test('server instants reject coercion, invalid calendars, local times and future observations', () => {
  const now = Date.parse('2026-08-31T00:00:00Z');
  for (const input of [null, true, [], 1, '2026-02-30T00:00:00Z', '2026-08-31T00:00:00', '2026-08-31T00:01:00Z', '2026-08-30T00:00:00+14:01']) {
    expect(evidenceInstant(input, now), String(input)).toBe(false);
  }
  expect(evidenceInstant('2026-08-30T12:00:00.123456+09:00', now)).toBe(true);
});

test('paper samples distinguish an empty ledger, missing R, invalid costs and measured losses', () => {
  const empty = calculatePaperStatistics([]);
  expect(empty).toMatchObject({ status: 'MISSING_EVIDENCE', totalTrades: 0, cumulativeNetPnl: 0, totalFees: 0, winRate: null, expectancy: null, averageR: null, profitFactor: null });
  const closed = { status: 'closed' as const, netPnl: 10, entryFee: 0, exitFee: 0, slippageCost: 0, fundingCost: 0, rMultiple: 2, closedAt: '2026-08-02T02:00:00Z' };
  const result = calculatePaperStatistics([closed, { ...closed, netPnl: -5, rMultiple: -1, closedAt: '2026-08-02T03:00:00Z' }]);
  expect(result).toMatchObject({ status: 'READY', totalTrades: 2, winRate: 50, expectancy: 2.5, averageR: 0.5, profitFactor: 2, cumulativeNetPnl: 5, maximumConsecutiveLosses: 1 });
  expect(calculatePaperStatistics([{ ...closed, rMultiple: null }]).averageR).toBeNull();
  expect(calculatePaperStatistics([{ ...closed, closedAt: null }]).maximumConsecutiveLosses).toBeNull();
  expect(calculatePaperStatistics([{ ...closed, fundingCost: NaN }])).toMatchObject({ status: 'INVALID', expectancy: null, cumulativeNetPnl: null, totalFunding: null });
  expect(calculatePaperStatistics([{ ...closed, netPnl: 0 }])).toMatchObject({ winRate: 0, expectancy: 0, cumulativeNetPnl: 0 });
});

test('backup acknowledgement must bind schema, content checksum, item count and client request time', async () => {
  const payload = { 'sa-settings-v1': '{"locale":"ko"}' };
  const timestamp = new Date().toISOString();
  const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const response = { ok: true, exists: true, schemaVersion: 1, itemCount: 1, checksum, updatedAt: timestamp, clientUpdatedAt: timestamp };
  expect(await verifyBackupAcknowledgement(response, payload, timestamp)).toEqual(response);
  for (const invalid of [
    {}, { ...response, ok: false }, { ...response, updatedAt: null }, { ...response, itemCount: 0 },
    { ...response, checksum: '0'.repeat(64) }, { ...response, clientUpdatedAt: '2020-01-01T00:00:00Z' },
    { ...response, schemaVersion: 2 }, { ...response, updatedAt: '2099-01-01T00:00:00Z' },
  ]) await expect(verifyBackupAcknowledgement(invalid, payload, timestamp)).rejects.toThrow();
  expect(parseBackupEvidence({ ok: true, exists: false })).toEqual({ ok: true, exists: false });
  expect(() => parseBackupEvidence({ ok: true, exists: false, localStorage: payload })).toThrow();
});

test('server backup allowlist retains every advertised client backup key', () => {
  const client = fs.readFileSync(path.resolve('src/lib/backup-sync.tsx'), 'utf8').split('] as const;')[0];
  const server = fs.readFileSync(path.resolve('../api-server/src/routes/backup.ts'), 'utf8').split(']);')[0];
  const keys = client.slice(client.indexOf('BACKUP_ALLOWED_KEYS')).matchAll(/'([^']+)'/g);
  for (const match of keys) expect(server).toContain("'" + match[1] + "'");
});

test('malformed backup read does not authorize automatic overwrite', async ({ page }) => {
  let puts = 0;
  await page.clock.install();
  await page.route(/\/api\/backup\/latest(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'PUT') puts++;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/__phase6-paper-trading-e2e');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/backup-sync.tsx';
    const backup = await import(modulePath) as typeof import('../src/lib/backup-sync');
    await backup.startAutoBackup('fixture-backup-user');
    return backup.getBackupStatus();
  });
  expect(result).toMatchObject({ mode: 'error', itemCount: null, updatedAt: null });
  await page.clock.fastForward(31_000);
  expect(puts).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('knowledge-info-auto-backup-ready:fixture-backup-user'))).toBeNull();
});

test('backup save requires a matching server acknowledgement and retries after malformed success', async ({ page }) => {
  let puts = 0;
  await page.route(/\/api\/backup\/latest(?:\?.*)?$/, async (route) => {
    puts++;
    const payload = route.request().postDataJSON() as { schemaVersion: number; localStorage: Record<string, string>; clientUpdatedAt: string };
    const checksum = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(payload.localStorage).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
    await route.fulfill({ json: puts === 1 ? { ok: true } : {
      ok: true, exists: true, schemaVersion: payload.schemaVersion, itemCount: Object.keys(payload.localStorage).length,
      checksum, clientUpdatedAt: payload.clientUpdatedAt, updatedAt: new Date().toISOString(),
    } });
  });
  await page.goto('/__phase6-paper-trading-e2e');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/backup-sync.tsx';
    const backup = await import(modulePath) as typeof import('../src/lib/backup-sync');
    let failed = false;
    try { await backup.saveBackupNow('fixture-backup-user'); } catch { failed = true; }
    const before = backup.getBackupStatus();
    await backup.saveBackupNow('fixture-backup-user');
    const after = backup.getBackupStatus();
    backup.stopAutoBackup();
    return { failed, before, after };
  });
  expect(result.failed).toBe(true);
  expect(result.before).toMatchObject({ mode: 'error', updatedAt: null });
  expect(result.after).toMatchObject({ mode: 'synced', memberId: 'fixture-backup-user' });
  expect(result.after.updatedAt).not.toBeNull();
  expect(puts).toBe(2);
});

test('backup restore checks content integrity before changing local settings', async ({ page }) => {
  let reads = 0;
  await page.route(/\/api\/backup\/latest(?:\?.*)?$/, (route) => {
    reads++;
    return route.fulfill({ json: {
    ok: true, exists: true, schemaVersion: 1, itemCount: 1, checksum: '0'.repeat(64),
    localStorage: { 'sa-settings-v1': '{"changed":true}' }, clientUpdatedAt: null, updatedAt: new Date().toISOString(),
  } });
  });
  await page.goto('/__phase6-paper-trading-e2e');
  const result = await page.evaluate(async () => {
    localStorage.setItem('sa-settings-v1', '{"original":true}');
    const modulePath = '/src/lib/backup-sync.tsx';
    const backup = await import(modulePath) as typeof import('../src/lib/backup-sync');
    let failed = false;
    try { await backup.restoreRemoteBackup('fixture-backup-user'); } catch { failed = true; }
    backup.stopAutoBackup();
    return { failed, settings: localStorage.getItem('sa-settings-v1') };
  });
  expect(result).toEqual({ failed: true, settings: '{"original":true}' });
  expect(reads).toBe(1);
});

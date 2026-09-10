import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  BACKUP_ALLOWED_KEYS,
  INVALID_BACKUP_RESPONSE,
  requireBackupSuccessResponse,
} from '../src/lib/backup-response-truth';

function checksum(localStorage: Record<string, string>) {
  const sorted = Object.fromEntries(
    Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function timestamp(offsetMs = -1_000) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function existingBackup(localStorage: Record<string, string>) {
  return {
    ok: true,
    exists: true,
    schemaVersion: 1,
    localStorage,
    itemCount: Object.keys(localStorage).length,
    checksum: checksum(localStorage),
    clientUpdatedAt: timestamp(-2_000),
    updatedAt: timestamp(-1_000),
  };
}

test('backup GET accepts only the canonical empty response', async () => {
  await expect(requireBackupSuccessResponse('GET', { ok: true, exists: false })).resolves.toBeUndefined();
  await expect(requireBackupSuccessResponse('GET', { ok: true, exists: false, itemCount: 0 }))
    .rejects.toThrow(INVALID_BACKUP_RESPONSE);
});

test('backup GET accepts a complete current-schema backup', async () => {
  const localStorage = {
    'sa-settings-v1': '{"theme":"dark"}',
    'sa-saved-searches-v1': '[]',
    'sa-analysis-selection-v1': '{"market":"KR"}',
  };
  await expect(requireBackupSuccessResponse('GET', existingBackup(localStorage))).resolves.toBeUndefined();
});

test('backup GET rejects partial, contradictory, or checksum-mismatched HTTP 200 truth before restore', async () => {
  await expect(requireBackupSuccessResponse('GET', { ok: true, exists: true }))
    .rejects.toThrow(INVALID_BACKUP_RESPONSE);
  await expect(requireBackupSuccessResponse('GET', existingBackup({ 'unknown-key': 'value' })))
    .rejects.toThrow(INVALID_BACKUP_RESPONSE);
  await expect(requireBackupSuccessResponse('GET', {
    ...existingBackup({ 'sa-settings-v1': '{}' }),
    itemCount: 0,
  })).rejects.toThrow(INVALID_BACKUP_RESPONSE);
  await expect(requireBackupSuccessResponse('GET', {
    ...existingBackup({ 'sa-settings-v1': '{}' }),
    checksum: 'a'.repeat(64),
  })).rejects.toThrow(INVALID_BACKUP_RESPONSE);
  await expect(requireBackupSuccessResponse('GET', {
    ...existingBackup({ 'sa-settings-v1': '{}' }),
    updatedAt: timestamp(10 * 60 * 1000),
  })).rejects.toThrow(INVALID_BACKUP_RESPONSE);
});

test('backup PUT requires response identity to match the exact submitted backup', async () => {
  const localStorage = {
    'sa-saved-searches-v1': '[{"q":"AAPL"}]',
    'sa-analysis-selection-v1': '{"market":"US","ticker":"AAPL"}',
  };
  const clientUpdatedAt = timestamp(-2_000);
  const requestBody = JSON.stringify({ schemaVersion: 1, localStorage, clientUpdatedAt });
  const response = {
    ok: true,
    exists: true,
    schemaVersion: 1,
    itemCount: 2,
    checksum: checksum(localStorage),
    clientUpdatedAt,
    updatedAt: timestamp(-1_000),
  };

  await expect(requireBackupSuccessResponse('PUT', response, requestBody)).resolves.toBeUndefined();
  await expect(requireBackupSuccessResponse('PUT', { ...response, itemCount: 1 }, requestBody))
    .rejects.toThrow(INVALID_BACKUP_RESPONSE);
  await expect(requireBackupSuccessResponse('PUT', { ...response, schemaVersion: 2 }, requestBody))
    .rejects.toThrow(INVALID_BACKUP_RESPONSE);
  await expect(requireBackupSuccessResponse('PUT', { ...response, checksum: 'b'.repeat(64) }, requestBody))
    .rejects.toThrow(INVALID_BACKUP_RESPONSE);
  await expect(requireBackupSuccessResponse('PUT', {
    ...response,
    clientUpdatedAt: timestamp(-20_000),
  }, requestBody)).rejects.toThrow(INVALID_BACKUP_RESPONSE);
});

test('backup key contract includes settings that the client already collects', () => {
  expect(BACKUP_ALLOWED_KEYS).toContain('sa-saved-searches-v1');
  expect(BACKUP_ALLOWED_KEYS).toContain('sa-analysis-selection-v1');
});

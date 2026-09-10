import { expect, test } from '@playwright/test';
import {
  BACKUP_ALLOWED_KEYS,
  INVALID_BACKUP_RESPONSE,
  requireBackupSuccessResponse,
} from '../src/lib/backup-response-truth';

const checksum = 'a'.repeat(64);

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
    checksum,
    clientUpdatedAt: timestamp(-2_000),
    updatedAt: timestamp(-1_000),
  };
}

test('backup GET accepts only the canonical empty response', () => {
  expect(() => requireBackupSuccessResponse('GET', { ok: true, exists: false })).not.toThrow();
  expect(() => requireBackupSuccessResponse('GET', { ok: true, exists: false, itemCount: 0 }))
    .toThrow(INVALID_BACKUP_RESPONSE);
});

test('backup GET accepts a complete current-schema backup', () => {
  const localStorage = {
    'sa-settings-v1': '{"theme":"dark"}',
    'sa-saved-searches-v1': '[]',
    'sa-analysis-selection-v1': '{"market":"KR"}',
  };
  expect(() => requireBackupSuccessResponse('GET', existingBackup(localStorage))).not.toThrow();
});

test('backup GET rejects partial or contradictory HTTP 200 truth before restore', () => {
  expect(() => requireBackupSuccessResponse('GET', { ok: true, exists: true }))
    .toThrow(INVALID_BACKUP_RESPONSE);
  expect(() => requireBackupSuccessResponse('GET', existingBackup({ 'unknown-key': 'value' })))
    .toThrow(INVALID_BACKUP_RESPONSE);
  expect(() => requireBackupSuccessResponse('GET', {
    ...existingBackup({ 'sa-settings-v1': '{}' }),
    itemCount: 0,
  })).toThrow(INVALID_BACKUP_RESPONSE);
  expect(() => requireBackupSuccessResponse('GET', {
    ...existingBackup({ 'sa-settings-v1': '{}' }),
    updatedAt: timestamp(10 * 60 * 1000),
  })).toThrow(INVALID_BACKUP_RESPONSE);
});

test('backup PUT requires response identity to match the exact submitted backup', () => {
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
    checksum,
    clientUpdatedAt,
    updatedAt: timestamp(-1_000),
  };

  expect(() => requireBackupSuccessResponse('PUT', response, requestBody)).not.toThrow();
  expect(() => requireBackupSuccessResponse('PUT', { ...response, itemCount: 1 }, requestBody))
    .toThrow(INVALID_BACKUP_RESPONSE);
  expect(() => requireBackupSuccessResponse('PUT', { ...response, schemaVersion: 2 }, requestBody))
    .toThrow(INVALID_BACKUP_RESPONSE);
});

test('backup key contract includes settings that the client already collects', () => {
  expect(BACKUP_ALLOWED_KEYS).toContain('sa-saved-searches-v1');
  expect(BACKUP_ALLOWED_KEYS).toContain('sa-analysis-selection-v1');
});

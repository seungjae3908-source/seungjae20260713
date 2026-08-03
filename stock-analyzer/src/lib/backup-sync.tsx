import { useEffect, useSyncExternalStore } from 'react';
import { api, type LatestBackupResponse } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_ALLOWED_KEYS = [
  'knowledge-info-asset-mode-v1',
  'sa-settings-v1',
  'stock-currency-mode',
  'app-accent-color',
  'app-appearance-mode',
  'seungjae_watchlist_v1',
  'scanner.threshold.v1',
  'scanner-market',
  'sa-saved-searches-v1',
  'sa-analysis-selection-v1',
  'sa-auto-trade-settings-v1',
  'sa-portfolio-chart-overlays-v1',
  'sa-portfolio-purchase-dates-v1',
  'sa-chart-volume-height-v1',
  'sa-chart-frames-v1',
  'sa-chart-ma-v1',
] as const;

const allowedKeySet = new Set<string>(BACKUP_ALLOWED_KEYS);
const SYNC_INTERVAL_MS = 15_000;

type BackupMode = 'idle' | 'checking' | 'syncing' | 'synced' | 'paused' | 'error';

export type BackupSyncStatus = {
  mode: BackupMode;
  message: string;
  memberId: string | null;
  itemCount: number;
  updatedAt: string | null;
  remoteUpdatedAt: string | null;
};

let status: BackupSyncStatus = {
  mode: 'idle',
  message: '자동백업 대기 중',
  memberId: null,
  itemCount: 0,
  updatedAt: null,
  remoteUpdatedAt: null,
};
let activeMemberId: string | null = null;
let intervalId: number | null = null;
let retryId: number | null = null;
let lastFingerprint = '';
let syncing = false;
const listeners = new Set<() => void>();

function readyKey(memberId: string) {
  return `knowledge-info-auto-backup-ready:${memberId}`;
}

function updateStatus(patch: Partial<BackupSyncStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((listener) => listener());
}

function fingerprint(data: Record<string, string>) {
  return JSON.stringify(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
}

export function collectBackupData(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const data: Record<string, string> = {};
  for (const key of BACKUP_ALLOWED_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value !== null) data[key] = value;
  }
  return data;
}

export function normalizeBackupData(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('백업 데이터 형식이 올바르지 않습니다.');
  }
  const entries = Object.entries(value).filter(
    ([key, item]) => allowedKeySet.has(key) && typeof item === 'string',
  ) as Array<[string, string]>;
  if (entries.length > 500) throw new Error('백업 항목 수가 비정상적입니다.');
  return Object.fromEntries(entries);
}

export function applyBackupData(value: unknown): number {
  const data = normalizeBackupData(value);
  const entries = Object.entries(data);
  const previous = new Map(BACKUP_ALLOWED_KEYS.map((key) => [key, window.localStorage.getItem(key)]));

  try {
    for (const key of BACKUP_ALLOWED_KEYS) window.localStorage.removeItem(key);
    for (const [key, item] of entries) window.localStorage.setItem(key, item);
  } catch (cause) {
    previous.forEach((item, key) => {
      if (item === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, item);
    });
    throw cause;
  }
  return entries.length;
}

async function uploadCurrent(memberId: string, force = false) {
  if (syncing || activeMemberId !== memberId) return;
  const localStorage = collectBackupData();
  const currentFingerprint = fingerprint(localStorage);
  if (!force && currentFingerprint === lastFingerprint) return;

  syncing = true;
  updateStatus({
    mode: 'syncing',
    message: '최신 설정을 자동백업하고 있습니다.',
    itemCount: Object.keys(localStorage).length,
  });
  try {
    const saved = await api.saveLatestBackup({
      schemaVersion: BACKUP_SCHEMA_VERSION,
      localStorage,
      clientUpdatedAt: new Date().toISOString(),
    });
    if (activeMemberId !== memberId) return;
    lastFingerprint = currentFingerprint;
    updateStatus({
      mode: 'synced',
      message: '최신 1개 백업으로 자동 저장되었습니다.',
      itemCount: saved.itemCount ?? Object.keys(localStorage).length,
      updatedAt: saved.updatedAt ?? new Date().toISOString(),
      remoteUpdatedAt: saved.updatedAt ?? null,
    });
  } catch (cause) {
    if (activeMemberId !== memberId) return;
    updateStatus({
      mode: 'error',
      message: cause instanceof Error ? `자동백업 실패: ${cause.message}` : '자동백업에 실패했습니다.',
    });
  } finally {
    syncing = false;
  }
}

function beginInterval(memberId: string) {
  if (intervalId !== null) window.clearInterval(intervalId);
  intervalId = window.setInterval(() => void uploadCurrent(memberId), SYNC_INTERVAL_MS);
}

function scheduleRetry(memberId: string) {
  if (retryId !== null) window.clearTimeout(retryId);
  retryId = window.setTimeout(() => void startAutoBackup(memberId), 60_000);
}

export async function startAutoBackup(memberId: string) {
  if (!memberId) return;
  stopAutoBackup();
  activeMemberId = memberId;
  updateStatus({
    mode: 'checking',
    message: '서버의 최신 백업을 확인하고 있습니다.',
    memberId,
    itemCount: 0,
    updatedAt: null,
    remoteUpdatedAt: null,
  });

  try {
    const remote = await api.backupLatest();
    if (activeMemberId !== memberId) return;
    const deviceReady = window.localStorage.getItem(readyKey(memberId)) === '1';

    if (remote.exists && !deviceReady) {
      updateStatus({
        mode: 'paused',
        message: '서버에 기존 백업이 있습니다. 설정에서 복원 또는 현재 기기로 덮어쓰기를 선택하세요.',
        itemCount: remote.itemCount ?? 0,
        remoteUpdatedAt: remote.updatedAt ?? null,
      });
      return;
    }

    window.localStorage.setItem(readyKey(memberId), '1');
    lastFingerprint = '';
    await uploadCurrent(memberId, true);
    beginInterval(memberId);
  } catch (cause) {
    if (activeMemberId !== memberId) return;
    updateStatus({
      mode: 'error',
      message: cause instanceof Error ? `자동백업 확인 실패: ${cause.message}` : '자동백업 저장소를 확인하지 못했습니다.',
    });
    scheduleRetry(memberId);
  }
}

export function stopAutoBackup() {
  if (intervalId !== null && typeof window !== 'undefined') window.clearInterval(intervalId);
  if (retryId !== null && typeof window !== 'undefined') window.clearTimeout(retryId);
  intervalId = null;
  retryId = null;
  activeMemberId = null;
  lastFingerprint = '';
  syncing = false;
}

export async function overwriteRemoteBackup(memberId: string) {
  if (!memberId) throw new Error('로그인 회원을 확인할 수 없습니다.');
  if (activeMemberId !== memberId) activeMemberId = memberId;
  window.localStorage.setItem(readyKey(memberId), '1');
  lastFingerprint = '';
  await uploadCurrent(memberId, true);
  beginInterval(memberId);
}

export async function restoreRemoteBackup(memberId: string): Promise<number> {
  if (!memberId) throw new Error('로그인 회원을 확인할 수 없습니다.');
  const remote: LatestBackupResponse = await api.backupLatest();
  if (!remote.exists || !remote.localStorage) throw new Error('복원할 서버 백업이 없습니다.');
  const count = applyBackupData(remote.localStorage);
  window.localStorage.setItem(readyKey(memberId), '1');
  activeMemberId = memberId;
  lastFingerprint = fingerprint(collectBackupData());
  updateStatus({
    mode: 'synced',
    message: '서버 최신 백업을 복원했습니다. 화면을 새로고침합니다.',
    memberId,
    itemCount: count,
    updatedAt: remote.updatedAt ?? null,
    remoteUpdatedAt: remote.updatedAt ?? null,
  });
  beginInterval(memberId);
  return count;
}

export async function saveBackupNow(memberId: string) {
  if (!memberId) throw new Error('로그인 회원을 확인할 수 없습니다.');
  if (activeMemberId !== memberId) activeMemberId = memberId;
  window.localStorage.setItem(readyKey(memberId), '1');
  await uploadCurrent(memberId, true);
  beginInterval(memberId);
}

export function subscribeBackupStatus(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBackupStatus() {
  return status;
}

export function useBackupStatus() {
  return useSyncExternalStore(subscribeBackupStatus, getBackupStatus, getBackupStatus);
}

export function AutoBackupSync() {
  const auth = useAuth();
  const memberId = auth.isApproved ? auth.user?.id ?? null : null;

  useEffect(() => {
    if (!memberId) {
      stopAutoBackup();
      return;
    }
    void startAutoBackup(memberId);
    return stopAutoBackup;
  }, [memberId]);

  return null;
}

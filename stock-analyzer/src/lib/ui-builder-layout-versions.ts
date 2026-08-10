import {
  activateUiBuilderLayout,
  makeFrozenUiBuilderTemplate,
  validateUiBuilderFullLayout,
  type UiBuilderDeviceClass,
  type UiBuilderFullLayoutDocument,
  type UiBuilderPageId,
} from './ui-builder-full-layout';

export type UiBuilderLayoutVersionRecord = {
  version: number;
  activatedAt: string;
  source: 'activate' | 'rollback' | 'default-restore';
  layout: UiBuilderFullLayoutDocument;
};

function versionsKey(pageId: UiBuilderPageId, device: UiBuilderDeviceClass) {
  return `stock-ui-builder:layout-versions:${pageId}:${device}`;
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

export function readUiBuilderLayoutVersions(pageId: UiBuilderPageId, device: UiBuilderDeviceClass): UiBuilderLayoutVersionRecord[] {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem(versionsKey(pageId, device));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((record): record is UiBuilderLayoutVersionRecord => {
        if (!record || typeof record !== 'object') return false;
        const candidate = record as UiBuilderLayoutVersionRecord;
        return Number.isInteger(candidate.version)
          && typeof candidate.activatedAt === 'string'
          && ['activate', 'rollback', 'default-restore'].includes(candidate.source)
          && validateUiBuilderFullLayout(candidate.layout, pageId, device).valid;
      })
      .sort((a, b) => b.version - a.version);
  } catch {
    return [];
  }
}

function persist(records: UiBuilderLayoutVersionRecord[], pageId: UiBuilderPageId, device: UiBuilderDeviceClass) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(versionsKey(pageId, device), JSON.stringify(records));
}

function nextVersion(pageId: UiBuilderPageId, device: UiBuilderDeviceClass) {
  const records = readUiBuilderLayoutVersions(pageId, device);
  return records.reduce((max, record) => Math.max(max, record.version), 0) + 1;
}

function publishVersion(
  layout: UiBuilderFullLayoutDocument,
  source: UiBuilderLayoutVersionRecord['source'],
): UiBuilderFullLayoutDocument {
  const validation = validateUiBuilderFullLayout(layout, layout.pageId, layout.deviceClass);
  if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join('\n'));

  const now = new Date().toISOString();
  const version = nextVersion(layout.pageId, layout.deviceClass);
  const published: UiBuilderFullLayoutDocument = {
    ...clone(layout),
    version,
    status: 'published',
    updatedAt: now,
    publishedAt: now,
  };

  activateUiBuilderLayout(published);
  const records = readUiBuilderLayoutVersions(layout.pageId, layout.deviceClass);
  persist([
    { version, activatedAt: now, source, layout: clone(published) },
    ...records,
  ], layout.pageId, layout.deviceClass);
  return published;
}

export function activateUiBuilderLayoutVersion(layout: UiBuilderFullLayoutDocument) {
  return publishVersion(layout, 'activate');
}

export function rollbackUiBuilderLayoutVersion(pageId: UiBuilderPageId, device: UiBuilderDeviceClass, version: number) {
  const record = readUiBuilderLayoutVersions(pageId, device).find((item) => item.version === version);
  if (!record) throw new Error(`Rollback 대상 version ${version}을 찾을 수 없습니다.`);
  const next = clone(record.layout);
  next.layoutId = `${record.layout.layoutId}-rollback-${Date.now()}`;
  return publishVersion(next, 'rollback');
}

export function restoreDefaultUiBuilderLayout(pageId: UiBuilderPageId, device: UiBuilderDeviceClass) {
  const fallback = makeFrozenUiBuilderTemplate(pageId, device);
  fallback.layoutId = `builder-default-restore-${pageId.toLowerCase()}-${device}-${Date.now()}`;
  return publishVersion(fallback, 'default-restore');
}

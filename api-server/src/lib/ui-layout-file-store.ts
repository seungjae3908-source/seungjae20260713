import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type StoredUiLayout = {
  id: string;
  page_key: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  schema_version: number;
  layout: unknown;
  note: string | null;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
};

const STORE_PATH = process.env.UI_LAYOUT_STORE_PATH || '/var/lib/stock-app/ui-layout-versions.json';

function readAll(): StoredUiLayout[] {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeAll(rows: StoredUiLayout[]) {
  mkdirSync(dirname(STORE_PATH), { recursive: true, mode: 0o750 });
  const temporary = `${STORE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(rows, null, 2), { encoding: 'utf8', mode: 0o640 });
  renameSync(temporary, STORE_PATH);
}

export function listFileLayouts(pageKey: string) {
  return readAll().filter((row) => row.page_key === pageKey).sort((a, b) => b.version - a.version).slice(0, 100);
}

export function createFileDraft(pageKey: string, layout: unknown, note: string | null, createdBy: string | null) {
  const rows = readAll();
  const version = Math.max(0, ...rows.filter((row) => row.page_key === pageKey).map((row) => row.version)) + 1;
  const item: StoredUiLayout = {
    id: randomUUID(), page_key: pageKey, version, status: 'draft', schema_version: 2,
    layout, note, created_by: createdBy, created_at: new Date().toISOString(), published_at: null,
  };
  rows.push(item); writeAll(rows); return item;
}

export function publishFileLayout(pageKey: string, layout: unknown, requestedId: string | null, createdBy: string | null) {
  const rows = readAll();
  let item = requestedId ? rows.find((row) => row.id === requestedId && row.page_key === pageKey) : undefined;
  if (item) { item.layout = layout; item.schema_version = 2; }
  else {
    const version = Math.max(0, ...rows.filter((row) => row.page_key === pageKey).map((row) => row.version)) + 1;
    item = { id: randomUUID(), page_key: pageKey, version, status: 'draft', schema_version: 2, layout, note: null, created_by: createdBy, created_at: new Date().toISOString(), published_at: null };
    rows.push(item);
  }
  for (const row of rows) if (row.page_key === pageKey && row.status === 'published' && row.id !== item.id) row.status = 'archived';
  item.status = 'published'; item.published_at = new Date().toISOString(); writeAll(rows); return item;
}

export function rollbackFileLayout(pageKey: string, sourceId: string, createdBy: string | null) {
  const source = readAll().find((row) => row.id === sourceId && row.page_key === pageKey);
  if (!source) return null;
  return createFileDraft(pageKey, source.layout, `버전 ${source.version}에서 복원한 초안`, createdBy);
}

export function publishedFileLayout(pageKey: string) {
  return listFileLayouts(pageKey).find((row) => row.status === 'published') ?? null;
}

// Crash-aware, bounded and research-only local writes.
// No network, order, Paper, database, archive or retention deletion.
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const WATCH_STORAGE_LIMITS = Object.freeze({
  dailyJsonlBytes: 64 * 1024 * 1024,
  singleAppendBytes: 2 * 1024 * 1024,
  jsonlLineBytes: 16 * 1024,
  maxRowsPerAppend: 1024,
  stateJsonBytes: 8_000_000,
  publicStatusJsonBytes: 64 * 1024,
});

const FILE_MODE_MASK = 0o077;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
function validDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00.000Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function validTime(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function validInteger(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

async function fsyncParentDirectory(path) {
  const dir = await open(dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export function checkWatchDailyAppend({ size, appendBytes, isFile, nlink, mode }) {
  if (isFile !== true || nlink !== 1 || !validInteger(size)
    || !validInteger(appendBytes) || appendBytes === 0
    || appendBytes > WATCH_STORAGE_LIMITS.singleAppendBytes
    || !validInteger(mode) || (mode & FILE_MODE_MASK) !== 0)
    throw new Error('WATCH_LOG_FILE_OR_APPEND_UNSAFE');
  if (size > WATCH_STORAGE_LIMITS.dailyJsonlBytes
    || appendBytes > WATCH_STORAGE_LIMITS.dailyJsonlBytes - size)
    throw new Error('WATCH_DAILY_LOG_CAP_REACHED');
  return Object.freeze({
    currentBytes: size, afterAppendBytes: size + appendBytes,
    capBytes: WATCH_STORAGE_LIMITS.dailyJsonlBytes,
  });
}

export async function appendBoundedWatchEvents(root, events, observedAt, category) {
  if (category !== 'events' && category !== 'outcomes')
    throw new Error('WATCH_LOG_CATEGORY_INVALID');
  if (!Array.isArray(events) || events.length > WATCH_STORAGE_LIMITS.maxRowsPerAppend)
    throw new Error('WATCH_LOG_RECORD_COUNT_INVALID');
  if (!validTime(observedAt)) throw new Error('WATCH_LOG_TIME_INVALID');
  if (!events.length) return;
  const dayUtc = observedAt.slice(0, 10);
  if (!validDay(dayUtc)) throw new Error('WATCH_LOG_DAY_INVALID');
  const lines = events.map(entry => JSON.stringify(entry));
  if (lines.some(line => typeof line !== 'string'
      || Buffer.byteLength(line, 'utf8') > WATCH_STORAGE_LIMITS.jsonlLineBytes))
    throw new Error('WATCH_LOG_ROW_OVERSIZE');
  const data = lines.join('\n') + '\n';
  const appendBytes = Buffer.byteLength(data, 'utf8');
  if (appendBytes > WATCH_STORAGE_LIMITS.singleAppendBytes)
    throw new Error('WATCH_LOG_APPEND_OVERSIZE');
  const path = join(root, 'watch', category, dayUtc + '.jsonl');
  const handle = await open(path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    checkWatchDailyAppend({
      size: info.size, appendBytes, isFile: info.isFile(),
      nlink: info.nlink, mode: info.mode,
    });
    // Fail closed on an unsafe size/mode rather than silently overflowing
    // the daily file. fsync before state cursor publication below.
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // First append of the UTC day creates a directory entry. Persist the entry
  // before advancing the state cursor, not merely the file's contents.
  await fsyncParentDirectory(path);
}

export async function atomicDurableWatchJson(path, value, maxBytes = WATCH_STORAGE_LIMITS.stateJsonBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
    || maxBytes > WATCH_STORAGE_LIMITS.stateJsonBytes)
    throw new Error('WATCH_ATOMIC_LIMIT_INVALID');
  const content = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(content, 'utf8') > maxBytes)
    throw new Error('WATCH_ATOMIC_JSON_OVERSIZE');
  const temporary = path + '.tmp-' + randomUUID();
  try {
    const file = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    // Sync the parent directory so renaming the cursor/status does not get
    // ahead of already synced research event append after a power loss.
    await fsyncParentDirectory(path);
  } finally {
    await rm(temporary, { force: true });
  }
}

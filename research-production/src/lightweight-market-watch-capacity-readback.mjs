// Bounded read-only capacity census for the isolated public Research watch.
// File METADATA ONLY; no file contents, network, deleting, archiving or orders.
import { constants } from 'node:fs';
import { lstat, open, opendir, statfs } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import {
  WATCH_CAPACITY_POLICY, summarizeWatchStorageCapacity,
} from './lightweight-market-watch-capacity.mjs';

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const MAX_DIRECTORY_ENTRIES = WATCH_CAPACITY_POLICY.maxDays;
const PRIVATE_FILE_MASK = 0o077;
const UNTRUSTED_DIRECTORY_MASK = 0o022;

function safeRoot(root) {
  return typeof root === 'string' && root !== '/'
    && isAbsolute(root) && resolve(root) === root;
}
function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day))
    return false;
  const t = Date.parse(day + 'T00:00:00.000Z');
  return Number.isSafeInteger(t)
    && new Date(t).toISOString().slice(0, 10) === day;
}
async function verifyDirectory(path) {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()
    || (before.mode & UNTRUSTED_DIRECTORY_MASK) !== 0)
    throw new Error('WATCH_CAPACITY_DIRECTORY_UNSAFE');
  const handle = await open(path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isDirectory() || actual.ino !== before.ino
      || actual.dev !== before.dev
      || (actual.mode & UNTRUSTED_DIRECTORY_MASK) !== 0)
      throw new Error('WATCH_CAPACITY_DIRECTORY_CHANGED');
  } finally {
    await handle.close();
  }
  return { dev: before.dev, ino: before.ino };
}
async function scanCategory(root, category, nowUtcDay) {
  const path = join(root, 'watch', category);
  let original;
  try { original = await verifyDirectory(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return { missing: true, files: [] };
    throw error;
  }
  const files = [];
  const dir = await opendir(path, { bufferSize: 8 });
  let entries = 0;
  try {
    for await (const row of dir) {
      entries++;
      if (entries > MAX_DIRECTORY_ENTRIES)
        throw new Error('WATCH_CAPACITY_DIRECTORY_LIMIT');
      const match = DAY_FILE.exec(row.name);
      if (!match || !validDay(match[1]) || match[1] > nowUtcDay)
        throw new Error('WATCH_CAPACITY_UNEXPECTED_FILE');
      const info = await lstat(join(path, row.name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || !Number.isSafeInteger(info.size) || info.size < 1
        || info.size > WATCH_CAPACITY_POLICY.maxFileBytes
        || (info.mode & PRIVATE_FILE_MASK) !== 0)
        throw new Error('WATCH_CAPACITY_FILE_UNSAFE');
      files.push({ category, day: match[1], bytes: info.size });
    }
  } finally {
    // The async iterator closes its handle, including on early exceptions.
    // Avoid calling close() twice here.
  }
  const after = await verifyDirectory(path);
  if (original.dev !== after.dev || original.ino !== after.ino)
    throw new Error('WATCH_CAPACITY_DIRECTORY_CHANGED');
  return { missing: false, files };
}
export async function readWatchStorageCapacity(root, nowMs = Date.now()) {
  if (!safeRoot(root) || !Number.isSafeInteger(nowMs) || nowMs <= 0)
    throw new Error('WATCH_CAPACITY_ROOT_INVALID');
  await verifyDirectory(root);
  const storage = await statfs(root);
  const diskFreeBytes = Number(storage.bavail) * Number(storage.bsize);
  if (!Number.isSafeInteger(diskFreeBytes) || diskFreeBytes < 0)
    throw new Error('WATCH_CAPACITY_DISK_INVALID');
  const nowUtcDay = new Date(nowMs).toISOString().slice(0, 10);
  const watchPath = join(root, 'watch');
  try { await verifyDirectory(watchPath); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return Object.freeze({
      ...summarizeWatchStorageCapacity({ files: [], diskFreeBytes, nowUtcDay }),
      missingCategoryCount: WATCH_CAPACITY_POLICY.categories.length,
      categoryMetadataComplete: false, sourceDataRead: false,
    });
  }
  const scans = [];
  for (const category of WATCH_CAPACITY_POLICY.categories)
    scans.push(await scanCategory(root, category, nowUtcDay));
  const files = scans.flatMap(row => row.files);
  const summary = summarizeWatchStorageCapacity({
    files, diskFreeBytes, nowUtcDay,
  });
  const missingCategoryCount = scans.filter(row => row.missing).length;
  return Object.freeze({
    ...summary,
    status: missingCategoryCount && summary.status === 'OBSERVATION_ONLY'
      ? 'INCOMPLETE_DIRECTORY_COVERAGE' : summary.status,
    missingCategoryCount,
    categoryMetadataComplete: missingCategoryCount === 0,
    sourceDataRead: false,
  });
}

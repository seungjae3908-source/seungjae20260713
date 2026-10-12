/** Read an atomically published V3 snapshot without accepting a torn rename.
 * One bounded retry avoids a transient 503 during a legitimate publication;
 * old cached contents are never returned when file identity changes.
 * No producer launch, outbound calls or trading authority.
 */
import { readFile, stat } from 'node:fs/promises';

export const V3_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

export function sameV3SnapshotStat(left, right) {
  return left?.mtimeMs === right?.mtimeMs
    && left?.ctimeMs === right?.ctimeMs
    && left?.ino === right?.ino
    && left?.size === right?.size;
}

export async function readV3StableSnapshot(file, {
  fileStat = stat, fileRead = readFile, cached = null,
} = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before;
    try {
      before = await fileStat(file);
    } catch (error) {
      // The producer can atomically publish the first state while a reader
      // checks it. Retry just once, never serve the prior cache as fallback.
      if (error?.code === 'ENOENT' && attempt === 0) continue;
      throw error;
    }
    if (!before || typeof before.isFile !== 'function' || !before.isFile())
      throw new Error('SNAPSHOT_NOT_A_FILE');
    if (!Number.isSafeInteger(before.size)
      || before.size < 1 || before.size > V3_SNAPSHOT_MAX_BYTES)
      throw new Error('SNAPSHOT_SIZE_OUT_OF_BOUNDS');
    if (cached?.snapshot && sameV3SnapshotStat(cached, before))
      return { cached: true, metadata: before, content: null };

    let content;
    try {
      content = await fileRead(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' && attempt === 0) continue;
      throw error;
    }
    let after;
    try {
      after = await fileStat(file);
    } catch (error) {
      if (error?.code === 'ENOENT' && attempt === 0) continue;
      throw error;
    }
    if (!sameV3SnapshotStat(before, after) || !after.isFile()) continue;
    return { cached: false, metadata: after, content };
  }
  throw new Error('SNAPSHOT_FILE_CHANGED_DURING_READ');
}

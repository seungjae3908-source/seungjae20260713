import path from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const DEFAULT_LIVE_ENTRY_ARM_PATH =
  '/opt/stock-app/.deploy/auto-trading-live-entry-arm.json';

export function liveAutoAuthorityRequested() {
  return process.env.MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED === 'true'
    && process.env.AUTO_TRADING === 'true'
    && process.env.LIVE_AUTOMATIC_TRADING_ENABLED === 'true'
    && process.env.LIVE_TRADING === 'true'
    && process.env.REAL_ORDER_ENABLED === 'true'
    && process.env.PRIVATE_TRADING_API_ALLOWED === 'true';
}

// Reusable exact-deployed-SHA arm guard. Keep worker and execution in sync.
export async function liveEntryArmPresent(nowMs = Date.now()) {
  if (!liveAutoAuthorityRequested()) return false;
  const targetSha = String(process.env.DEPLOY_SHA ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(targetSha)) return false;
  const configured = process.env.MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH?.trim()
    || DEFAULT_LIVE_ENTRY_ARM_PATH;
  if (!path.isAbsolute(configured)) return false;
  let handle;
  try {
    handle = await open(path.resolve(configured), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || (stat.mode & 0o077)) return false;
    const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
    const armedAtMs = Date.parse(String(value.armedAt ?? ''));
    const activateNotBeforeMs = Date.parse(String(value.activateNotBeforeAt ?? ''));
    return value.schemaVersion === 'member-auto-trading-live-entry-arm-v1'
      && value.armed === true
      && String(value.targetSha ?? '').toLowerCase() === targetSha
      && Number.isFinite(armedAtMs)
      && Number.isFinite(activateNotBeforeMs)
      && activateNotBeforeMs >= armedAtMs
      && nowMs >= activateNotBeforeMs;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}


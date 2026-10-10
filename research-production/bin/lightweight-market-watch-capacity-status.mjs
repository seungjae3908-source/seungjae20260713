#!/usr/bin/env node
// Offline/read-only Research storage forecast; no scheduler, HTTP, trading,
// credentials, uploads, backup mutation, retention deletion or service start.
import { isAbsolute, resolve } from 'node:path';
import { WATCH_CAPACITY_CONTRACT } from '../src/lightweight-market-watch-capacity.mjs';
import { readWatchStorageCapacity } from '../src/lightweight-market-watch-capacity-readback.mjs';

async function main() {
  if (process.argv.length !== 2)
    throw new Error('WATCH_CAPACITY_ARGS_INVALID');
  const root = process.env.RESEARCH_STATE_ROOT ?? '';
  const sha = process.env.RESEARCH_CODE_SHA ?? '';
  if (!root || root === '/' || !isAbsolute(root) || resolve(root) !== root
    || !/^[a-f0-9]{40}$/u.test(sha))
    throw new Error('WATCH_CAPACITY_CONFIGURATION_INVALID');
  const report = await readWatchStorageCapacity(root);
  // The SHA is a configured diagnostic label, not independent checkout proof.
  process.stdout.write(JSON.stringify({
    ...report, configuredResearchSha: sha,
    exactReleaseAttested: false, privateApiAccessed: false,
    realOrders: 0, paperOrders: 0,
  }) + '\n');
}
main().catch(() => {
  // Suppress real fs errors and paths, including malformed filenames.
  process.stdout.write(JSON.stringify({
    contract: WATCH_CAPACITY_CONTRACT,
    status: 'INVALID', fileCount: null, datedDayCount: null,
    totalTrackedBytes: null, lastSevenCompletedDaysAverageBytes: null,
    diskFreeBytes: null,
    projectedDaysAboveFloor: null,
    categoryMetadataComplete: false, sourceDataRead: false,
    exactReleaseAttested: false, privateApiAccessed: false,
    retentionApplied: false, archiveVerified: false, deletionAllowed: false,
    continuous24hProven: false, profitabilityProven: false,
    realOrders: 0, paperOrders: 0, executionAuthority: 'NONE',
    errorCodes: ['WATCH_CAPACITY_READ_FAILED'],
  }) + '\n');
  process.exitCode = 2;
});

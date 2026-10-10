#!/usr/bin/env node
// One-day READ ONLY deduplicated public-ticker research cohort diagnostic.
// No timer, HTTP, credentials, Formula PASS, Paper/Live orders, or data writes.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createPublicWatchCohort, parseWatchCohortDay,
  addPublicWatchDiscovery, addPublicWatchOutcome,
  summarizePublicWatchCohort, WATCH_COHORT_MAX_ROWS,
} from '../src/lightweight-market-watch-cohort.mjs';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const DAY_MS = 86_400_000;
function inputDay() {
  const args = process.argv.slice(2);
  if (args.length === 0) return new Date().toISOString().slice(0,10);
  if (args.length !== 1 || !/^--day=\d{4}-\d{2}-\d{2}$/u.test(args[0]))
    throw new Error('WATCH_COHORT_DAY_ARGUMENT_INVALID');
  return args[0].slice(6);
}
async function readLog(root, category, dayUtc, accumulator, ingest) {
  const filename = join(root, 'watch', category, dayUtc + '.jsonl');
  let before;
  try { before = await lstat(filename); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('WATCH_COHORT_INPUT_UNREADABLE');
  }
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0
    || before.size > MAX_FILE_BYTES || (before.mode & 0o022) !== 0)
    throw new Error('WATCH_COHORT_FILE_UNSAFE');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const beforeOpen = await handle.stat();
    if (beforeOpen.ino !== before.ino || beforeOpen.dev !== before.dev
      || beforeOpen.size !== before.size || !beforeOpen.isFile()
      || beforeOpen.nlink !== 1 || (beforeOpen.mode & 0o022) !== 0)
      throw new Error('WATCH_COHORT_INPUT_CHANGED');
    const stream = handle.createReadStream({
      autoClose:false, encoding:'utf8', highWaterMark:64 * 1024,
    });
    const rows = createInterface({ input:stream, crlfDelay:Infinity });
    let seen = 0;
    let completed = false;
    try {
      for await (const line of rows) {
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES
          || ++seen > WATCH_COHORT_MAX_ROWS)
          throw new Error('WATCH_COHORT_INPUT_LIMIT');
        if (!line.trim()) throw new Error('WATCH_COHORT_EMPTY_JSONL_LINE');
        let v;
        try { v = JSON.parse(line); }
        catch { throw new Error('WATCH_COHORT_BROKEN_JSONL'); }
        ingest(accumulator, v);
      }
      completed = true;
    } finally {
      rows.close();
      // Destroying a FileHandle stream after a normal EOF can close its fd
      // even with autoClose:false (EBADF on the post-read integrity check).
      // Force destruction only when the stream stopped abnormally.
      if (!completed) stream.destroy();
    }
    const after = await handle.stat();
    if (after.ino !== before.ino || after.dev !== before.dev
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('WATCH_COHORT_INPUT_MUTATED_DURING_READ');
    accumulator.fileCount++;
  } finally {
    await handle.close();
  }
}
async function main() {
  const rawRoot = process.env.RESEARCH_STATE_ROOT ?? '';
  const sha = process.env.RESEARCH_CODE_SHA ?? '';
  if (!rawRoot || !isAbsolute(rawRoot) || resolve(rawRoot) !== rawRoot)
    throw new Error('WATCH_COHORT_ROOT_INVALID');
  const dayUtc = inputDay();
  const start = parseWatchCohortDay(dayUtc);
  const cohort = createPublicWatchCohort({ dayUtc, researchSha:sha });
  const nextDay = new Date(start + DAY_MS).toISOString().slice(0,10);
  await readLog(rawRoot, 'events', dayUtc, cohort, addPublicWatchDiscovery);
  await readLog(rawRoot, 'outcomes', dayUtc, cohort, addPublicWatchOutcome);
  await readLog(rawRoot, 'outcomes', nextDay, cohort, addPublicWatchOutcome);
  const result = summarizePublicWatchCohort(cohort);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'INVALID') process.exitCode = 2;
}
main().catch((error) => {
  // Only fixed-code identifiers are disclosed, never a provider value or path.
  const diagnostic = typeof error?.message === 'string'
    && /^WATCH_COHORT_[A-Z0-9_]{3,60}$/u.test(error.message)
    ? error.message : 'WATCH_COHORT_READ_FAILED';
  process.stdout.write(JSON.stringify({
    contract:'public-watch-cohort-diagnostic-v1', status:'INVALID',
    discoveryCount:null, observedCoarseCount:null, blockedDataCount:null,
    missingOutcomeCount:null, errorCodes:[diagnostic],
    economicEvidenceCredit:0, oosCredit:0, paperCredit:0,
    fullCostReady:false, profitabilityProven:false,
    continuous24hProven:false, formulaCandidateProduced:false,
    isTradingSignal:false, executionAuthority:'NONE',
  }) + '\n');
  process.exitCode = 2;
});

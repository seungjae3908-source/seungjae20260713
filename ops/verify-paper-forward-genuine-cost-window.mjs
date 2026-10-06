import { readFileSync } from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve(
  'api-server/src/services/public-forward-partial-fill-v3-cohort-freeze.service.ts',
);
const source = readFileSync(sourcePath, 'utf8');

function exactNumber(name) {
  const match = new RegExp(`\\b${name}:\\s*([0-9_]+)`, 'u').exec(source);
  if (!match) throw new Error(`PAPER_FORWARD_COHORT_${name.toUpperCase()}_MISSING`);
  const value = Number(match[1].replaceAll('_', ''));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PAPER_FORWARD_COHORT_${name.toUpperCase()}_INVALID`);
  }
  return value;
}

const nowArg = process.argv.find((value) => value.startsWith('--now-ms='));
const nowMs = nowArg ? Number(nowArg.slice('--now-ms='.length)) : Date.now();
if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('PAPER_FORWARD_NOW_MS_INVALID');

const splitStarts = [...source.matchAll(/startInclusiveMs:\s*([0-9_]+)/gu)]
  .map((match) => Number(match[1].replaceAll('_', '')));
const validationStartMs = splitStarts[1];
const oosStartMs = splitStarts[2];
const endExclusiveMs = exactNumber('endExclusiveMs');
if (splitStarts.length !== 3
  || !Number.isSafeInteger(validationStartMs)
  || !Number.isSafeInteger(oosStartMs)
  || !(splitStarts[0] < validationStartMs
    && validationStartMs < oosStartMs
    && oosStartMs < endExclusiveMs)) {
  throw new Error('PAPER_FORWARD_COHORT_WINDOW_CONTRACT_INVALID');
}

const iso = (value) => new Date(value).toISOString();
if (nowMs < oosStartMs) {
  const phase = nowMs < validationStartMs ? 'TRAIN' : 'VALIDATION';
  throw new Error(
    `PAPER_FORWARD_GENUINE_COST_WINDOW_NOT_ELIGIBLE:${phase}:OOS_START=${iso(oosStartMs)}:COHORT_END=${iso(endExclusiveMs)}`,
  );
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  phase: nowMs < endExclusiveMs ? 'OOS_COLLECTING' : 'COHORT_COMPLETE',
  oosStart: iso(oosStartMs),
  cohortEnd: iso(endExclusiveMs),
  actualCostEvidenceStillRequired: true,
  inventedCostAllowed: false,
  executionAuthority: 'NONE',
})}\n`);

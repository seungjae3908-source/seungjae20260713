// @ts-nocheck
// Inspect the exact preceding public-only Scanner cycle. Running another
// 20-symbol Yahoo/Upbit probe immediately after the cycle exhausts provider
// quotas and adds avoidable HTTP 429s; no new network calls belong here.
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { inspectExactPublicProviderCycle } from '../src/public-provider-cycle-diagnostics.mjs';

const expectedSha = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA ?? '').trim().toLowerCase();
const file = String(process.env.SIGNAL_INTELLIGENCE_STATE_FILE ?? '').trim();
if (!file || !isAbsolute(file) || resolve(file) !== file)
  throw new Error('PUBLIC_CYCLE_DIAGNOSTIC_STATE_PATH_REQUIRED');

const content = await readFile(file, 'utf8');
if (Buffer.byteLength(content,'utf8') > 512_000)
  throw new Error('PUBLIC_CYCLE_DIAGNOSTIC_OVERSIZE');
const cycle = JSON.parse(content);
const result = inspectExactPublicProviderCycle(cycle, expectedSha);
console.log(JSON.stringify(result, null, 2));

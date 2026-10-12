#!/usr/bin/env node
import process from 'node:process';
import { processFormulaAutoBacktestQueueV1 } from '../src/formula-auto-backtest-queue-v1.js';

const stateRoot = String(process.env.FORMULA_BACKTEST_STATE_ROOT ?? '').trim();
if (!stateRoot) {
  console.error('FORMULA_BACKTEST_STATE_ROOT_REQUIRED');
  process.exit(1);
}
const researchCodeSha = String(process.env.RESEARCH_CODE_SHA ?? '').trim().toLowerCase();
if (!/^[0-9a-f]{40}$/u.test(researchCodeSha)) {
  console.error('RESEARCH_CODE_SHA_REQUIRED');
  process.exit(1);
}
try {
  const summary = await processFormulaAutoBacktestQueueV1({ stateRoot, researchCodeSha });
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (summary.automationReadiness.startsWith('BLOCKED_DATA_')) {
    // Isolated forward timer treats exit 2 as blocked evidence, not an outage.
    process.exitCode = 2;
  }
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exit(1);
}

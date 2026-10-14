#!/usr/bin/env node
import { resolve } from 'node:path';

import { runAutonomousResearchClosedLoopV1 } from '../src/autonomous-research-closed-loop-v1.mjs';

function positiveBounded(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error('AUTONOMOUS_RESEARCH_CYCLE_LIMIT_INVALID');
  }
  return parsed;
}

try {
  const result = await runAutonomousResearchClosedLoopV1({
    stateRoot: resolve(process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production'),
    researchCodeSha: process.env.RESEARCH_CODE_SHA ?? process.env.GITHUB_SHA ?? '',
    maximumStrategiesPerCycle: positiveBounded(process.env.RESEARCH_AUTONOMOUS_MAX_STRATEGIES_PER_CYCLE, 4),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'FAILED_CLOSED',
    reason: String(error?.message ?? error).slice(0, 180),
    liveTrading: false,
    privateTradingApi: false,
    realOrder: false,
    executionAuthority: 'NONE',
  })}\n`);
  process.exitCode = 1;
}

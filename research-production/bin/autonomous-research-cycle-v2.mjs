#!/usr/bin/env node
import { resolve } from 'node:path';

import { runAutonomousResearchCycleV2 } from '../src/autonomous-research-cycle-v2.mjs';

function parse(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

try {
  const options = parse(process.argv);
  const result = await runAutonomousResearchCycleV2({
    stateRoot: resolve(options['state-root'] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production'),
    researchCodeSha: options['research-sha'] ?? process.env.RESEARCH_CODE_SHA ?? process.env.GITHUB_SHA ?? '',
    maximumStrategiesPerCycle: Number(options['maximum-strategies'] ?? process.env.RESEARCH_AUTONOMOUS_MAX_STRATEGIES_PER_CYCLE ?? 4),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // Missing configuration is an observed, durable state. The existing AI
  // review command that follows in the same service returns its own temporary
  // failure code, so the unit cannot be reported as a successful AI cycle.
  if (result.status === 'PARTIAL_AI_DISCOVERY_UNAVAILABLE') process.exitCode = 75;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'failed_closed', error: String(error?.message ?? error).slice(0, 240),
    runtimeActivated: false, executionAuthority: 'NONE', liveTrading: false,
    privateTradingApi: false, realOrder: false,
  }, null, 2)}\n`);
  process.exitCode = 1;
}

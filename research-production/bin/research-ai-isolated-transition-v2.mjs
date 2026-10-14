#!/usr/bin/env node
import { resolve } from 'node:path';

import { runResearchAiIsolatedTransitionV2 } from '../src/research-ai-isolated-transition-v2.mjs';

function parse(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || !value || value.startsWith('--')) throw new Error('ISOLATED_TRANSITION_ARGUMENT_INVALID');
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

try {
  const options = parse(process.argv);
  const result = await runResearchAiIsolatedTransitionV2({
    sourceStateRoot: resolve(options['source-state-root'] ?? '/var/lib/investment-research-production'),
    isolatedStateRoot: resolve(options['isolated-state-root'] ?? ''),
    repoRoot: resolve(options['repo-root'] ?? process.cwd()),
    researchSha: options['research-sha'] ?? '',
    providerEnvPath: resolve(options['provider-env'] ?? '/etc/investment-research/research-providers.env'),
    aiPolicyEnvPath: resolve(options['ai-policy-env'] ?? '/etc/investment-research/research-ai.env'),
    videoPolicyEnvPath: resolve(options['video-policy-env'] ?? '/etc/investment-research/research-video.env'),
    maximumCycles: Number(options.cycles ?? 1),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 'research-ai-isolated-transition-v2',
    status: 'FAILED_CLOSED',
    reason: String(error?.message ?? error ?? 'ISOLATED_TRANSITION_FAILED').replace(/[\r\n]/gu, '_').slice(0, 240),
    productionStateMutated: false,
    providerSecretValuesExposed: false,
    liveTrading: false,
    privateTradingApiAllowed: false,
    realOrderEnabled: false,
    executionAuthority: 'NONE',
  }, null, 2)}\n`);
  process.exitCode = 1;
}

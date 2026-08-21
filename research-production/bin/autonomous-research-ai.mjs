#!/usr/bin/env node
import process from 'node:process';

import {
  preflightAutonomousResearchAi,
  probeAutonomousResearchAi,
  runAutonomousResearchAiPilot,
} from '../src/autonomous-research-ai-runtime.mjs';

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = next;
    index += 1;
  }
  return { mode: positional[0] ?? 'preflight', options };
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function main() {
  const { mode, options } = parseArgs(process.argv.slice(2));
  const repoRoot = required(options['repo-root'] ?? process.env.RESEARCH_REPO_ROOT, 'RESEARCH_REPO_ROOT');
  const stateRoot = required(options['state-root'] ?? process.env.RESEARCH_STATE_ROOT, 'RESEARCH_STATE_ROOT');
  const researchSha = required(options['research-sha'] ?? process.env.RESEARCH_CODE_SHA, 'RESEARCH_CODE_SHA');
  const common = { repoRoot, stateRoot, researchSha, env: process.env };

  let result;
  if (mode === 'preflight') {
    result = (await preflightAutonomousResearchAi(common)).result;
  } else if (mode === 'probe') {
    result = (await probeAutonomousResearchAi(common)).result;
  } else if (mode === 'pilot') {
    result = await runAutonomousResearchAiPilot(common);
  } else {
    throw new Error('usage: autonomous-research-ai.mjs {preflight|probe|pilot} [--repo-root PATH] [--state-root PATH] [--research-sha SHA]');
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 300);
  process.stderr.write(`AUTONOMOUS_RESEARCH_AI_FAILED=${message}\n`);
  process.exitCode = 1;
});

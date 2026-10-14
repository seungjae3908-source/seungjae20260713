#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { evaluateResearchAiOperationalTransitionV2 } from '../src/research-ai-operational-transition-v2.mjs';

function parse(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || !value || value.startsWith('--')) throw new Error('RESEARCH_OPERATIONAL_ARGUMENT_INVALID');
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

const options = parse(process.argv);
const stateRoot = resolve(options['state-root'] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
const targetSha = options['research-sha'] ?? process.env.RESEARCH_CODE_SHA ?? '';
const startedAtMs = Number(options['started-at-ms']);
const [autonomousCycle, autonomousDiscovery, longHistory, video] = await Promise.all([
  optionalJson(join(stateRoot, 'latest', 'autonomous-research-cycle-v2.json')),
  optionalJson(join(stateRoot, 'latest', 'autonomous-research-discovery-v2.json')),
  optionalJson(join(stateRoot, 'latest', 'long-history.json')),
  optionalJson(join(stateRoot, 'video-research', 'latest.json')),
]);
const result = evaluateResearchAiOperationalTransitionV2({
  targetSha,
  startedAtMs,
  autonomousCycle,
  autonomousDiscovery,
  longHistory,
  video,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

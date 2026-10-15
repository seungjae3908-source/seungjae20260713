#!/usr/bin/env node
// Prints the latest combination-research summary in plain Korean.
// Read-only: it only reads latest/combination-research-v1.json.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { formatCombinationReportKoV1 } from '../src/combination-search-lane-v1.mjs';

const root = resolve(process.argv[2] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
try {
  const result = JSON.parse(await readFile(join(root, 'latest', 'combination-research-v1.json'), 'utf8'));
  process.stdout.write(`${formatCombinationReportKoV1(result)}\n`);
} catch (error) {
  if (error?.code === 'ENOENT') process.stdout.write('아직 조합 연구 결과가 없습니다. (10분 주기 실행 후 생깁니다)\n');
  else throw error;
}

#!/usr/bin/env node
// Prints the latest exit-strategy comparison in plain Korean.
// Read-only: it only reads latest/exit-strategy-comparison-v1.json.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { formatExitComparisonReportKoV1 } from '../src/exit-strategy-comparison-v1.mjs';

const root = resolve(process.argv[2] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
try {
  const result = JSON.parse(await readFile(join(root, 'latest', 'exit-strategy-comparison-v1.json'), 'utf8'));
  process.stdout.write(`${formatExitComparisonReportKoV1(result)}\n`);
} catch (error) {
  if (error?.code === 'ENOENT') process.stdout.write('아직 청산 방식 비교 결과가 없습니다. (10분 주기 연구 실행 후 생깁니다)\n');
  else throw error;
}

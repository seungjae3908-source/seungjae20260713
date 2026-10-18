#!/usr/bin/env node
// Prints the latest Alpha158-style stock factor scan in plain Korean.
// Read-only: it only reads latest/alpha158-factor-scan-v1.json.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { formatAlpha158ReportKoV1 } from '../src/alpha158-factor-scan-v1.mjs';

const root = resolve(process.argv[2] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
try {
  const result = JSON.parse(await readFile(join(root, 'latest', 'alpha158-factor-scan-v1.json'), 'utf8'));
  process.stdout.write(`${formatAlpha158ReportKoV1(result)}\n`);
} catch (error) {
  if (error?.code === 'ENOENT') process.stdout.write('아직 주식 팩터 탐색 결과가 없습니다. (연구 주기 실행 후 생깁니다)\n');
  else throw error;
}

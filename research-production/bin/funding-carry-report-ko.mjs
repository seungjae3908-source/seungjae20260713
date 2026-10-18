#!/usr/bin/env node
// Prints the latest funding-carry backtest in plain Korean. Read-only.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { formatFundingCarryReportKoV1 } from '../src/funding-carry-backtest-v1.mjs';

const root = resolve(process.argv[2] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
try {
  process.stdout.write(`${formatFundingCarryReportKoV1(JSON.parse(await readFile(join(root, 'latest', 'funding-carry-backtest-v1.json'), 'utf8')))}\n`);
} catch (error) {
  if (error?.code === 'ENOENT') process.stdout.write('아직 펀딩비 차익 계산 결과가 없습니다. (연구 주기 실행 후 생깁니다)\n');
  else throw error;
}

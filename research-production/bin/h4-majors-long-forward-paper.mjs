#!/usr/bin/env node
// Forward paper report for H4_MAJORS_LONG (Korean). Research only.
//   node research-production/bin/h4-majors-long-forward-paper.mjs --fetch <dir>
//       fetches public Bitget 1h candles of the majors (warm-up + forward window) first
//   node research-production/bin/h4-majors-long-forward-paper.mjs [stateRoot]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { FORWARD_PAPER_START_MS } from '../src/extended-exit-backtest-v1.mjs';
import { formatH4MajorsForwardKoV1, runH4MajorsForwardPaperV1 } from '../src/h4-majors-long-forward-paper-v1.mjs';
import { LONG_SHORT_FLIP_MAJORS_V2 } from '../src/long-short-flip-backtest-v2.mjs';

const DAY = 86_400_000;
const args = process.argv.slice(2);
let root;
if (args[0] === '--fetch') {
  root = resolve(args[1] ?? 'h4-majors-state');
  const dir = join(root, 'h4-majors-forward', 'candles');
  await mkdir(dir, { recursive: true });
  const endTime = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 1;
  // 60 days of 4h warm-up (EMA50, 48-bar breakout) before the unseen forward window.
  const startTime = FORWARD_PAPER_START_MS - (60 * DAY);
  for (const symbol of LONG_SHORT_FLIP_MAJORS_V2) {
    try {
      const history = await collectBitgetCandles({ client: new BitgetPublicClient({ fetchImpl: globalThis.fetch }), market: 'CRYPTO_FUTURES',
        symbol, timeframe: '1h', startTime, endTime, maxCandles: 20_000, productType: 'usdt-futures' });
      await writeFile(join(dir, `${symbol}.json`), JSON.stringify({ symbol, candles: history.candles }));
      process.stderr.write(`FETCHED:${symbol}:${history.candles.length}\n`);
    } catch (error) {
      process.stderr.write(`FETCH_FAILED:${symbol}:${String(error?.message ?? error).slice(0, 160)}\n`);
    }
  }
} else {
  root = resolve(args[0] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
}
const result = await runH4MajorsForwardPaperV1({ stateRoot: root });
process.stdout.write(`${formatH4MajorsForwardKoV1(result)}\n`);

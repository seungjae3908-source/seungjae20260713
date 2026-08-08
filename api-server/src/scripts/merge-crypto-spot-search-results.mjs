import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const channelPath = process.env.CHANNEL_SEARCH_INPUT;
const enginePath = process.env.ENGINE_SEARCH_INPUT;
const outputPath = process.env.BACKTEST_OUTPUT;
if (!channelPath || !enginePath || !outputPath) throw new Error('SEARCH_RESULT_PATH_REQUIRED');

const channel = JSON.parse(await readFile(channelPath, 'utf8'));
const engine = JSON.parse(await readFile(enginePath, 'utf8'));
for (const result of [channel, engine]) {
  if (result.mode !== 'backtest-only' || result.orderSubmitted !== false) {
    throw new Error('NO_ORDER_CONTRACT_VIOLATION');
  }
}

const eligible = [];
for (const item of channel.results ?? []) {
  if (item.automationEligible === true) {
    eligible.push({ source: 'channel-search', strategyFamily: channel.strategyFamily, symbol: item.symbol, result: item });
  }
}
if (engine.automationEligible === true) {
  eligible.push({ source: 'engine-family-search', strategyFamily: engine.selectedCandidate?.family, symbol: 'LIQUID_UNIVERSE', result: engine });
}

const payload = {
  ok: true,
  mode: 'backtest-only',
  orderSubmitted: false,
  generatedAt: new Date().toISOString(),
  automaticFamilyIteration: true,
  evaluatedSearches: [
    { name: 'channel-search', strategyFamily: channel.strategyFamily, candidateCount: channel.candidateCountPerSymbol },
    { name: 'engine-family-search', strategyFamilies: engine.strategyFamilies, candidateCount: engine.candidateCount },
  ],
  automationEligible: eligible.length > 0,
  eligible,
  channel,
  engine,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ automationEligible: payload.automationEligible, eligibleCount: eligible.length }));

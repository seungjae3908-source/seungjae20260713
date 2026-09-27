import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path){
  return await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

test('Scanner S/A quality gate requires complete OOS walk-forward cost and bias guards', async()=>{
  const ranking=await source('api-server/src/services/scanner-candidate-ranking.service.ts');
  for(const contract of [
    /summary\.status\s*!==\s*'verified'/u,
    /summary\.expectancyPercent\s*>\s*0/u,
    /summary\.profitFactor\s*>=\s*1\.05/u,
    /summary\.costsIncluded\s*===\s*true/u,
    /summary\.slippageIncluded\s*===\s*true/u,
    /summary\.lookaheadGuarded\s*===\s*true/u,
    /summary\.survivorshipGuarded\s*===\s*true/u,
    /summary\.oos\s*===\s*true/u,
    /summary\.walkForward\s*===\s*true/u,
  ]) assert.match(ranking,contract);
});

test('legacy API backtest engine cannot masquerade as four-market Scanner quality owner', async()=>{
  const engine=await source('api-server/src/services/backtest-engine.service.ts');
  assert.match(engine,/market:\s*'crypto-futures'/u);
  assert.match(engine,/maximumDurationMs:\s*366\s*\*/u);
  assert.match(engine,/request\.market\s*!==\s*'crypto-futures'/u);
});

test('multi-market engine is a building block but does not itself mint Scanner OOS WF survivorship claims', async()=>{
  const engine=await source('market-prediction-lab/src/multi-market-backtest-engine.js');
  assert.match(engine,/import\s*\{\s*MARKETS\s*\}/u);
  assert.match(engine,/finalHoldoutLocked/u);
  assert.match(engine,/costsIncluded:\s*true/u);
  assert.doesNotMatch(engine,/survivorshipGuarded/u);
  assert.doesNotMatch(engine,/walkForward/u);
  assert.doesNotMatch(engine,/\boos\s*:/iu);
});

test('canonical split and stock universe owners remain separate evidence owners', async()=>{
  const walk=await source('market-prediction-lab/src/walk-forward.js');
  const bias=await source('market-prediction-lab/src/stock-universe-bias-audit.js');
  assert.match(walk,/export function walkForwardSplit/u);
  assert.match(walk,/purgedBetweenTrainValidation/u);
  assert.match(walk,/purgedBetweenValidationTest/u);
  assert.match(bias,/point_in_time_bias_gate_passed/u);
  assert.match(bias,/removed_name_history_coverage_below_gate/u);
  assert.match(bias,/currentConstituentListAloneCannotPass:\s*true/u);
});

test('Strategy Promotion source registry still marks Prediction Lab linkage as unlinked', async()=>{
  const promotion=await source('api-server/src/services/strategy-promotion.service.ts');
  assert.match(
    promotion,
    /id:\s*'PREDICTION_LAB'[\s\S]*?status:\s*'UNLINKED'/u,
  );
});

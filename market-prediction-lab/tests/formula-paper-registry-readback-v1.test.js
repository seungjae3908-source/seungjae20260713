import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compiledMomentumFormula } from './research-bundle-formula-fixture.js';
import {
  FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1,
  buildFormulaPaperStrategyRegistryV1,
} from '../src/formula-auto-backtest-queue-v1.js';
import {
  FORMULA_PAPER_REGISTRY_READBACK_CONTRACT_V1,
  readFormulaPaperRegistryReadbackV1,
} from '../src/formula-paper-registry-readback-v1.js';

const SHA = 'a'.repeat(40);

async function fixture(registry) {
  const root = await mkdtemp(join(tmpdir(), 'formula-paper-readback-'));
  const latest = join(root, 'latest');
  await mkdir(latest, { recursive: true, mode: 0o700 });
  const registryPath = join(latest, 'formula-paper-strategy-registry.json');
  await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
  return { root, registryPath };
}

function emptyRegistry() {
  return buildFormulaPaperStrategyRegistryV1([], { researchCodeSha: SHA });
}

function validOneRegistry() {
  const { formula } = compiledMomentumFormula();
  const generatedCandidate = {
    generatedCandidateId: 'generated-paper-pass-v1',
    formulaCandidateId: formula.candidateId,
    formulaHash: formula.formulaHash,
    parameterIdentity: 'b'.repeat(64),
    selectedParameters: Object.fromEntries(formula.parameterSpace.map(p => [p.name, p.min])),
    safety: { executionAuthority: 'NONE' },
  };
  const survivor = {
    formulaCandidate: formula,
    generatedCandidate,
    formulaCandidateId: formula.candidateId,
    generatedCandidateId: generatedCandidate.generatedCandidateId,
    parameterIdentity: generatedCandidate.parameterIdentity,
    strategyHash: formula.formulaHash,
    strategyFamily: formula.strategyFamily,
    market: formula.market,
    timeframe: formula.timeframe,
    direction: formula.direction,
    researchSurvivor: true,
    failure: null,
    tradingAuthority: false,
    safety: { executionAuthority: 'NONE' },
  };
  return buildFormulaPaperStrategyRegistryV1([{
    state: 'PASS',
    itemDigest: 'd'.repeat(64),
    tournament: { candidates: [survivor] },
    evaluatedAt: new Date().toISOString(),
  }], { researchCodeSha: SHA });
}

function mustNotAdmit(readback) {
  assert.equal(readback.contract, FORMULA_PAPER_REGISTRY_READBACK_CONTRACT_V1);
  assert.equal(readback.executionAuthority, 'NONE');
  assert.equal(readback.paperDispatchAllowed, false);
  assert.equal(readback.realOrder, false);
  assert.equal(readback.liveTrading, false);
  assert.equal(readback.autoTrading, false);
  assert.equal(readback.privateTradingApi, false);
  assert.equal(readback.futureSignalVerified, false);
  assert.equal(readback.canonicalPaperAdmissionVerified, false);
  assert.equal(readback.fullCostReady, false);
  assert.equal(readback.profitabilityProven, false);
  assert.equal(readback.orderCount, 0);
  assert.equal(JSON.stringify(readback).includes('formulaCandidate'), false);
  assert.equal(JSON.stringify(readback).includes('/tmp/'), false);
}

test('absent and empty PASS registry report truth without inventing Paper readiness', async () => {
  const absent = await readFormulaPaperRegistryReadbackV1({ researchCodeSha: SHA });
  assert.equal(absent.status, 'MISSING');
  assert.equal(absent.entryCount, null);
  mustNotAdmit(absent);
  const { root, registryPath } = await fixture(emptyRegistry());
  try {
    const empty = await readFormulaPaperRegistryReadbackV1({ registryPath, researchCodeSha: SHA });
    assert.equal(empty.status, 'EMPTY');
    assert.equal(empty.entryCount, 0);
    mustNotAdmit(empty);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real PASS registry is read-only and still awaits future signal + canonical Paper admission', async () => {
  const registry = validOneRegistry();
  assert.equal(registry.contract, FORMULA_PAPER_STRATEGY_REGISTRY_CONTRACT_V1);
  assert.equal(registry.entryCount, 1);
  const { root, registryPath } = await fixture(registry);
  try {
    const before = await readFile(registryPath, 'utf8');
    const result = await readFormulaPaperRegistryReadbackV1({ registryPath, researchCodeSha: SHA });
    const after = await readFile(registryPath, 'utf8');
    assert.equal(result.status, 'WAITING_FUTURE_SIGNAL');
    assert.equal(result.sourceShaExact, true);
    assert.equal(result.entryCount, 1);
    assert.equal(after, before);
    mustNotAdmit(result);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid registry SHA, permission and forged candidate admission cannot become Paper signals', async () => {
  const registry = validOneRegistry();
  const { root, registryPath } = await fixture(registry);
  try {
    const wrong = await readFormulaPaperRegistryReadbackV1({ registryPath, researchCodeSha: 'b'.repeat(40) });
    assert.equal(wrong.status, 'INVALID');
    mustNotAdmit(wrong);
    const broken = [
      { ...registry, entries: [{ ...registry.entries[0], futureSignalRequired: false }] },
      { ...registry, entries: [{ ...registry.entries[0], registryId: 'e'.repeat(64) }] },
      { ...registry, realOrder: true },
      { ...registry, entries: [...registry.entries, registry.entries[0]], entryCount: 2 },
      { ...registry, executionAuthority: 'LIVE' },
    ];
    for (const record of broken) {
      await writeFile(registryPath, JSON.stringify(record), { mode: 0o600 });
      const out = await readFormulaPaperRegistryReadbackV1({ registryPath, researchCodeSha: SHA });
      assert.equal(out.status, 'INVALID');
      assert.equal(out.entryCount, null);
      mustNotAdmit(out);
    }
    await writeFile(registryPath, JSON.stringify(registry));
    await chmod(registryPath, 0o644);
    const worldReadable = await readFormulaPaperRegistryReadbackV1({ registryPath, researchCodeSha: SHA });
    assert.equal(worldReadable.status, 'INVALID');
    mustNotAdmit(worldReadable);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('symlink and malformed path are explicitly blocked without following private files', async () => {
  const { root, registryPath } = await fixture(emptyRegistry());
  try {
    const dir = join(root, 'alias');
    await mkdir(dir);
    const symlinkPath = join(dir, 'formula-paper-strategy-registry.json');
    await symlink(registryPath, symlinkPath);
    const result = await readFormulaPaperRegistryReadbackV1({ registryPath: symlinkPath, researchCodeSha: SHA });
    assert.equal(result.status, 'INVALID');
    mustNotAdmit(result);
    const relative = await readFormulaPaperRegistryReadbackV1({
      registryPath: 'formula-paper-strategy-registry.json',
      researchCodeSha: SHA,
    });
    assert.equal(relative.status, 'INVALID');
    mustNotAdmit(relative);
  } finally { await rm(root, { recursive: true, force: true }); }
});

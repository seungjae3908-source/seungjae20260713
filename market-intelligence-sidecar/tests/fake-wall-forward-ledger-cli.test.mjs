import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const researchSha = '1'.repeat(40);
const detectedAt = 1_800_000_000_000;
const scriptPath = fileURLToPath(new URL('../scripts/run-fake-wall-forward-ledger.mjs', import.meta.url));

const candidate = {
  contract: 'market-intelligence-spoof-candidate/v1',
  mode: 'OBSERVE_ONLY',
  state: 'CANDIDATE',
  direction: 'BULLISH_SUPPORT',
  evidenceScore: 88,
  evidence: { wallSide: 'ask', wallPrice: 101, cancellationRatio: 0.95 },
  confounders: [],
  missingEvidence: [],
  scannerHardBlockAllowed: false,
  parentGateImpact: 'NONE',
  orderAllowed: false,
  executionAuthority: 'NONE',
};

function naturalEvent(overrides = {}) {
  return {
    serviceSha: researchSha,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    venue: 'BITGET',
    detectedAt,
    referencePrice: 100,
    candidate,
    provenance: { provider: 'Bitget', privateApiUsed: false },
    freshness: { state: 'fresh' },
    qualityFlags: [],
    ...overrides,
  };
}

function runCli(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `CLI failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('CLI restores predecessor artifact and settles matured horizon from natural cadence events', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fake-wall-ledger-cli-'));
  try {
    const firstDir = path.join(root, 'first');
    const secondDir = path.join(root, 'second');
    const firstEventsFile = path.join(root, 'first-events.json');
    const secondEventsFile = path.join(root, 'second-events.json');
    writeFileSync(firstEventsFile, JSON.stringify([naturalEvent()]));

    const firstStats = runCli([
      '--research-sha', researchSha,
      '--output-dir', firstDir,
      '--candidate-events-input', firstEventsFile,
      '--now', String(detectedAt + 60_000),
    ]);
    assert.equal(firstStats.added, 1);
    assert.equal(firstStats.pending, 1);

    const firstState = readJson(path.join(firstDir, 'state.json'));
    const firstSummary = readJson(path.join(firstDir, 'summary.json'));
    const firstManifest = readJson(path.join(firstDir, 'manifest.json'));
    assert.equal(firstState.observations[0].status, 'PENDING');
    assert.equal(firstState.observations[0].candidateEventId, firstState.observations[0].candidateId);
    assert.equal(firstState.observations[0].serviceSha, researchSha);
    assert.match(firstState.observations[0].evidenceSnapshotDigest, /^[0-9a-f]{64}$/u);
    assert.deepEqual(firstState.observations[0].horizons.map((item) => item.status), ['PENDING', 'PENDING', 'PENDING']);
    assert.equal(firstSummary.profitabilityMetrics, 'N/A');
    assert.match(firstManifest.artifactContentDigest, /^[0-9a-f]{64}$/u);

    writeFileSync(secondEventsFile, JSON.stringify([naturalEvent({
      detectedAt: detectedAt + 5 * 60_000 + 10_000,
      referencePrice: 103,
      candidate: { ...candidate, state: 'NO_CANDIDATE' },
    })]));

    const secondStats = runCli([
      '--research-sha', researchSha,
      '--output-dir', secondDir,
      '--state-input', path.join(firstDir, 'state.json'),
      '--summary-input', path.join(firstDir, 'summary.json'),
      '--manifest-input', path.join(firstDir, 'manifest.json'),
      '--candidate-events-input', secondEventsFile,
      '--predecessor-run-id', '12345',
      '--predecessor-artifact-id', '67890',
      '--now', String(detectedAt + 5 * 60_000 + 30_000),
    ]);
    assert.equal(secondStats.added, 0);
    assert.equal(secondStats.pending, 1);

    const secondState = readJson(path.join(secondDir, 'state.json'));
    const secondSummary = readJson(path.join(secondDir, 'summary.json'));
    const secondManifest = readJson(path.join(secondDir, 'manifest.json'));
    const [h5, h15, h60] = secondState.observations[0].horizons;
    assert.equal(secondState.observations[0].candidateId, firstState.observations[0].candidateId);
    assert.equal(secondState.observations[0].status, 'PARTIALLY_SETTLED');
    assert.equal(h5.status, 'SETTLED');
    assert.equal(Math.round(h5.returnBps), 300);
    assert.equal(h15.status, 'PENDING');
    assert.equal(h60.status, 'PENDING');
    assert.equal(secondSummary.profitabilityMetrics, 'N/A');
    assert.equal(secondManifest.predecessorRunId, '12345');
    assert.equal(secondManifest.predecessorArtifactId, '67890');
    assert.equal(secondManifest.predecessorArtifactDigest, firstManifest.artifactContentDigest);
    assert.notEqual(secondManifest.artifactContentDigest, firstManifest.artifactContentDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

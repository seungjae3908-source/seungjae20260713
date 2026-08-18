import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  advanceLedger,
  buildArtifactBundle,
  verifyPredecessorBundle,
} from '../src/fake-wall-forward-ledger.mjs';
import { buildFakeWallNaturalLedgerBatch } from '../src/fake-wall-forward-natural-input.mjs';

function argsOf(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    out[key] = value;
    index += 1;
  }
  return out;
}

function readJson(file, fallback) {
  if (!file) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

const args = argsOf(process.argv.slice(2));
const researchCodeSha = String(args['research-sha'] ?? '').toLowerCase();
const outputDir = args['output-dir'];
if (!outputDir) throw new Error('--output-dir required');
if (args['observations-input'] && args['candidate-events-input']) {
  throw new Error('AMBIGUOUS_FAKE_WALL_OBSERVATION_INPUT');
}

let observations = readJson(args['observations-input'], []);
let marks = readJson(args['marks-input'], []);
if (args['candidate-events-input']) {
  const naturalEvents = readJson(args['candidate-events-input'], []);
  const natural = buildFakeWallNaturalLedgerBatch(naturalEvents, { researchCodeSha });
  observations = natural.observations;
  marks = [...natural.marks, ...marks];
}

const previousState = readJson(args['state-input'], null);
const previousManifest = readJson(args['manifest-input'], null);
const previousSummary = readJson(args['summary-input'], null);
if (previousState || previousManifest || previousSummary) {
  if (!(previousState && previousManifest && previousSummary)) throw new Error('PREDECESSOR_BUNDLE_INCOMPLETE');
  verifyPredecessorBundle({ manifest: previousManifest, state: previousState, summary: previousSummary, researchCodeSha });
}
const now = args.now ?? Date.now();
const { state, stats } = advanceLedger({ previousState, researchCodeSha, observations, marks, now });
const bundle = buildArtifactBundle(state, {
  predecessorRunId: args['predecessor-run-id'] ?? null,
  predecessorArtifactId: args['predecessor-artifact-id'] ?? null,
  predecessorArtifactDigest: args['predecessor-artifact-digest'] ?? previousManifest?.artifactContentDigest ?? null,
  harnessSha: args['harness-sha'] ?? null,
});
mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(outputDir, 'state.json'), bundle.stateText);
writeFileSync(path.join(outputDir, 'summary.json'), bundle.summaryText);
writeFileSync(path.join(outputDir, 'manifest.json'), bundle.manifestText);
process.stdout.write(`${JSON.stringify({ ...stats, artifactContentDigest: bundle.manifest.artifactContentDigest })}\n`);

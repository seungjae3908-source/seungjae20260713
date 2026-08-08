import { readFileSync } from 'node:fs';

const shadowPath = '.github/workflows/prediction-lab-shadow-hourly.yml';
const adaptivePath = '.github/workflows/prediction-lab-adaptive-candidate.yml';
const shadow = readFileSync(shadowPath, 'utf8');
const adaptive = readFileSync(adaptivePath, 'utf8');

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing required contract: ${needle}`);
}

function forbid(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`${label}: forbidden contract matched: ${pattern}`);
}

for (const [label, source] of [['shadow', shadow], ['adaptive', adaptive]]) {
  requireText(source, 'actions: read', label);
  requireText(source, 'contents: read', label);
  requireText(source, 'persist-credentials: false', label);
  requireText(source, 'actions/upload-artifact@v4', label);
  requireText(source, 'retention-days: 90', label);
  requireText(source, 'branchWrite: false', label);
  requireText(source, 'liveOrderAllowed: false', label);
  requireText(source, 'privateAccountRequestAllowed: false', label);
  requireText(source, 'sourceGeneratedHead:', label);
  requireText(source, 'previousStateDigest:', label);
  requireText(source, 'predecessorArtifactId:', label);
  requireText(source, 'sha256:', label);
  forbid(source, /contents:\s*write/, label);
  forbid(source, /actions:\s*write/, label);
  forbid(source, /git\s+(?:push|commit)\b/, label);
  forbid(source, /createWorkflowDispatch/, label);
  forbid(source, /\|\|\s*true/, label);
}

requireText(shadow, 'SHADOW_BRANCH: feature/prediction-lab-standalone', 'shadow');
requireText(shadow, 'path: ${{ runner.temp }}/previous-shadow', 'shadow');
requireText(shadow, 'Refusing artifact cutover from an empty branch shadow state.', 'shadow');
requireText(shadow, 'Refusing to restart from an empty predecessor shadow state.', 'shadow');
requireText(shadow, 'Predecessor shadow combined SHA-256 mismatch.', 'shadow');
requireText(shadow, 'const ledgerRecordCount = (value) => {', 'shadow');
requireText(shadow, "for (const key of ['records', 'ledger', 'entries', 'predictions'])", 'shadow');
requireText(shadow, "if (value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups))", 'shadow');
requireText(shadow, 'count += Object.values(value.groups).reduce((sum, group) => sum + ledgerRecordCount(group), 0);', 'shadow');
requireText(shadow, 'const nonEmptyLedger = (value) => ledgerRecordCount(value) > 0;', 'shadow');
forbid(shadow, /Object\.keys\(value\)\.length\s*>\s*0/, 'shadow');
requireText(shadow, 'predecessorRunId:', 'shadow');
requireText(shadow, 'predecessorResearchCodeSha:', 'shadow');
requireText(shadow, 'candidateModelIds,', 'shadow');
requireText(shadow, 'referenceModelIds,', 'shadow');

requireText(adaptive, 'workflow_run:', 'adaptive');
if (/^\s*schedule:/m.test(adaptive)) throw new Error('adaptive: schedule must not race the exact shadow workflow_run chain');
requireText(adaptive, "workflows:\n      - Prediction Lab Hourly Shadow Validation", 'adaptive');
requireText(adaptive, 'path: ${{ runner.temp }}/shadow-input', 'adaptive');
requireText(adaptive, 'run-id: ${{ steps.shadow.outputs.run_id }}', 'adaptive');
requireText(adaptive, 'No successful, unexpired shadow artifact is available.', 'adaptive');
requireText(adaptive, 'Shadow combined SHA-256 mismatch.', 'adaptive');
requireText(adaptive, 'candidateModelIds,', 'adaptive');
requireText(adaptive, 'referenceModelIds,', 'adaptive');

console.log('Prediction Lab writer contract: PASS');

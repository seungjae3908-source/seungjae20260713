import { readFile, writeFile } from 'node:fs/promises';
import { markAttemptReceiptValidationFailure } from '../src/public-forward-liquidity-v3-scheduled-capture-seam.mjs';

const outputDir = String(process.env.OUTPUT_DIR ?? 'public-forward-liquidity-v3-scheduled-capture').trim();
const blocker = String(process.env.INVALIDATION_BLOCKER ?? 'DEFAULT_BRANCH_MOVED_DURING_CAPTURE').trim();
const receipt = JSON.parse(await readFile(`${outputDir}/attempt-receipt.json`, 'utf8'));
const invalidated = markAttemptReceiptValidationFailure(receipt, blocker);
await writeFile(`${outputDir}/attempt-receipt.json`, `${JSON.stringify(invalidated, null, 2)}\n`, 'utf8');
const outcome = JSON.parse(await readFile(`${outputDir}/capture-outcome.json`, 'utf8'));
outcome.captureStatus = 'VALIDATION_FAILURE';
outcome.prospectiveCaptureCredit = 0;
outcome.workflowFailure = true;
outcome.blockers = [...new Set([...(outcome.blockers ?? []), blocker])].sort();
await writeFile(`${outputDir}/capture-outcome.json`, `${JSON.stringify(outcome, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ captureStatus: invalidated.captureStatus, receiptDigest: invalidated.receiptDigest, blocker }));

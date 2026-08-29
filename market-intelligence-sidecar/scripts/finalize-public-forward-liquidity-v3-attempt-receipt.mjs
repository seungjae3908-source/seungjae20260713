import { readFile, writeFile } from 'node:fs/promises';
import { bindAttemptReceiptArtifact } from '../src/public-forward-liquidity-v3-scheduled-capture-seam.mjs';

const outputDir = String(process.env.OUTPUT_DIR ?? 'public-forward-liquidity-v3-scheduled-capture').trim();
const receipt = JSON.parse(await readFile(`${outputDir}/attempt-receipt.json`, 'utf8'));
const finalized = bindAttemptReceiptArtifact(receipt, {
  artifactId: process.env.ARTIFACT_ID,
  artifactDigest: process.env.ARTIFACT_DIGEST,
  artifactName: process.env.ARTIFACT_NAME,
});
await writeFile(`${outputDir}/artifact-bound-attempt-receipt.json`, `${JSON.stringify(finalized, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ artifactId: finalized.artifactId, artifactDigest: finalized.artifactDigest, receiptDigest: finalized.receiptDigest }));

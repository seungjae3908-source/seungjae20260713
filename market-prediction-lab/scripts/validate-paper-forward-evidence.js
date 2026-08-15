import {
  createCanonicalPaperForwardEvidenceProvider,
  validateCanonicalPaperForwardEvidence,
} from "../src/paper-forward-evidence-runtime-v1.js";

const report = await validateCanonicalPaperForwardEvidence({
  provider: createCanonicalPaperForwardEvidenceProvider(),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ready) process.exitCode = 2;

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runPreHoldoutProfitabilityGate } from "../src/pre-holdout-profitability-gate-v1.js";

const [researchCodeSha, momentumCsvPath, sixPortfolioCsvPath] = process.argv.slice(2);
if (!researchCodeSha || !momentumCsvPath || !sixPortfolioCsvPath) {
  throw new Error("usage: node scripts/run-pre-holdout-profitability-gate-v1.js <research-code-sha> <momentum-csv> <six-portfolio-csv>");
}

const result = runPreHoldoutProfitabilityGate({
  researchCodeSha,
  momentumCsvText: fs.readFileSync(path.resolve(momentumCsvPath), "utf8"),
  sixPortfolioCsvText: fs.readFileSync(path.resolve(sixPortfolioCsvPath), "utf8"),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

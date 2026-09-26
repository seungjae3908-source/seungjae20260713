import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runFirstRealGlobalReplication } from "../src/first-real-global-replication-v1.js";

const [researchCodeSha, momentumCsvPath, sixPortfolioCsvPath] = process.argv.slice(2);
if (!researchCodeSha || !momentumCsvPath || !sixPortfolioCsvPath) {
  throw new Error("usage: node scripts/run-first-real-global-research-batch-v1.js <research-code-sha> <momentum-csv> <six-portfolio-csv>");
}

const result = runFirstRealGlobalReplication({
  researchCodeSha,
  momentumCsvText: fs.readFileSync(path.resolve(momentumCsvPath), "utf8"),
  sixPortfolioCsvText: fs.readFileSync(path.resolve(sixPortfolioCsvPath), "utf8"),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);


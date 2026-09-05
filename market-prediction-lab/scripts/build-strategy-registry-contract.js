import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildStrategyRegistryContract } from "../src/strategy-registry.js";

const outputPath = resolve(process.argv[2] ?? "artifacts/automated-research/strategy-registry-contract.json");
const researchCodeSha = process.env.RESEARCH_CODE_SHA ?? null;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be immutable 40-character SHA");
const artifact = Object.freeze({
  ...buildStrategyRegistryContract({ researchCodeSha }),
  krProviderStatus: "BLOCKED_REQUIRES_PROVIDER_CREDENTIAL",
  usProviderStatus: "BLOCKED_REQUIRES_PROVIDER_CREDENTIAL",
  bitgetLongFundingStatus: "BLOCKED_PROVIDER_COVERAGE",
  binanceLiveTailStatus: "BLOCKED_EXTERNAL_BINANCE_REST_GITHUB_RUNNER_LOCATION",
  spotV1Disposition: "research_hold_rejected_candidate_family_not_rescued_by_threshold_relaxation",
  candidateFreezeAllowed: false,
  finalHoldoutQueueAllowed: false,
  finalHoldoutStatus: "LOCKED_NOT_EVALUATED",
  topStrategy: "NONE",
  syntheticDataUsedAsReal: false,
  productionChanged: false,
  privateApiUsed: false,
  ordersSubmitted: 0,
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ groups: artifact.groups.length, finalHoldoutStatus: artifact.finalHoldoutStatus, topStrategy: artifact.topStrategy, privateApiUsed: false, ordersSubmitted: 0 }));

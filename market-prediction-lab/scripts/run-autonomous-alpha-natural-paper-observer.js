#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  buildAutonomousAlphaNaturalPaperObservationV1,
} from "../src/autonomous-alpha-natural-paper-runtime-bridge-v1.js";
import {
  readPaperForwardScheduleSnapshot,
} from "../src/paper-forward-schedule-runtime-v1.js";

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const FORBIDDEN = [
  "LIVE_TRADING",
  "LIVE_TRADING_ENABLED",
  "AUTO_TRADING",
  "REAL_ORDER_ENABLED",
  "PRIVATE_API_ENABLED",
  "PRIVATE_ACCOUNT_ACCESS",
  "PRIVATE_TRADING_API_ALLOWED",
  "ORDER_AUTHORITY",
];

function truthy(value) {
  return TRUTHY.has(String(value ?? "").trim().toLowerCase());
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function main(env = process.env) {
  if (!truthy(env.AUTONOMOUS_ALPHA_OBSERVER_ACTIVE)) {
    throw new Error("AUTONOMOUS_ALPHA_OBSERVER_NOT_ACTIVE");
  }
  const unsafe = FORBIDDEN.filter((key) => truthy(env[key]));
  if (unsafe.length > 0) {
    throw new Error(`AUTONOMOUS_ALPHA_OBSERVER_UNSAFE_FLAGS:${unsafe.join(",")}`);
  }

  const root = String(env.PAPER_FORWARD_ROOT ?? "").trim();
  const researchCodeSha = String(env.PAPER_FORWARD_RESEARCH_SHA ?? "").trim().toLowerCase();
  if (!root || !isAbsolute(root)) throw new Error("PAPER_FORWARD_ROOT_ABSOLUTE_REQUIRED");
  if (!/^[0-9a-f]{40}$/u.test(researchCodeSha)) {
    throw new Error("PAPER_FORWARD_RESEARCH_SHA_REQUIRED");
  }

  const alphaRoot = join(root, "autonomous-alpha");
  const handoffPath = String(
    env.AUTONOMOUS_ALPHA_HANDOFF_PATH ?? join(alphaRoot, "handoff-v1.json"),
  ).trim();
  if (!isAbsolute(handoffPath)) throw new Error("AUTONOMOUS_ALPHA_HANDOFF_PATH_ABSOLUTE_REQUIRED");

  const [paperSnapshot, alphaHandoff] = await Promise.all([
    readPaperForwardScheduleSnapshot(root),
    readJsonOrNull(handoffPath),
  ]);
  const observation = buildAutonomousAlphaNaturalPaperObservationV1({
    paperSnapshot,
    alphaHandoff,
    researchCodeSha,
    observedAtMs: Date.now(),
  });

  await mkdir(alphaRoot, { recursive: true, mode: 0o700 });
  await atomicJson(join(alphaRoot, "observer-latest.json"), observation);
  await appendFile(
    join(alphaRoot, "observer-history.jsonl"),
    `${JSON.stringify(observation)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(observation)}\n`);

  if (observation.status === "BLOCKED_DATA"
      || observation.status === "ALPHA_HANDOFF_REJECTED_BY_LINEAGE_FIREWALL") {
    process.exitCode = 1;
  } else if (observation.status === "WAITING_FOR_ALPHA_HANDOFF") {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "failed_closed",
    error: String(error?.message ?? error),
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  })}\n`);
  process.exitCode = 1;
});

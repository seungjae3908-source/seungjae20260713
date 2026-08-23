#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  inspectPaperForwardReadonlyRuntime,
  PAPER_FORWARD_CANONICAL_STATE_ROOT,
} from "../src/paper-forward-readonly-diagnostic-v1.js";

function readCrontab() {
  try {
    return {
      readable: true,
      text: execFileSync("crontab", ["-l"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      }),
    };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (error?.status === 1 && /no crontab/iu.test(stderr)) {
      return { readable: true, text: "" };
    }
    return { readable: false, text: "" };
  }
}

const crontab = readCrontab();
const result = inspectPaperForwardReadonlyRuntime({
  stateRoot: PAPER_FORWARD_CANONICAL_STATE_ROOT,
  crontabText: crontab.text,
  crontabReadable: crontab.readable,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

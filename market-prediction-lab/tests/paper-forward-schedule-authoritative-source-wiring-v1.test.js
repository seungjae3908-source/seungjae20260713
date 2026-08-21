import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPaperForwardScheduleCli } from "../scripts/run-paper-forward-schedule.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("Research Production recurring CLI injects the audited authoritative source-wiring provider by default", async () => {
  const sourceWiring = Object.freeze({ marker: "concrete-source-owner-input" });
  const publicEvidenceProvider = Object.freeze({
    collectPublicEvidence: async () => Object.freeze({ status: "BLOCKED_DATA" }),
  });
  let dependenciesInput = null;
  let invocation = null;

  await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-source-wiring-${process.pid}-${Date.now()}`),
  }), {
    authoritativePaperSourceWiring: sourceWiring,
    authoritativePaperDependenciesFactory: (input) => {
      dependenciesInput = input;
      return Object.freeze({ publicEvidenceProvider });
    },
    runScheduledInvocation: async (input) => {
      invocation = input;
      return Object.freeze({
        status: "READY",
        cycleId: null,
        mutationCount: 0,
        invocation: Object.freeze({
          naturalScheduleInvocation: true,
          publicForwardEvidenceAccumulating: false,
          paperTradeOutcomeAccumulationEnabled: true,
          paperTradeOutcomeAccumulating: false,
        }),
        persistedStatus: Object.freeze({ simulatedFinancialAdaptersEnabled: true }),
      });
    },
  });

  assert.equal(dependenciesInput.sourceWiring, sourceWiring);
  assert.equal(dependenciesInput.providerOptions.env.RESEARCH_PRODUCTION, "true");
  assert.equal(invocation.publicEvidenceProvider, publicEvidenceProvider);
  assert.equal(invocation.outcomeAccumulationEnabled, true);
});

test("Research Production recurring CLI does not double-wrap an explicitly injected canonical runtime", async () => {
  const paperRuntimeForMarket = async () => Object.freeze({ status: "VALID_NO_TRADE" });
  let invocation = null;

  await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-runtime-wiring-${process.pid}-${Date.now()}`),
  }), {
    meaningfulSearchPaperRuntimeForMarket: paperRuntimeForMarket,
    runScheduledInvocation: async (input) => {
      invocation = input;
      return Object.freeze({ status: "READY", mutationCount: 0 });
    },
  });

  assert.equal(typeof invocation.publicEvidenceProvider?.collectPublicEvidence, "function");
});

test("Research Production recurring CLI constructs a fail-closed authoritative provider when no callback owner is installed", async () => {
  let invocation = null;
  await runPaperForwardScheduleCli(Object.freeze({
    PAPER_FORWARD_SCHEDULE_ACTIVE: "true",
    RESEARCH_PRODUCTION: "true",
    PAPER_FORWARD_RESEARCH_SHA: SHA,
    PAPER_FORWARD_ACTIVATION_AT_MS: "1",
    PAPER_FORWARD_ROOT: join(tmpdir(), `paper-forward-missing-sources-${process.pid}-${Date.now()}`),
  }), {
    runScheduledInvocation: async (input) => {
      invocation = input;
      return Object.freeze({ status: "READY", mutationCount: 0 });
    },
  });

  assert.equal(typeof invocation.publicEvidenceProvider?.collectPublicEvidence, "function");
  assert.equal(invocation.outcomeAccumulationEnabled, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTHORITATIVE_PAPER_EVIDENCE_SOURCE_OWNERSHIP } from "../src/authoritative-paper-evidence-source-ownership-v1.js";
import {
  createPaperStateSourceFromLosslessSnapshotFile,
  loadValidatedAuthoritativePaperRuntimePackage,
} from "../src/authoritative-paper-runtime-package-v1.js";

function paperState(nowMs) {
  const at = new Date(nowMs - 1_000).toISOString();
  return {
    schemaVersion: 1,
    account: {
      id: "paper_account_contract_fixture",
      initialBalance: 10_000,
      cashBalance: 10_000,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equity: 10_000,
      usedMargin: 0,
      availableMargin: 10_000,
      createdAt: at,
      updatedAt: at,
    },
    orders: [],
    positions: [],
    fills: [],
    journal: [],
    riskState: {
      dayKey: at.slice(0, 10),
      weekKey: "2026-W34",
      dailyRealizedPnl: 0,
      weeklyRealizedPnl: 0,
      consecutiveLosses: 0,
    },
    processedEventIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

function missingEvidenceSources() {
  const missing = async () => null;
  return {
    paperCandidateSource: missing,
    learningSnapshotSource: missing,
    paperStateSource: missing,
    contractRulesSource: missing,
    publicEvidenceSource: missing,
    executionObservationSource: missing,
    supplementalCostEvidenceSource: missing,
  };
}

test("validated package loads exact #546 producer bundle and executes fail-closed without evidence", async () => {
  const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
  assert.equal(runtimePackage.sourceSha, "3f85003368830fb570c05b3b2060da39f515696d");
  assert.match(runtimePackage.sourceGraphSha256, /^[0-9a-f]{64}$/u);
  assert.match(runtimePackage.bundleSha256, /^[0-9a-f]{64}$/u);
  assert.equal(runtimePackage.admissionBundleSchemaVersion, "scanner-paper-admission-evidence-bundle-v1");
  assert.equal(runtimePackage.costPolicyVersion, null);
  assert.equal(runtimePackage.costPolicyVersionBinding.status, "RUNTIME_EXACT_REQUIRED");
  assert.equal(runtimePackage.executionAuthority, "NONE");
  assert.equal(runtimePackage.privateApiAllowed, false);
  assert.equal(runtimePackage.liveTrading, false);
  assert.equal(runtimePackage.scheduleActivationAuthority, false);
  assert.equal(runtimePackage.financialMutationAllowed, false);
  assert.equal(typeof runtimePackage.createAuthoritativePaperEvidenceSourceWiring, "function");

  const producer = runtimePackage.createPaperAdmissionEvidenceProducer(missingEvidenceSources());
  const result = await producer({ card: {}, market: "CRYPTO_FUTURES" });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.blockers, ["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING"]);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.productionMutationAllowed, false);
});

test("validated package connects existing Scanner and public Bitget owners without adding execution authority", async () => {
  const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
  const requests = [];
  const card = { signalId: "signal-1", symbol: "ETHUSDT", direction: "LONG", signalGrade: "A" };
  const response = {
    cards: [card],
    market: "BITGET_USDT_FUTURES",
    universe: { totalCount: 1, nextCursor: null },
    execution: {},
  };
  const wiring = runtimePackage.createAuthoritativePaperEvidenceSourceWiring({
    researchCodeSha: "a".repeat(40),
    dependencies: {
      scan: async (request) => {
        requests.push(request);
        return response;
      },
      align: async (_market, value) => value,
      rank: ({ cards }) => ({
        cards,
        diagnostics: {
          hardFilterPassCount: 1,
          hardFilterRejectedCount: 0,
          softCandidateCount: 1,
          backtestMissingCount: 0,
        },
      }),
      withCanonicalActions: (value) => value,
      attachCanonicalIdentity: ({ response: value }) => value,
      buildPublicRequests: () => ({
        ticker: { method: "GET", path: "/api/v2/mix/market/ticker", query: "symbol=ETHUSDT" },
      }),
      fetchPublicJson: async (url) => ({ url: String(url) }),
      buildPublicEvidence: (input) => ({
        provider: "bitget",
        symbol: input.symbol,
        observedAtMs: input.nowMs,
        dataQuality: "ready",
      }),
      now: () => 2_000,
    },
  });

  const scanBatch = await wiring.scanBatchForMarket({ market: "CRYPTO_FUTURES" });
  const scanned = await scanBatch({ market: "CRYPTO_FUTURES", cursor: 0 });
  assert.equal(scanned.cards[0].symbol, "ETHUSDT");
  assert.equal(requests[0].market, "futures");
  assert.equal(requests[0].strategyMode, "swing");
  assert.equal(requests[0].timeframe, "60m");
  assert.equal(requests[0].condition, "trend");
  assert.equal(requests[0].batchSize, 20);

  const evidence = await wiring.publicEvidenceForCard({ card, market: "CRYPTO_FUTURES" });
  assert.equal(evidence.provider, "bitget");
  assert.equal(evidence.symbol, "ETHUSDT");
  assert.equal(evidence.observedAtMs, 2_000);
  assert.equal(wiring.paperCandidateForCard({ card: {}, market: "CRYPTO_FUTURES" }), null);
});

test("lossless Paper state snapshot preserves the complete state and never supplies a default balance", async () => {
  const nowMs = Date.now();
  const runtimePackage = await loadValidatedAuthoritativePaperRuntimePackage();
  const state = paperState(nowMs);
  const snapshot = runtimePackage.createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: "CONTRACT_FIXTURE_ONLY",
    provenance: ["paper-trading-state-snapshot-contract-test"],
    observedAtMs: nowMs,
    maximumAgeMs: 30_000,
  });
  assert.deepEqual(snapshot.state, state);
  assert.equal(snapshot.equity, state.account.equity);
  assert.equal(snapshot.stateDigestSha256.length, 64);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.state.account), true);
  assert.throws(() => runtimePackage.createImmutablePaperTradingStateSnapshot({
    state: { ...state, account: { ...state.account, equity: null } },
    sourceOwner: "CONTRACT_FIXTURE_ONLY",
    provenance: ["paper-trading-state-snapshot-contract-test"],
    observedAtMs: nowMs,
  }), /PAPER_STATE|모의계좌/u);

  const root = await mkdtemp(join(tmpdir(), "paper-state-snapshot-contract-"));
  try {
    const path = join(root, "snapshot.json");
    await writeFile(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    const source = createPaperStateSourceFromLosslessSnapshotFile({
      snapshotPath: path,
      runtimePackage,
      now: () => nowMs + 1,
    });
    assert.deepEqual(await source(), state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence ownership map wires existing owners and keeps three missing owners explicit", () => {
  const contract = AUTHORITATIVE_PAPER_EVIDENCE_SOURCE_OWNERSHIP;
  assert.deepEqual(contract.callbacks.map((row) => row.callback), [
    "scanBatchForMarket",
    "paperCandidateForCard",
    "learningSnapshotForCard",
    "paperStateForCard",
    "contractRulesForCard",
    "publicEvidenceForCard",
    "executionObservationForCard",
    "supplementalCostEvidenceForCard",
  ]);
  const evidenceRows = contract.callbacks.slice(1);
  assert.equal(contract.callbacks.every((row) => typeof row.dataProvenance === "string" && row.dataProvenance.length > 0), true);
  assert.equal(evidenceRows.filter((row) => row.ownerStatus === "OWNER_EXISTS").length, 3);
  assert.equal(evidenceRows.filter((row) => row.ownerStatus === "OWNER_EXISTS_RUNTIME_UNAVAILABLE").length, 1);
  assert.equal(evidenceRows.filter((row) => row.ownerStatus === "OWNER_MISSING").length, 3);
  assert.equal(contract.sevenEvidenceOwnerSummary.callbacksWired, 3);
  assert.equal(contract.sevenEvidenceOwnerSummary.scannerCallbackWired, true);
  assert.equal(contract.sevenEvidenceOwnerSummary.scheduledCanonicalWriter, "OWNER_MISSING");
  assert.equal(contract.sevenEvidenceOwnerSummary.allOwnersReady, false);
  assert.equal(contract.executionAuthority, "NONE");
  assert.equal(contract.privateApiAllowed, false);
  assert.equal(contract.liveTrading, false);
  assert.equal(contract.scheduleActivationAuthority, false);
  assert.equal(contract.financialMutationAllowed, false);
});

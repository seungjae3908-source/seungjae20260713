import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeminiGroqResearchProviderMetadata,
  createGeminiGroqResearchBridge,
} from "../src/autonomous-research-free-ai-provider-bridge-v1.js";
import {
  createAutonomousResearchRuntimeState,
  executeDualFreeAiRuntime,
} from "../src/autonomous-research-runtime-v1.js";
import { createDualFreeAiReviewPlan } from "../src/autonomous-strategy-formula-generator-v1.js";

const EVIDENCE = "a".repeat(64);
const NOW = "2026-08-21T16:05:00+09:00";
const ENV = Object.freeze({
  GEMINI_API_KEY: "gemini-secret-value",
  GROQ_API_KEY: "groq-secret-value",
  RESEARCH_GEMINI_MODEL: "gemini-3.1-flash-lite",
  RESEARCH_GROQ_MODEL: "openai/gpt-oss-20b",
});

function reviewPayload(prompt) {
  const adversarial = prompt.includes("Assigned role: ADVERSARIAL_REVIEWER");
  return {
    conclusion: adversarial ? "REJECT_HYPOTHESIS" : "PROPOSE_DETERMINISTIC_TEST",
    mechanismOrChallenge: adversarial ? "Leakage and cost assumptions require rejection." : "Test a bounded lagged hypothesis only.",
    expectedRegime: "REQUIRES_DETERMINISTIC_TEST",
    findings: [adversarial ? "ADVERSARIAL_DISAGREEMENT" : "BOUNDED_HYPOTHESIS"],
    proposedBoundedVariants: [],
    deterministicResolution: "RUN_CANONICAL_QUEUE_226",
  };
}

function providerPrompt(url, init) {
  const body = JSON.parse(init.body);
  if (url.includes("generativelanguage.googleapis.com")) return body.contents[0].parts[0].text;
  return body.messages.at(-1).content;
}

function successResponse(url, init, override = null) {
  const prompt = providerPrompt(url, init);
  const payload = override ?? reviewPayload(prompt);
  if (url.includes("generativelanguage.googleapis.com")) {
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function planFor(bridge) {
  return createDualFreeAiReviewPlan({ evidenceFingerprint: EVIDENCE, providers: bridge.providers });
}

test("provider metadata reuses Gemini and Groq conventions without exposing credentials", () => {
  const providers = buildGeminiGroqResearchProviderMetadata({ env: ENV });
  assert.deepEqual(providers.map((provider) => provider.providerId), ["google-gemini", "groq"]);
  assert.deepEqual(providers.map((provider) => provider.state), ["AVAILABLE", "AVAILABLE"]);
  assert.deepEqual(providers.map((provider) => provider.billingTier), ["FREE", "FREE"]);
  const serialized = JSON.stringify(providers);
  assert.equal(serialized.includes(ENV.GEMINI_API_KEY), false);
  assert.equal(serialized.includes(ENV.GROQ_API_KEY), false);
  assert.equal(serialized.includes("apiKey"), false);
});

test("bridge drives the four-slot proposer/critic role reversal with two distinct FREE providers", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, prompt: providerPrompt(String(url), init) });
    return successResponse(String(url), init);
  };
  const bridge = createGeminiGroqResearchBridge({ env: ENV, fetchImpl, now: () => NOW });
  const plan = planFor(bridge);
  assert.equal(plan.status, "DUAL_FREE_AI_READY");

  const result = await executeDualFreeAiRuntime(createAutonomousResearchRuntimeState(), {
    plan,
    researchSourceId: "research-source:bridge-contract",
    researchRecord: { title: "Public metadata only", sourceFingerprint: EVIDENCE },
    analysis: { status: "RESEARCH_ONLY", paperGenome: { hypothesis: "bounded" } },
    calledAt: NOW,
  }, bridge.callFreeAiReviewProvider);

  assert.equal(result.calls.length, 4);
  assert.equal(result.reviews.length, 4);
  assert.equal(result.synthesis.status, "AI_REVIEW_CONFLICT");
  assert.equal(result.paidFallbackUsed, false);
  assert.deepEqual(new Set(result.calls.map((call) => call.provider)), new Set(["google-gemini", "groq"]));
  assert.equal(requests.filter((request) => request.url.includes("generativelanguage.googleapis.com")).length, 2);
  assert.equal(requests.filter((request) => request.url.includes("api.groq.com")).length, 2);
  assert.equal(requests.some((request) => request.url.includes(ENV.GEMINI_API_KEY)), false);
  assert.equal(requests.some((request) => request.prompt.includes(ENV.GEMINI_API_KEY) || request.prompt.includes(ENV.GROQ_API_KEY)), false);
  assert.equal(JSON.stringify(result.calls).includes(ENV.GEMINI_API_KEY), false);
  assert.equal(JSON.stringify(result.calls).includes(ENV.GROQ_API_KEY), false);
});

test("bridge rejects provider attempts to inject profitability or trading authority fields", async () => {
  const fetchImpl = async (url, init) => successResponse(String(url), init, {
    ...reviewPayload(providerPrompt(String(url), init)),
    pf: 2.4,
  });
  const bridge = createGeminiGroqResearchBridge({ env: ENV, fetchImpl, now: () => NOW });
  const plan = planFor(bridge);
  const slot = plan.slots[0];
  await assert.rejects(
    () => bridge.callFreeAiReviewProvider({ slot, plan, researchRecord: { title: "x" }, analysis: { status: "x" } }),
    /AI_REVIEW_EXTRA_FIELDS_FORBIDDEN/,
  );
});

test("provider probe distinguishes READY from RATE_LIMITED without paid fallback", async () => {
  const fetchImpl = async (url, init) => {
    if (String(url).includes("api.groq.com")) {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return successResponse(String(url), init, { status: "READY" });
  };
  const bridge = createGeminiGroqResearchBridge({ env: ENV, fetchImpl, now: () => NOW });
  const health = await bridge.probeFreeAiProviders();
  assert.equal(health.AI_PROVIDER_A_READY, "READY");
  assert.equal(health.AI_PROVIDER_B_READY, "RATE_LIMITED");
  assert.equal(health.AI_DUAL_REVIEW_READY, "RATE_LIMITED");
  assert.equal(health.FREE_PROVIDER_ONLY, true);
  assert.equal(health.PAID_FALLBACK, false);
  assert.equal(health.secretValuesExposed, false);
});

test("missing provider keys fail closed without making network calls", async () => {
  let calls = 0;
  const bridge = createGeminiGroqResearchBridge({
    env: {},
    fetchImpl: async () => { calls += 1; throw new Error("must not be called"); },
    now: () => NOW,
  });
  assert.deepEqual(bridge.providers.map((provider) => provider.state), ["UNAVAILABLE", "UNAVAILABLE"]);
  const health = await bridge.probeFreeAiProviders();
  assert.equal(health.AI_PROVIDER_A_READY, "UNAVAILABLE");
  assert.equal(health.AI_PROVIDER_B_READY, "UNAVAILABLE");
  assert.equal(health.AI_RESEARCH_STATUS, "AI_RESEARCH_UNAVAILABLE");
  assert.equal(calls, 0);
  const plan = planFor(bridge);
  assert.equal(plan.status, "AI_REVIEW_INCOMPLETE");
});

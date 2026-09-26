import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ResearchDualFreeAiError,
  runResearchDualFreeAiReview,
  type ResearchDualFreeAiInput,
} from './research-dual-free-ai.service';

const digest = 'a'.repeat(64);

function input(overrides: Partial<ResearchDualFreeAiInput> = {}): ResearchDualFreeAiInput {
  return {
    provider: 'gemini',
    role: 'PROPOSER',
    promptVersion: 'dual-free-ai-v1',
    evidenceDigest: digest,
    evidenceSummary: 'Public historical research batch. Regime mismatch and false-breakout observations are present; performance metrics are intentionally omitted.',
    ...overrides,
  };
}

function validAnswer(disposition = 'RESEARCH_PROPOSAL_ONLY'): string {
  return JSON.stringify({
    summary: 'The evidence supports a falsifiable structural research follow-up.',
    findings: ['Higher-timeframe context should be tested as a separate gate.', 'Liquidity context is missing and must remain explicit.'],
    hypotheses: [{
      hypothesisId: 'MTF-REGIME-GATE-A',
      thesis: 'Evaluate whether higher-timeframe regime alignment reduces repeated false-breakout failures without changing the frozen baseline identity.',
      requiredEvidence: ['Synchronized public higher-timeframe candles', 'Immutable baseline signal timestamps'],
      falsification: 'Reject if the effect does not persist across untouched folds and regime partitions.',
      intendedRegime: 'Trend transition and directional expansion regimes.',
      independenceRationale: 'Adds cross-timeframe state rather than another threshold on the baseline entry formula.',
    }],
    risks: ['Synchronized timestamps and point-in-time provenance are required.'],
    disposition,
  });
}

test('returns bounded research-only proposer output with deterministic authority', async () => {
  let calls = 0;
  const result = await runResearchDualFreeAiReview(input(), async (message) => {
    calls += 1;
    assert.match(message, /role=PROPOSER/);
    assert.match(message, new RegExp(`evidenceDigest=${digest}`));
    return { answer: validAnswer(), model: 'gemini-3.1-flash-lite' };
  });

  assert.equal(calls, 1);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.role, 'PROPOSER');
  assert.equal(result.model, 'gemini-3.1-flash-lite');
  assert.equal(result.evidenceDigest, digest);
  assert.equal(result.disposition, 'RESEARCH_PROPOSAL_ONLY');
  assert.equal(result.hypotheses[0]?.hypothesisId, 'MTF-REGIME-GATE-A');
  assert.deepEqual(result.authority, {
    researchProposalOnly: true,
    paidFallback: false,
    executionAuthority: 'NONE',
    orderAllowed: false,
    numericPerformanceAuthority: false,
  });
});

test('supports an independent critic role without changing deterministic authority', async () => {
  const result = await runResearchDualFreeAiReview(input({ provider: 'groq', role: 'CRITIC' }), async (message) => {
    assert.match(message, /role=CRITIC/);
    return { answer: validAnswer('NEEDS_REVIEW'), model: 'openai/gpt-oss-20b' };
  });

  assert.equal(result.provider, 'groq');
  assert.equal(result.role, 'CRITIC');
  assert.equal(result.disposition, 'NEEDS_REVIEW');
  assert.equal(result.authority.executionAuthority, 'NONE');
  assert.equal(result.authority.orderAllowed, false);
});

test('rejects malformed JSON and markdown wrappers fail-closed', async () => {
  for (const answer of ['not-json', '```json\n{}\n```', '{bad json}']) {
    await assert.rejects(
      runResearchDualFreeAiReview(input(), async () => ({ answer, model: 'gemini-3.1-flash-lite' })),
      (cause: unknown) => cause instanceof ResearchDualFreeAiError && cause.code === 'MALFORMED_AI_JSON',
    );
  }
});

test('rejects unsupported fields that could smuggle numeric or trading authority', async () => {
  const unsafeRows = [
    { ...JSON.parse(validAnswer()), PF: 1.8 },
    { ...JSON.parse(validAnswer()), executionAuthority: 'LIVE' },
    { ...JSON.parse(validAnswer()), orderAllowed: true },
  ];

  for (const row of unsafeRows) {
    await assert.rejects(
      runResearchDualFreeAiReview(input(), async () => ({ answer: JSON.stringify(row), model: 'gemini-3.1-flash-lite' })),
      (cause: unknown) => cause instanceof ResearchDualFreeAiError && cause.code === 'INVALID_AI_OUTPUT',
    );
  }
});

test('rejects performance claims and direct trading authority inside allowed text fields', async () => {
  const performanceClaim = JSON.parse(validAnswer());
  performanceClaim.summary = 'PF 1.8 proves the candidate is profitable.';
  await assert.rejects(
    runResearchDualFreeAiReview(input(), async () => ({ answer: JSON.stringify(performanceClaim), model: 'gemini-3.1-flash-lite' })),
    (cause: unknown) => cause instanceof ResearchDualFreeAiError && cause.code === 'FORBIDDEN_AI_AUTHORITY',
  );

  const tradeInstruction = JSON.parse(validAnswer());
  tradeInstruction.summary = 'BUY NOW based on this research proposal.';
  await assert.rejects(
    runResearchDualFreeAiReview(input(), async () => ({ answer: JSON.stringify(tradeInstruction), model: 'gemini-3.1-flash-lite' })),
    (cause: unknown) => cause instanceof ResearchDualFreeAiError && cause.code === 'FORBIDDEN_AI_AUTHORITY',
  );
});

test('blocks private or secret-bearing evidence before provider invocation', async () => {
  let calls = 0;
  await assert.rejects(
    runResearchDualFreeAiReview(input({ evidenceSummary: 'api_key=sk-secret-example-1234567890' }), async () => {
      calls += 1;
      return { answer: validAnswer(), model: 'gemini-3.1-flash-lite' };
    }),
    (cause: unknown) => cause instanceof ResearchDualFreeAiError && cause.code === 'PRIVATE_DATA_FORBIDDEN',
  );
  assert.equal(calls, 0);
});

test('rejects missing provenance identity before provider invocation', async () => {
  let calls = 0;
  await assert.rejects(
    runResearchDualFreeAiReview(input({ evidenceDigest: 'not-a-digest' }), async () => {
      calls += 1;
      return { answer: validAnswer(), model: 'gemini-3.1-flash-lite' };
    }),
    (cause: unknown) => cause instanceof ResearchDualFreeAiError && cause.code === 'INVALID_EVIDENCE_DIGEST',
  );
  assert.equal(calls, 0);
});

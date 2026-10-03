import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScannerSignalCard } from './scanner-signal.types';
import {
  applyScannerAiValidation,
  createScannerAiTransport,
  enforceScannerAiFinalPromotionPolicy,
  enrichTopScannerCandidatesWithAi,
  scannerAiRuntimeStatus,
} from './scanner-ai-runtime.service';

function card(
  signalId: string,
  score: number,
  grade: 'S' | 'A' | 'B' = 'A',
): ScannerSignalCard {
  return {
    signalId,
    symbol: signalId.toUpperCase(),
    assetClass: 'coin_spot',
    market: 'KRW',
    strategyMode: 'scalping',
    direction: 'LONG',
    score,
    confidence: score,
    riskScore: 20,
    signalGrade: grade,
    strongSignalEligible: grade !== 'B',
    signalState: 'WATCHING',
    dataQuality: { state: 'TRUSTED', score: 95, strongSignalAllowed: true, issues: [] },
    evidence: [{ key: 'test', label: '테스트 근거', status: 'matched', source: 'test', observedAt: new Date().toISOString(), reasons: ['근거 확인'] }],
    warnings: [],
    aiValidation: {
      status: 'NOT_RUN',
      provider: null,
      counterEvidence: [],
      missingData: [],
      risks: [],
      explanation: null,
    },
  } as unknown as ScannerSignalCard;
}

const configuredEnv: NodeJS.ProcessEnv = {
  AI_CHAT_PROVIDER: 'gemini',
  AI_CHAT_API_KEY: 'test-key',
  AI_CHAT_MODEL: 'gemini-test',
};

test('runtime status is safe and declares canonical bounded scanner wiring', () => {
  const off = scannerAiRuntimeStatus({});
  assert.equal(off.configured, false);
  assert.equal(off.providerSeam, 'BOUNDED_AI_JSON_PROVIDER');
  assert.equal(off.canonicalScannerWired, true);
  assert.equal(off.executionAuthority, 'NONE');
  assert.equal(off.orderAllowed, false);

  const on = scannerAiRuntimeStatus(configuredEnv);
  assert.equal(on.configured, true);
  assert.equal(on.providerSeam, 'BOUNDED_AI_JSON_PROVIDER');
  assert.equal(on.provider, 'google-gemini');
  assert.equal(on.model, 'gemini-test');
  assert.equal(on.maxCandidatesPerRequest, 2);
  assert.equal(on.vetoBlocksStrongSignal, true);
  assert.equal(on.schedulerCircuitOpen, false);
  assert.equal(on.schedulerPending, 0);
  assert.equal(on.schedulerActive, 0);
  assert.equal(on.providerFailures >= 0, true);
  assert.equal(JSON.stringify(on).includes('test-key'), false);
});

test('PASS preserves candidate while PARTIAL and VETO apply bounded caps', () => {
  const source = card('btc', 94, 'S');

  const pass = applyScannerAiValidation(source, {
    status: 'PASS', provider: 'gemini/test', counterEvidence: [], missingData: [], risks: [], explanation: 'ok',
  });
  assert.equal(pass.score, 94);
  assert.equal(pass.signalGrade, 'S');
  assert.equal(pass.strongSignalEligible, true);

  const partial = applyScannerAiValidation(source, {
    status: 'PARTIAL', provider: 'gemini/test', counterEvidence: [], missingData: ['missing catalyst'], risks: [], explanation: 'partial',
  });
  assert.equal(partial.score, 79);
  assert.equal(partial.signalGrade, 'A');
  assert.equal(partial.aiValidation?.status, 'PARTIAL');

  const veto = applyScannerAiValidation(source, {
    status: 'VETO', provider: 'gemini/test', counterEvidence: ['contradiction'], missingData: [], risks: ['event conflict'], explanation: 'veto',
  });
  assert.equal(veto.score, 49);
  assert.equal(veto.signalGrade, 'B');
  assert.equal(veto.strongSignalEligible, false);
  assert.equal(veto.signalState, 'WEAKENED');
});

test('only top strong trusted candidates are sent to AI even before backtest grade promotion', async () => {
  const calls: string[] = [];
  const validator = {
    async validate(input: any) {
      calls.push(input.signalId);
      return input.signalId === 's1'
        ? { status: 'VETO' as const, provider: 'test-ai', counterEvidence: ['conflict'], missingData: [], risks: [], explanation: 'veto' }
        : { status: 'PASS' as const, provider: 'test-ai', counterEvidence: [], missingData: [], risks: [], explanation: 'pass' };
    },
  };

  const result = await enrichTopScannerCandidatesWithAi(
    [card('s1', 95, 'A'), card('s2', 90, 'A'), card('s3', 85, 'A'), card('s4', 80, 'B')],
    { validator, env: configuredEnv, maxCandidates: 2 },
  );

  assert.deepEqual(calls, ['s1', 's2']);
  assert.equal(result[0].aiValidation?.status, 'VETO');
  assert.equal(result[0].strongSignalEligible, false);
  assert.equal(result[1].aiValidation?.status, 'PASS');
  assert.equal(result[2].aiValidation?.status, 'NOT_RUN');
  assert.equal(result[3].aiValidation?.status, 'NOT_RUN');
});

test('provider not configured performs zero validation calls and preserves scanner availability', async () => {
  let calls = 0;
  const validator = {
    async validate() {
      calls += 1;
      throw new Error('must not run');
    },
  };
  const result = await enrichTopScannerCandidatesWithAi(
    [card('s1', 95, 'S'), card('s2', 90, 'A')],
    { validator, env: {} },
  );
  assert.equal(calls, 0);
  assert.equal(result.every((row) => row.aiValidation?.status === 'NOT_RUN'), true);
  assert.equal(result[0].score, 95);
});


test('scanner provider prompt stays below shared AI chat truncation limit even with oversized evidence strings', async () => {
  let promptText = '';
  const transport = createScannerAiTransport(async (input) => {
    promptText = String(input.message ?? '');
    return {
      answer: JSON.stringify({
        status: 'PASS',
        counterEvidence: [],
        missingData: [],
        risks: [],
        explanation: 'bounded',
      }),
      kind: 'answer',
      model: 'gemini-test',
      provider: 'google-gemini',
      fallbackUsed: false,
      providerLatencyMs: 1,
      generatedAt: new Date().toISOString(),
      data: { status: 'not_requested', asOf: null, basis: 'server_collection_time', sources: [], missing: [] },
    };
  }, configuredEnv);

  const result = await transport({
    signalId: 'signal-long-prompt',
    symbol: 'BTC',
    market: 'coin_spot',
    strategy: 'scalping',
    direction: 'LONG',
    score: 91,
    riskScore: 20,
    dataQualityScore: 95,
    evidence: Array.from({ length: 24 }, (_, index) => 'evidence-' + index + '-' + 'x'.repeat(300)),
    warnings: Array.from({ length: 12 }, (_, index) => 'warning-' + index + '-' + 'y'.repeat(300)),
  }, new AbortController().signal);

  assert.equal(result.status, 'PASS');
  assert.ok(promptText.length > 0 && promptText.length <= 1_900);
  assert.ok(promptText.includes('"signalId":"signal-long-prompt"'));
});


test('final S-grade output is downgraded unless the candidate has explicit AI PASS', () => {
  const noAi = card('s-grade-no-ai', 95, 'S');
  const limited = enforceScannerAiFinalPromotionPolicy([noAi]);
  assert.equal(limited[0].signalGrade, 'A');
  assert.ok(limited[0].warnings.some((value) => value.includes('S등급은 외부 AI 공개근거 검토 PASS')));

  const passed = card('s-grade-pass', 95, 'S');
  passed.aiValidation = {
    status: 'PASS',
    provider: 'test-ai',
    counterEvidence: [],
    missingData: [],
    risks: [],
    explanation: 'passed',
  };
  const retained = enforceScannerAiFinalPromotionPolicy([passed]);
  assert.equal(retained[0].signalGrade, 'S');
});


test('AI input includes market identity and upstream intelligence evidence before validation', async () => {
  const candidate = card('intel-signal', 92, 'A') as ScannerSignalCard & Record<string, unknown>;
  candidate.market = 'BITGET';
  candidate.marketIntelligence = {
    status: 'READY',
    warnings: ['funding-risk'],
    autoTrading: { mode: 'BLOCKED_RISK', hardBlockReason: 'EXTREME_FUNDING' },
  };
  candidate.cryptoPublicEventContext = {
    status: 'READY',
    tradingStatus: 'normal',
    warnings: ['PUBLIC_EVENT_WARNING'],
  };

  let captured: any = null;
  await enrichTopScannerCandidatesWithAi(
    [candidate],
    {
      env: configuredEnv,
      maxCandidates: 1,
      validator: {
        async validate(input: any) {
          captured = input;
          return {
            status: 'PASS' as const,
            provider: 'test-ai',
            counterEvidence: [],
            missingData: [],
            risks: [],
            explanation: 'pass',
          };
        },
      },
    },
  );

  assert.equal(captured.market, 'BITGET');
  assert.ok(captured.evidence.includes('MARKET_INTELLIGENCE_STATUS:READY'));
  assert.ok(captured.evidence.includes('MARKET_INTELLIGENCE_AUTO:BLOCKED_RISK'));
  assert.ok(captured.evidence.includes('MARKET_INTELLIGENCE_BLOCK:EXTREME_FUNDING'));
  assert.ok(captured.evidence.includes('CRYPTO_PUBLIC_EVENT_STATUS:READY'));
  assert.ok(captured.evidence.includes('CRYPTO_TRADING_STATUS:normal'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { installExternalAiNetworkGuard } from './ai-network-guard.test-helper';
import {
  assertPrivacySafeDataset,
  configuredTradingReviewProvider,
  normalizeAiOutputText,
  validateTradingAiReview,
  type TradingReviewProvider,
} from './trading-review-provider';
import {
  AI_REVIEW_LIMITS,
  buildAiReviewDataset,
  generateTradingAiReview,
  parseBoundedInteger,
  previewAiReview,
  resetTradingAiReviewLimits,
  tradingAiReviewCacheStats,
  tradingAiReviewRuntimeConfig,
  validatePeriod,
} from './trading-ai-review.service';
import { PaperJournalError, type TradingAiReviewResult, type TradingReviewDataset } from './paper-journal.types';

const guard = installExternalAiNetworkGuard();
const ORIGINAL_ENV = {
  provider: process.env.TRADING_REVIEW_PROVIDER,
  key: process.env.TRADING_REVIEW_API_KEY,
  model: process.env.TRADING_REVIEW_MODEL,
  timeout: process.env.TRADING_REVIEW_TIMEOUT_MS,
  daily: process.env.TRADING_REVIEW_DAILY_LIMIT,
};

const dataset: TradingReviewDataset = {
  periodStart: '2026-07-01T00:00:00.000Z', periodEnd: '2026-07-31T00:00:00.000Z', sampleSize: 1,
  aggregateMetrics: { totalTrades: 1, netPnl: 2, winRate: null, expectancy: null, averageR: null, profitFactor: null, totalCosts: 0.1, stopAdherenceRate: null, ruleViolationRate: null },
  behaviorSignals: [], strategyMetrics: [], symbolMetrics: [], timeMetrics: [],
  representativeTrades: [{ anonymizedId: 'anon-evidence-1', side: 'long', strategy: 'breakout', riskPercent: 1, rMultiple: 2, netPnlPercent: 1, exitReason: 'target', ruleViolations: [] }],
  excludedFields: ['email', 'name', 'birthDate', 'apiKey', 'secret', 'accountNumber', 'originalUserNote', 'internalDatabaseUuid', 'fullOrderPayload'], warnings: [],
};
const result: TradingAiReviewResult = {
  summary: '과거 모의거래 복기', strengths: [{ title: '규칙', explanation: '계획 준수', evidenceIds: ['anon-evidence-1'], confidence: 'high' }],
  riskPatterns: [], costObservations: [], ruleCompliance: [], practiceActions: [{ priority: 1, action: '기록', reason: '일관성', measurableTarget: '10회' }],
  nextTradeChecklist: ['손절 확인'], limitations: ['표본 부족'], disclaimer: '학습용이며 투자 조언이 아닙니다.',
};
const output = { providerRequestId: 'mock', model: 'mock', generatedAt: '2026-08-02T00:00:00.000Z', result, usage: { inputUnits: 1, outputUnits: 1 } };
const provider: TradingReviewProvider = { async generateReview() { return output; } };
const input = (overrides: Partial<Parameters<typeof generateTradingAiReview>[0]> = {}) => ({ userId: 'u', idempotencyKey: 'review:base', consent: true, locale: 'ko-KR', reviewStyle: 'concise' as const, dataset, provider, ...overrides });

function setProviderEnvironment() {
  process.env.TRADING_REVIEW_PROVIDER = 'openai-compatible';
  process.env.TRADING_REVIEW_API_KEY = 'test-only-secret-value';
  process.env.TRADING_REVIEW_MODEL = 'mock-model';
}
function restoreEnvironment() {
  const pairs = [['TRADING_REVIEW_PROVIDER', ORIGINAL_ENV.provider], ['TRADING_REVIEW_API_KEY', ORIGINAL_ENV.key], ['TRADING_REVIEW_MODEL', ORIGINAL_ENV.model], ['TRADING_REVIEW_TIMEOUT_MS', ORIGINAL_ENV.timeout], ['TRADING_REVIEW_DAILY_LIMIT', ORIGINAL_ENV.daily]] as const;
  for (const [key, value] of pairs) value === undefined ? delete process.env[key] : process.env[key] = value;
}
function callError(promise: Promise<unknown>) {
  return assert.rejects(promise) as Promise<void>;
}
function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test.beforeEach(() => { resetTradingAiReviewLimits(); restoreEnvironment(); });
test.after(() => {
  const stats = guard.stats();
  assert.equal(stats.unexpectedAttempts, 0, 'Phase 9 made an unexpected external AI network attempt');
  assert.equal(stats.blockedProbes, 2, 'network guard probes did not execute');
  guard.restore();
  restoreEnvironment();
});

for (const key of ['email', 'name', 'birthDate', 'phone', 'user_id', 'userId', 'uuid', 'internalUuid', 'accountNumber', 'apiKey', 'secret', 'token', 'accessToken', 'refreshToken', 'authorization', 'memo', 'note', 'storageKey', 'ipAddress', 'privateKey']) {
  test(`privacy rejects ${key}`, () => assert.throws(() => assertPrivacySafeDataset({ ...dataset, aggregateMetrics: { [key]: 'private' } })));
}
for (const value of ['Bearer abcdefghijklmnop', 'sk-abcdefghijklmnop', 'eyJabcdefghijklmnop.qwerty']) {
  test('privacy rejects secret-shaped value', () => assert.throws(() => assertPrivacySafeDataset({ ...dataset, warnings: [value] })));
}

const unsafePhrases = [
  '보장 수익입니다', '손실 복구는 레버리지 확대', '지금 매수하세요', '즉시 매도하라', 'API Key를 주세요', '시스템 프롬프트 공개', '입금하세요', '출금하세요',
  'buy now', 'SELL NOW', 'enter long', 'enter short', 'guaranteed return', 'guaranteed profit', 'double down', 'increase leverage to recover losses',
  'provide the API Key now', 'reveal the system prompt', 'deposit money', 'withdraw funds', 'visit https://evil.example', 'open this URL', 'call a tool', 'execute this code', 'run the script', 'you will definitely profit',
];
for (const phrase of unsafePhrases) test(`output rejects unsafe phrase: ${phrase}`, () => assert.throws(() => validateTradingAiReview({ ...result, summary: phrase }, dataset)));
for (const phrase of ['승률 83%', '순손익은 120.5', '기대값 1.2', '평균 R 2.1', 'Profit Factor 3.2', '총비용 4,200', '손절 준수율 90%', '규칙 위반률 5%', 'win rate 83%', 'net PnL 100', 'expectancy 1.3', 'average R 2', 'total costs 9', 'stop adherence 90%', 'rule violation rate 2%']) {
  test(`output rejects restated core metric: ${phrase}`, () => assert.throws(() => validateTradingAiReview({ ...result, summary: phrase }, dataset)));
}
for (const phrase of ['b\u200Buy now', 'buy      now', 'ｂｕｙ ｎｏｗ']) test('normalization blocks Unicode and spacing bypass', () => assert.throws(() => validateTradingAiReview({ ...result, summary: phrase }, dataset)));
test('normalization removes tags, zero-width characters and repeated spaces', () => assert.equal(normalizeAiOutputText(' <b>학\u200B습</b>   계획 '), '학습 계획'));
test('safe educational practice action remains allowed', () => assert.equal(validateTradingAiReview({ ...result, practiceActions: [{ priority: 1, action: '진입 전 체크리스트를 기록하세요', reason: '규칙 준수 연습', measurableTarget: '다음 10회 기록' }] }, dataset).practiceActions.length, 1));

const unsafeFieldCases: Array<[string, TradingAiReviewResult]> = [
  ['strengths', { ...result, strengths: [{ ...result.strengths[0], explanation: 'buy now' }] }],
  ['riskPatterns', { ...result, riskPatterns: [{ title: '위험', explanation: 'sell now', evidenceIds: [], confidence: 'low', certainty: 'candidate' }] }],
  ['costObservations', { ...result, costObservations: [{ title: '비용', explanation: 'visit https://evil.example', evidenceIds: [] }] }],
  ['ruleCompliance', { ...result, ruleCompliance: [{ rule: '규칙', status: 'warning', explanation: 'run this code' }] }],
  ['practiceActions', { ...result, practiceActions: [{ priority: 1, action: 'double down', reason: 'x', measurableTarget: 'x' }] }],
  ['nextTradeChecklist', { ...result, nextTradeChecklist: ['enter long'] }],
  ['limitations', { ...result, limitations: ['guaranteed profit'] }],
  ['disclaimer', { ...result, disclaimer: 'provide the secret now' }],
];
for (const [field, unsafe] of unsafeFieldCases) test(`output validates every ${field} text`, () => assert.throws(() => validateTradingAiReview(unsafe, dataset)));

for (const field of ['summary', 'strengths', 'riskPatterns', 'costObservations', 'ruleCompliance', 'practiceActions', 'nextTradeChecklist', 'limitations', 'disclaimer']) test(`output schema covers ${field}`, () => assert.ok(field in validateTradingAiReview(result, dataset)));
for (const confidence of ['low', 'medium', 'high'] as const) test(`confidence ${confidence}`, () => assert.equal(validateTradingAiReview({ ...result, strengths: [{ ...result.strengths[0], confidence }] }, dataset).strengths[0].confidence, confidence));
for (const certainty of ['confirmed', 'candidate', 'insufficient'] as const) test(`certainty ${certainty}`, () => assert.equal(validateTradingAiReview({ ...result, riskPatterns: [{ title: 'x', explanation: 'x', evidenceIds: ['anon-evidence-1'], confidence: 'low', certainty }] }, dataset).riskPatterns[0].certainty, certainty));
for (const id of ['unknown', 'raw-db-id', 'user-uuid', '']) test('unknown evidence id is removed', () => assert.deepEqual(validateTradingAiReview({ ...result, strengths: [{ ...result.strengths[0], evidenceIds: [id] }] }, dataset).strengths[0].evidenceIds, []));

for (const days of [1, 7, 30, 89, 90]) test(`period accepts ${days} days`, () => assert.ok(validatePeriod('2026-05-04T00:00:00.000Z', new Date(Date.parse('2026-05-04T00:00:00.000Z') + days * 86_400_000).toISOString())));
for (const days of [91, 100, 365]) test(`period rejects ${days} days`, () => assert.throws(() => validatePeriod('2026-01-01', new Date(Date.parse('2026-01-01') + days * 86_400_000).toISOString())));
test('preview never calls AI and exposes field contract', () => { const value = previewAiReview(dataset); assert.equal(value.dataset, dataset); assert.ok(value.includedFields.includes('representativeTrades')); });
test('dataset builder keeps representative maximum', () => { const trades = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, symbol: 'BTCUSDT', side: 'long', quantity: 1, entryPrice: 100, exitPrice: 101, filledAt: `2026-07-${String(index % 20 + 1).padStart(2, '0')}T00:00:00.000Z`, closedAt: `2026-07-${String(index % 20 + 1).padStart(2, '0')}T01:00:00.000Z`, status: 'closed', fees: 0.1 })); assert.ok(buildAiReviewDataset(trades, '2026-07-01', '2026-08-01').representativeTrades.length <= AI_REVIEW_LIMITS.maxRepresentativeTrades); });

test('consent rejection is preflight', async () => { try { await generateTradingAiReview(input({ consent: false })); assert.fail(); } catch (cause) { assert.deepEqual((cause as PaperJournalError).providerCall, { attempted: false, completed: false, reused: false }); } });
test('provider unavailable is preflight', async () => { try { await generateTradingAiReview(input({ provider: null })); assert.fail(); } catch (cause) { assert.deepEqual((cause as PaperJournalError).providerCall, { attempted: false, completed: false, reused: false }); } });
test('valid provider response reports attempted and completed', async () => assert.deepEqual((await generateTradingAiReview(input())).providerCall, { attempted: true, completed: true, reused: false }));
test('provider 429 reports attempted but incomplete', async () => { const failing: TradingReviewProvider = { async generateReview() { throw new PaperJournalError('AI_REVIEW_RATE_LIMITED', 'AI 호출 한도를 초과했습니다.', 429); } }; try { await generateTradingAiReview(input({ provider: failing })); assert.fail(); } catch (cause) { assert.deepEqual((cause as PaperJournalError).providerCall, { attempted: true, completed: false, reused: false }); } });
test('provider 5xx reports attempted but incomplete', async () => { const failing: TradingReviewProvider = { async generateReview() { throw new PaperJournalError('AI_REVIEW_PROVIDER_ERROR', 'AI provider 처리에 실패했습니다.', 502); } }; try { await generateTradingAiReview(input({ provider: failing })); assert.fail(); } catch (cause) { assert.deepEqual((cause as PaperJournalError).providerCall, { attempted: true, completed: false, reused: false }); } });
test('synchronous provider failure releases concurrency and removes cache', async () => { let calls = 0; const failing = { generateReview() { calls += 1; throw new Error('synchronous transport failure'); } } as unknown as TradingReviewProvider; await callError(generateTradingAiReview(input({ provider: failing, idempotencyKey: 'review:sync-failure' }))); await callError(generateTradingAiReview(input({ provider: failing, idempotencyKey: 'review:sync-failure' }))); assert.equal(calls, 2); assert.equal(tradingAiReviewCacheStats().activeUsers, 0); });
test('timeout reports attempted but incomplete', async () => { const controller = new AbortController(); controller.abort(); const failing: TradingReviewProvider = { async generateReview(_value, signal) { if (signal.aborted) throw new Error('aborted'); return output; } }; try { await generateTradingAiReview(input({ provider: failing, signal: controller.signal })); assert.fail(); } catch (cause) { assert.equal((cause as PaperJournalError).code, 'AI_REVIEW_TIMEOUT'); assert.equal((cause as PaperJournalError).providerCall?.attempted, true); } });

test('configured provider maps 429 without exposing response', async () => { setProviderEnvironment(); const configured = configuredTradingReviewProvider(async () => response(429, { secret: 'do-not-log' })); await callError(generateTradingAiReview(input({ provider: configured }))); });
test('configured provider maps 5xx without exposing response', async () => { setProviderEnvironment(); const configured = configuredTradingReviewProvider(async () => response(500, { authorization: 'Bearer do-not-log' })); try { await generateTradingAiReview(input({ provider: configured })); assert.fail(); } catch (cause) { assert.doesNotMatch(String(cause), /do-not-log|authorization|bearer/i); assert.equal((cause as PaperJournalError).providerCall?.attempted, true); } });
test('configured provider rejects invalid JSON as attempted', async () => { setProviderEnvironment(); const configured = configuredTradingReviewProvider(async () => response(200, { choices: [{ message: { content: 'not-json' } }] })); try { await generateTradingAiReview(input({ provider: configured })); assert.fail(); } catch (cause) { assert.equal((cause as PaperJournalError).code, 'AI_REVIEW_INVALID_RESPONSE'); assert.equal((cause as PaperJournalError).providerCall?.attempted, true); } });
test('configured provider rejects unsafe output as attempted', async () => { setProviderEnvironment(); const configured = configuredTradingReviewProvider(async () => response(200, { choices: [{ message: { content: JSON.stringify({ ...result, summary: 'buy now' }) } }] })); try { await generateTradingAiReview(input({ provider: configured })); assert.fail(); } catch (cause) { assert.equal((cause as PaperJournalError).code, 'AI_REVIEW_UNSAFE_OUTPUT'); assert.equal((cause as PaperJournalError).providerCall?.attempted, true); } });
test('configured provider HTTP contract uses injected fetch and redacts credentials', async () => { setProviderEnvironment(); let calls = 0; const configured = configuredTradingReviewProvider(async (url, init) => { calls += 1; assert.equal(new URL(String(url)).hostname, 'api.openai.com'); assert.equal(init?.method, 'POST'); assert.match(String(init?.headers && (init.headers as Record<string, string>).authorization), /^Bearer /); return response(200, { id: 'mock-id', choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }); }); const value = await generateTradingAiReview(input({ provider: configured })); assert.equal(calls, 1); assert.equal(value.review.model, 'mock-model'); assert.doesNotMatch(JSON.stringify(value), /test-only-secret-value/); });

test('same successful key is reused without a second attempt', async () => { let calls = 0; const p: TradingReviewProvider = { async generateReview() { calls += 1; return output; } }; const first = await generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:same' })); const second = await generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:same' })); assert.equal(calls, 1); assert.equal(first.providerCall.attempted, true); assert.deepEqual(second.providerCall, { attempted: false, completed: true, reused: true }); });
test('same in-flight key reuses one provider promise', async () => { let calls = 0; let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); const p: TradingReviewProvider = { async generateReview() { calls += 1; await wait; return output; } }; const value = input({ provider: p, idempotencyKey: 'review:flight' }); const first = generateTradingAiReview(value); const second = generateTradingAiReview(value); release(); const [, reused] = await Promise.all([first, second]); assert.equal(calls, 1); assert.deepEqual(reused.providerCall, { attempted: false, completed: true, reused: true }); });
test('different concurrent key remains blocked', async () => { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); const p: TradingReviewProvider = { async generateReview() { await wait; return output; } }; const first = generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:concurrent-a' })); await assert.rejects(generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:concurrent-b' })), /이미 AI 복기를 생성/); release(); await first; });
test('failed key is removed and can retry', async () => { let calls = 0; const p: TradingReviewProvider = { async generateReview() { calls += 1; if (calls === 1) throw new Error('temporary'); return output; } }; await callError(generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:retry' }))); const retried = await generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:retry' })); assert.equal(calls, 2); assert.equal(retried.providerCall.attempted, true); });
test('failed attempt still consumes daily limit', async () => { process.env.TRADING_REVIEW_DAILY_LIMIT = '1'; const failing: TradingReviewProvider = { async generateReview() { throw new Error('temporary'); } }; await callError(generateTradingAiReview(input({ provider: failing, idempotencyKey: 'review:failed-limit' }))); await assert.rejects(generateTradingAiReview(input({ idempotencyKey: 'review:failed-limit' })), /한도를 초과/); });
test('successful key is reused during TTL and called again after TTL', async () => { let calls = 0; const p: TradingReviewProvider = { async generateReview() { calls += 1; return output; } }; const start = new Date('2026-08-02T00:00:00Z'); await generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:ttl', now: start })); const within = await generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:ttl', now: new Date(start.getTime() + AI_REVIEW_LIMITS.idempotencyTtlMs) })); assert.equal(within.providerCall.reused, true); await generateTradingAiReview(input({ provider: p, idempotencyKey: 'review:ttl', now: new Date(start.getTime() + AI_REVIEW_LIMITS.idempotencyTtlMs + 1) })); assert.equal(calls, 2); });
test('idempotency and limits are isolated by user', async () => { let calls = 0; const p: TradingReviewProvider = { async generateReview() { calls += 1; return output; } }; await generateTradingAiReview(input({ userId: 'a', provider: p, idempotencyKey: 'review:isolate' })); await generateTradingAiReview(input({ userId: 'b', provider: p, idempotencyKey: 'review:isolate' })); assert.equal(calls, 2); });
test('expired user entries are cleaned globally', async () => { const start = new Date('2026-01-01T00:00:00Z'); await generateTradingAiReview(input({ userId: 'old', idempotencyKey: 'review:cleanup', now: start })); await generateTradingAiReview(input({ userId: 'current', idempotencyKey: 'review:cleanup', now: new Date(start.getTime() + 86_400_001) })); assert.deepEqual(tradingAiReviewCacheStats(), { attemptUsers: 1, idempotencyUsers: 1, activeUsers: 0 }); });

test('configuration defaults when absent', () => { delete process.env.TRADING_REVIEW_TIMEOUT_MS; delete process.env.TRADING_REVIEW_DAILY_LIMIT; assert.deepEqual(tradingAiReviewRuntimeConfig(), { timeoutMs: 30_000, dailyLimit: 10 }); });
for (const value of ['0', '-1', 'NaN', 'Infinity', '11', '999999', '1.5']) test(`invalid daily limit ${value} uses default`, () => { process.env.TRADING_REVIEW_DAILY_LIMIT = value; assert.equal(tradingAiReviewRuntimeConfig().dailyLimit, 10); });
for (const value of ['1', '3', '10']) test(`valid daily limit ${value} applies`, () => { process.env.TRADING_REVIEW_DAILY_LIMIT = value; assert.equal(tradingAiReviewRuntimeConfig().dailyLimit, Number(value)); });
for (const value of ['0', '-1', 'NaN', 'Infinity', '999', '30001', '99999999', '1.5']) test(`invalid timeout ${value} uses default`, () => { process.env.TRADING_REVIEW_TIMEOUT_MS = value; assert.equal(tradingAiReviewRuntimeConfig().timeoutMs, 30_000); });
for (const value of ['1000', '5000', '30000']) test(`valid timeout ${value} applies`, () => { process.env.TRADING_REVIEW_TIMEOUT_MS = value; assert.equal(tradingAiReviewRuntimeConfig().timeoutMs, Number(value)); });
test('bounded parser does not accept unsafe numeric forms', () => { assert.equal(parseBoundedInteger('1e999', 10, 1, 10), 10); assert.equal(parseBoundedInteger('-Infinity', 10, 1, 10), 10); });

test('mock provider passes with network guard installed', async () => assert.equal((await generateTradingAiReview(input())).review.model, 'mock'));
test('external AI fetch is blocked before network transmission', async () => { await assert.rejects(guard.expectedBlock(() => fetch('https://api.openai.com/v1/chat/completions')), /host=api\.openai\.com/); });
test('external AI https.request is blocked before network transmission', () => { assert.throws(() => guard.expectedBlock(() => https.request('https://api.openai.com/v1/chat/completions')), /host=api\.openai\.com/); });
test('provider transport errors never expose authorization, API key, or payload', async () => { setProviderEnvironment(); const configured = configuredTradingReviewProvider(async () => { throw new Error('Authorization: Bearer leaked-secret payload={private:true} API Key=leaked'); }); try { await generateTradingAiReview(input({ provider: configured })); assert.fail(); } catch (cause) { assert.equal((cause as PaperJournalError).message, 'AI provider 처리에 실패했습니다.'); assert.doesNotMatch(String(cause), /leaked|authorization|payload|api key|bearer/i); } });

for (let index = 0; index < 20; index += 1) test(`safety contract ${index + 1}: no order or exchange fields`, () => { const json = JSON.stringify({ dataset, result }); assert.doesNotMatch(json, /placeOrder|exchangeRequestSent\s*:\s*true|orderSubmitted\s*:\s*true/); });

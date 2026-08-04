import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const bundlePath = process.argv[2];
if (!bundlePath) throw new Error('Bundled stock analysis engine path is required.');
const { buildStockAnalysis } = await import(pathToFileURL(bundlePath).href);

const baseInput = {
  ticker: 'RGTI',
  name: 'Rigetti Computing',
  market: 'US',
  currency: 'USD',
  asOf: '2026-08-04T10:00:00.000Z',
  quote: {
    price: 15,
    changePercent: 2.5,
    high52: 21,
    low52: 6,
    high: 15.6,
    low: 14.2,
    source: 'US_PROVIDER',
  },
  profile: {
    sector: 'Quantum Computing',
    industry: 'Quantum hardware',
    qubits: 84,
    gateFidelity: 99.2,
    cloudAccess: true,
  },
  financials: {
    source: 'SEC_XBRL',
    financials: {
      quarterly: [
        { period: '2026-Q2', revenue: 120, operatingIncome: -80, netIncome: -75, cash: 300, operatingCashFlow: -60 },
        { period: '2026-Q1', revenue: 100, operatingIncome: -70, netIncome: -68, cash: 350, operatingCashFlow: -55 },
      ],
      ratios: { debtRatio: 40 },
    },
  },
  news: [],
  disclosures: [],
};

const positive = buildStockAnalysis({
  ...baseInput,
  disclosures: [
    {
      title: '정부 연구기관과 양자 시스템 공급 계약 체결',
      source: 'SEC',
      date: '2026-08-03T12:00:00.000Z',
    },
  ],
});

assert.equal(positive.sector, 'quantum');
assert.equal(positive.sectorLabel, '양자컴퓨팅');
assert.ok(Number.isFinite(positive.overallScore));
assert.ok(Number.isFinite(positive.riskScore));
assert.ok(positive.events.some((event) => event.type === 'contract_win'));
assert.ok(positive.upsideFactors.some((factor) => factor.includes('계약')));
assert.ok(positive.peerNames.includes('IBM'));
assert.ok(positive.missingData.includes('경쟁사 최신 정량 비교자료'));

const failure = buildStockAnalysis({
  ...baseInput,
  quote: { ...baseInput.quote, changePercent: -12 },
  disclosures: [
    {
      title: '핵심 양자 프로세서 성능 시험 실패 및 개발 일정 재검토',
      source: 'SEC',
      date: '2026-08-04T08:00:00.000Z',
    },
  ],
});

assert.ok(failure.events.some((event) => event.type === 'development_failure'));
assert.ok(failure.overallScore < positive.overallScore, `${failure.overallScore} should be below ${positive.overallScore}`);
assert.ok(failure.riskScore > positive.riskScore, `${failure.riskScore} should exceed ${positive.riskScore}`);
assert.ok(failure.oneLine.includes('최근'));

const rumor = buildStockAnalysis({
  ...baseInput,
  news: [
    {
      title: '온라인에서 핵심 개발 실패 우려 제기',
      source: 'Unknown Blog',
      date: '2026-08-04T08:00:00.000Z',
    },
  ],
});
const confirmedFailure = failure.events.find((event) => event.type === 'development_failure');
const rumorFailure = rumor.events.find((event) => event.type === 'development_failure');
assert.ok(confirmedFailure && rumorFailure);
assert.equal(confirmedFailure.status, 'confirmed');
assert.equal(rumorFailure.status, 'unconfirmed');
assert.ok(Math.abs(Number(confirmedFailure.impacts.technology)) > Math.abs(Number(rumorFailure.impacts.technology)));

const duplicate = buildStockAnalysis({
  ...baseInput,
  news: [
    { title: '신규 공급 계약 체결', source: 'Reuters', date: '2026-08-03T12:00:00.000Z' },
    { title: '신규 공급 계약 체결', source: 'Other News', date: '2026-08-03T13:00:00.000Z' },
  ],
  disclosures: [
    { title: '신규 공급 계약 체결', source: 'SEC', date: '2026-08-03T14:00:00.000Z' },
  ],
});
assert.equal(duplicate.events.filter((event) => event.type === 'contract_win').length, 1);

const missing = buildStockAnalysis({
  ticker: 'TEST',
  name: 'Test Company',
  market: 'US',
  currency: 'USD',
  asOf: '2026-08-04T10:00:00.000Z',
});
assert.ok(Number.isFinite(missing.overallScore));
assert.ok(Number.isFinite(missing.confidence));
assert.ok(missing.missingData.length >= 4);
assert.equal(missing.events.length, 0);
assert.notEqual(String(missing.overallScore), 'NaN');

console.log('[stock-analysis-engine] quantum, event impact, confirmation weighting, dedupe, and missing-data scenarios passed');

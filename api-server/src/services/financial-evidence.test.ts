import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinnhubRatios } from '../providers/finnhub';
import { parseNaverRatios } from '../providers/naver';
import { getFinancials } from '../providers/sec-edgar';
import { parseFinancialAmount, requireFinancialNumber } from '../providers/financial-evidence';
import { ProviderError } from '../lib/errors';

test('financial evidence rejects unknown values and preserves genuine signed/zero amounts', () => {
  for (const value of [undefined, null, '', ' ', '-', 'N/A', 'abc123', '1,23', '--2', '(2', false, {}, []]) {
    assert.throws(() => parseFinancialAmount(value, 'dart', 'cash'), ProviderError);
  }
  for (const value of [undefined, null, '', '0', false, NaN, Infinity, -Infinity]) {
    assert.throws(() => requireFinancialNumber(value, 'sec-edgar', 'cash'), ProviderError);
  }
  for (const [raw, expected] of [['0', 0], ['1,234', 1234], ['△1,234', -1234], ['(1,234)', -1234], ['-1.5', -1.5], ['+5', 5]] as const) {
    assert.equal(parseFinancialAmount(raw, 'dart', 'cash'), expected);
  }
  assert.equal(requireFinancialNumber(0, 'sec-edgar', 'cash'), 0);
});

test('Finnhub metric schema fails closed and does not replace zero with an alternate metric', () => {
  const metric = {
    epsBasicExclExtraItemsTTM: 0, epsInclExtraItemsTTM: 9,
    peBasicExclExtraTTM: 0, peInclExtraTTM: 9,
    pbAnnual: 0, pbQuarterly: 9, roeTTM: 0, roeRfy: 9,
    'totalDebt/totalEquityAnnual': 0, 'totalDebt/totalEquityQuarterly': 9,
  };
  assert.deepEqual(parseFinnhubRatios({ metric }), { eps: 0, per: 0, pbr: 0, roe: 0, debtRatio: 0 });
  for (const value of [null, [], {}, { metric: null }, { metric: [] }, { metric: {} }]) {
    assert.throws(() => parseFinnhubRatios(value), ProviderError);
  }
  for (const value of ['', false, '1', NaN, Infinity, Number.MAX_VALUE]) {
    assert.throws(() => parseFinnhubRatios({ metric: { ...metric, roeTTM: value } }), ProviderError);
  }
  assert.equal(parseFinnhubRatios({ metric: { ...metric, roeTTM: null, roeRfy: -5.3 } }).roe, -5.3);
});

test('Naver ratios only accept exact numeric fields, never nearby dates or other ratios', () => {
  const html = '<span>EPS 2026.08 PER 15</span><em id="_eps">0</em><em id="_per">11.53</em><em id="_pbr">2.99</em>';
  assert.deepEqual(parseNaverRatios(html), { eps: 0, per: 11.53, pbr: 2.99, bps: null });
  for (const bad of ['', '<p>EPS 2026 PER 1 PBR 0</p>', html.replace('>0</em>', '>N/A</em>'), html.replace('id="_eps"', 'id="missing"'), html + '<em id="_eps">4</em>']) {
    assert.throws(() => parseNaverRatios(bad), ProviderError);
  }
});

test('SEC runtime statements require same-period USD evidence and propagate outages', async (t) => {
  // Synthetic fixtures exercise provider failure handling; they are never live evidence.
  const scenarios = ['valid', 'missing-cash', 'wrong-period', 'wrong-unit', 'malformed', 'future', 'invalid-value', '401', '403', '429', '500', 'network'] as const;
  let scenario: typeof scenarios[number] = 'valid';
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('company_tickers.json')) {
      return Response.json(Object.fromEntries(scenarios.map((_, index) => [index, { cik_str: index + 100, ticker: `FIXTURE${index}`, title: 'Test only' }])));
    }
    assert.match(url, /^https:\/\/data\.sec\.gov\/api\/xbrl\/companyconcept\//);
    const tag = url.split('/').at(-1)?.replace('.json', '');
    if (scenario === 'network') throw new TypeError('fixture socket failure');
    if (/^\d+$/.test(scenario)) return new Response('{}', { status: Number(scenario) });
    if (scenario === 'malformed') return new Response('not-json');
    const instant = /Cash|Liabilities|Equity|CommonStock/.test(tag ?? '');
    const points = instant
      ? ['2023-12-31', '2024-12-31', '2024-09-30'].map((end) => ({ end, val: 0, form: '10-K' }))
      : [
          { start: '2023-01-01', end: '2023-12-31', val: 0, form: '10-K' },
          { start: '2024-01-01', end: '2024-12-31', val: 0, form: '10-K' },
          { start: '2024-07-01', end: '2024-09-30', val: 0, form: '10-Q' },
        ];
    if (scenario === 'missing-cash' && /Cash/.test(tag ?? '')) return Response.json({ units: { USD: [] } });
    if (scenario === 'wrong-period' && /Cash/.test(tag ?? '')) points[0].end = '2023-09-30';
    if (scenario === 'future') points[0].end = '9999-12-31';
    if (scenario === 'invalid-value') return Response.json({ units: { USD: [{ ...points[0], val: null }] } });
    return Response.json({ units: { [scenario === 'wrong-unit' ? 'EUR' : 'USD']: points } });
  });
  try {
    for (const [index, value] of scenarios.entries()) {
      scenario = value;
      if (scenario === 'valid') {
        const result = await getFinancials(`FIXTURE${index}`);
        assert.equal(result.annual[0].period, '2023-12-31');
        assert.equal(result.annual[0].cash, 0);
        assert.equal(result.quarterly[0].netIncome, 0);
      } else {
        await assert.rejects(getFinancials(`FIXTURE${index}`), ProviderError, scenario);
      }
    }
  } finally { fetchMock.mock.restore(); }
});

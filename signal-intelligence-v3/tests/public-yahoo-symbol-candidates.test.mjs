import test from 'node:test';
import assert from 'node:assert/strict';
import {publicYahooProviderCandidates} from '../src/public-yahoo-symbol-candidates.mjs';

test('known KR exchange never probes another venue after a genuine empty page',()=>{
  assert.deepEqual(publicYahooProviderCandidates('KR_STOCK','005930',
    {exchange:'코스피'}),['005930.KS']);
  assert.deepEqual(publicYahooProviderCandidates('KR_STOCK','035720',
    {exchange:'코스닥'}),['035720.KQ']);
  assert.deepEqual(publicYahooProviderCandidates('KR_STOCK','069500',
    {exchange:'ETF·ETN'}),['069500.KS','069500.KQ']);
  assert.deepEqual(publicYahooProviderCandidates('KR_STOCK','123456',{}),
    ['123456.KS','123456.KQ']);
});
test('US class shares keep canonical variant and public fallback while KR alphanumeric remains unsupported',()=>{
  assert.deepEqual(publicYahooProviderCandidates('US_STOCK','BRK.B'),
    ['BRK-B','BRK.B']);
  assert.deepEqual(publicYahooProviderCandidates('US_STOCK','AAPL'),['AAPL']);
  assert.deepEqual(publicYahooProviderCandidates('KR_STOCK','Q12345',{}),['Q12345']);
  assert.deepEqual(publicYahooProviderCandidates('US_STOCK',''),[]);
});

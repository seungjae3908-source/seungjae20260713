import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalArxivUrl,
  canonicalDoiUrl,
  normalizeArxivId,
  normalizeDoi,
  normalizeTemporal,
  validateProviderRequestUrl,
} from '../src/index.js';

test('DOI resolver, DOI prefix, encoding, and case normalize to one identity', () => {
  const expected = '10.1234/example.test(2)';
  assert.equal(normalizeDoi('DOI: 10.1234/EXAMPLE.TEST(2)'), expected);
  assert.equal(normalizeDoi('https://doi.org/10.1234/EXAMPLE.TEST%282%29?ignored=true'), expected);
  assert.equal(canonicalDoiUrl(expected), 'https://doi.org/10.1234/example.test(2)');
});

test('malformed DOI and non-DOI resolver hosts fail closed', () => {
  assert.throws(() => normalizeDoi('10.12/nope'), /DOI_INVALID/);
  assert.throws(() => normalizeDoi('https://example.test/10.1234/example'), /DOI_URL_HOST_INVALID/);
});

test('modern and legacy arXiv identities dedupe versions under a base id', () => {
  assert.deepEqual(normalizeArxivId('arXiv:1706.03762v7'), { arXivId: '1706.03762', version: 7 });
  assert.deepEqual(normalizeArxivId('https://arxiv.org/pdf/hep-th/9901001v2.pdf'), { arXivId: 'hep-th/9901001', version: 2 });
  assert.equal(canonicalArxivUrl('1706.03762', 7), 'https://arxiv.org/abs/1706.03762v7');
});

test('publication precision is preserved instead of inventing month or day', () => {
  assert.equal(normalizeTemporal('2024'), '2024');
  assert.equal(normalizeTemporal('2024-02'), '2024-02');
  assert.equal(normalizeTemporal('2024-02-29'), '2024-02-29');
  assert.throws(() => normalizeTemporal('2023-02-29'), /TEMPORAL_VALUE_INVALID/);
  assert.throws(() => normalizeTemporal('2024-01-01T00:00:00'), /TEMPORAL_VALUE_INVALID/);
});

test('provider request provenance is HTTPS, provider-scoped, and credential-free', () => {
  assert.match(validateProviderRequestUrl('CROSSREF', 'https://api.crossref.org/v1/works/10.1234/example'), /^https:/u);
  assert.throws(() => validateProviderRequestUrl('ARXIV', 'http://export.arxiv.org/api/query?id_list=1706.03762'), /HTTPS_REQUIRED/);
  assert.throws(() => validateProviderRequestUrl('SEMANTIC_SCHOLAR', 'https://api.semanticscholar.org/graph/v1/paper/x?x-api-key=secret'), /PRIVATE_API_FORBIDDEN/);
});

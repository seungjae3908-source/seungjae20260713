import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptArxivMetadata,
  adaptCrossrefMetadata,
  adaptSemanticScholarMetadata,
  compareResearchPaperIdentity,
  groupResearchPaperDuplicates,
  researchPaperIdentityKeys,
} from '../src/index.js';

const context = {
  CROSSREF: { retrievedAt: '2026-08-24T06:00:00Z', retrievedFrom: 'https://api.crossref.org/works/10.1234/shared' },
  SEMANTIC_SCHOLAR: { retrievedAt: '2026-08-24T06:00:00Z', retrievedFrom: 'https://api.semanticscholar.org/graph/v1/paper/s2-shared' },
  ARXIV: { retrievedAt: '2026-08-24T06:00:00Z', retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2' },
};

function crossref(DOI = '10.1234/shared', arxiv = '2402.00001v2') {
  return adaptCrossrefMetadata({
    status: 'ok',
    'message-type': 'work',
    message: {
      DOI,
      title: ['Shared Paper'],
      author: [{ given: 'Ada', family: 'Lovelace' }],
      published: { 'date-parts': [[2024, 2, 1]] },
      indexed: { 'date-time': '2026-08-20T00:00:00Z', version: '3.51.4' },
      'alternative-id': [arxiv],
    },
  }, context.CROSSREF);
}

function semantic(DOI = '10.1234/shared', arxiv = '2402.00001') {
  return adaptSemanticScholarMetadata({
    paperId: 's2-shared',
    title: 'Shared Paper',
    authors: [{ name: 'Ada Lovelace' }],
    year: 2024,
    externalIds: { DOI, ArXiv: arxiv },
  }, context.SEMANTIC_SCHOLAR);
}

function arxiv() {
  return adaptArxivMetadata({
    id: 'https://arxiv.org/abs/2402.00001v2',
    title: 'Shared Paper',
    authors: [{ name: 'Ada Lovelace' }],
    published: '2024-02-01T00:00:00Z',
    updated: '2024-03-01T00:00:00Z',
    doi: '10.1234/shared',
  }, context.ARXIV);
}

test('DOI and arXiv aliases group Crossref, Semantic Scholar, and arXiv without losing provenance', () => {
  const records = [crossref(), semantic(), arxiv()];
  assert.equal(compareResearchPaperIdentity(records[0], records[1]).status, 'SAME');
  assert.deepEqual(researchPaperIdentityKeys(records[2]).slice(0, 2), ['arxiv:2402.00001', 'doi:10.1234/shared']);
  const groups = groupResearchPaperDuplicates(records);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonicalIdentity, 'doi:10.1234/shared');
  assert.equal(groups[0].records.length, 3);
  assert.deepEqual(groups[0].records.map((record) => record.source), ['CROSSREF', 'SEMANTIC_SCHOLAR', 'ARXIV']);
});

test('same strong identity with a conflicting alias fails closed', () => {
  const left = crossref('10.1234/shared', '2402.00001');
  const right = semantic('10.9999/different', '2402.00001');
  const comparison = compareResearchPaperIdentity(left, right);
  assert.equal(comparison.status, 'CONFLICT');
  assert.deepEqual(comparison.conflicts, ['DOI']);
  assert.throws(() => groupResearchPaperDuplicates([left, right]), /PAPER_IDENTITY_CONFLICT:DOI/);
});

test('similar titles and authors never create fuzzy duplicates without a shared identifier', () => {
  const left = semantic(null, null);
  const right = adaptSemanticScholarMetadata({
    paperId: 's2-other',
    title: 'Shared Paper',
    authors: [{ name: 'Ada Lovelace' }],
    year: 2024,
    externalIds: {},
  }, { ...context.SEMANTIC_SCHOLAR, retrievedFrom: 'https://api.semanticscholar.org/graph/v1/paper/s2-other' });
  assert.equal(compareResearchPaperIdentity(left, right).status, 'DISTINCT');
  assert.equal(groupResearchPaperDuplicates([left, right]).length, 2);
});

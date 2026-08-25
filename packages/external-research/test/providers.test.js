import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptArxivMetadata,
  adaptCrossrefMetadata,
  adaptProviderMetadata,
  adaptSemanticScholarMetadata,
  assertResearchPaperV2,
  computeResearchPaperMetadataHash,
  verifyResearchPaperV2,
} from '../src/index.js';

const retrievedAt = '2026-08-24T06:00:00.000Z';

function crossrefPayload(overrides = {}) {
  return {
    status: 'ok',
    'message-type': 'work',
    'message-version': '1.0.0',
    message: {
      DOI: '10.1234/EXTERNAL.001',
      title: ['  Canonical   External Research  '],
      author: [{ given: 'Ada', family: 'Lovelace' }, { name: 'Research Consortium' }],
      'published-online': { 'date-parts': [[2024, 2]] },
      indexed: { 'date-time': '2026-08-23T03:04:05Z', version: '3.51.4' },
      'alternative-id': ['arXiv:2402.00001v2'],
      'updated-by': [
        { DOI: '10.1234/correction.001', type: 'correction', label: 'Correction', source: 'publisher', updated: { 'date-parts': [[2025, 1, 2]] } },
        { DOI: '10.1234/retraction.001', type: 'retraction', label: 'Retraction', source: 'retraction-watch', updated: { 'date-time': '2026-01-02T00:00:00Z' } },
      ],
      license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/', 'content-version': 'vor', 'delay-in-days': 0, start: { 'date-parts': [[2024, 2, 1]] } }],
      ...overrides,
    },
  };
}

function semanticScholarPayload(overrides = {}) {
  return {
    paperId: '649def34f8be52c8b66281af98ae884c09aef38b',
    title: 'Canonical External Research',
    authors: [{ authorId: '1', name: 'Ada Lovelace' }],
    publicationDate: '2024-02-01',
    year: 2024,
    externalIds: { DOI: '10.1234/external.001', ArXiv: '2402.00001' },
    url: 'https://www.semanticscholar.org/paper/649def34f8be52c8b66281af98ae884c09aef38b',
    openAccessPdf: { url: 'https://example.test/paper.pdf', license: 'CCBY', status: 'GOLD' },
    ...overrides,
  };
}

function arxivPayload(overrides = {}) {
  return {
    id: 'https://arxiv.org/abs/2402.00001v2',
    title: 'Canonical External Research',
    authors: [{ name: 'Ada Lovelace' }],
    published: '2024-02-01T01:02:03Z',
    updated: '2024-03-01T01:02:03Z',
    doi: '10.1234/external.001',
    ...overrides,
  };
}

function rehashedPaper(paper, mutate) {
  const changed = structuredClone(paper);
  mutate(changed);
  changed.metadataHash = computeResearchPaperMetadataHash(changed);
  return changed;
}

test('Crossref adapter preserves precision, integrity evidence, content license, and hashes', () => {
  const paper = adaptCrossrefMetadata(crossrefPayload(), {
    retrievedAt,
    retrievedFrom: 'https://api.crossref.org/v1/works/10.1234/external.001',
  });
  assert.equal(paper.schemaVersion, 2);
  assert.equal(paper.paperId, 'doi:10.1234/external.001');
  assert.equal(paper.title, 'Canonical External Research');
  assert.deepEqual(paper.authors, ['Ada Lovelace', 'Research Consortium']);
  assert.equal(paper.publishedAt, '2024-02');
  assert.equal(paper.arXivId, '2402.00001');
  assert.equal(paper.version.workVersion, 'v2');
  assert.equal(paper.correctionState.status, 'CORRECTED');
  assert.equal(paper.retractionState.status, 'RETRACTED');
  assert.equal(paper.retractionState.evidence[0].source, 'retraction-watch');
  assert.equal(paper.license.metadata.status, 'PUBLIC_DOMAIN');
  assert.equal(paper.license.content.status, 'KNOWN');
  assert.equal(paper.license.content.entries[0].verificationRequired, true);
  assert.match(paper.metadataHash, /^[0-9a-f]{64}$/u);
  assert.match(paper.provenance.sourceHash, /^[0-9a-f]{64}$/u);
  assert.equal(verifyResearchPaperV2(paper), true);
});

test('retrieval time changes provenance but not normalized metadata hash', () => {
  const payload = crossrefPayload({ 'updated-by': undefined });
  delete payload.message['updated-by'];
  const first = adaptCrossrefMetadata(payload, { retrievedAt, retrievedFrom: 'https://api.crossref.org/works/10.1234/external.001' });
  const second = adaptCrossrefMetadata(payload, { retrievedAt: '2026-08-24T07:00:00Z', retrievedFrom: 'https://api.crossref.org/works/10.1234/external.001' });
  assert.equal(first.metadataHash, second.metadataHash);
  assert.notEqual(first.retrievedAt, second.retrievedAt);
  assert.equal(first.correctionState.status, 'UNKNOWN');
  assert.equal(first.retractionState.status, 'UNKNOWN');
});

test('Crossref incomplete authors fail closed instead of creating a partial paper', () => {
  assert.throws(() => adaptCrossrefMetadata(crossrefPayload({ author: [] }), {
    retrievedAt,
    retrievedFrom: 'https://api.crossref.org/works/10.1234/external.001',
  }), /AUTHORS_REQUIRED/);
});

test('Crossref update direction distinguishes affected works from integrity notices', () => {
  const payload = crossrefPayload({
    'updated-by': undefined,
    'update-to': [
      { DOI: '10.1234/original.001', type: 'retraction', label: 'Retraction', source: 'publisher', updated: { 'date-parts': [[2026, 1, 2]] } },
    ],
  });
  delete payload.message['updated-by'];
  const notice = adaptCrossrefMetadata(payload, {
    retrievedAt,
    retrievedFrom: 'https://api.crossref.org/works/10.1234/external.001',
  });
  assert.equal(notice.retractionState.status, 'RETRACTION_NOTICE');
  assert.equal(notice.retractionState.evidence[0].relation, 'UPDATES');
  assert.equal(notice.correctionState.status, 'UNKNOWN');
});

test('Semantic Scholar keeps provider terms separate and requires source license verification', () => {
  const paper = adaptSemanticScholarMetadata(semanticScholarPayload(), {
    retrievedAt,
    retrievedFrom: 'https://api.semanticscholar.org/graph/v1/paper/DOI:10.1234%2Fexternal.001?fields=title,authors,externalIds',
  });
  assert.equal(paper.paperId, 'doi:10.1234/external.001');
  assert.equal(paper.license.metadata.status, 'TERMS_GOVERNED');
  assert.equal(paper.license.metadata.attributionRequired, true);
  assert.equal(paper.license.content.entries[0].identifier, 'CCBY');
  assert.equal(paper.license.content.entries[0].verificationRequired, true);
  assert.equal(paper.correctionState.status, 'UNKNOWN');
  assert.equal(paper.retractionState.status, 'UNKNOWN');
});

test('Semantic Scholar never infers retraction or license from a title or PDF URL', () => {
  const paper = adaptSemanticScholarMetadata(semanticScholarPayload({
    title: 'RETRACTED: suspicious title',
    openAccessPdf: { url: 'https://example.test/paper.pdf', license: null },
  }), {
    retrievedAt,
    retrievedFrom: 'https://api.semanticscholar.org/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b',
  });
  assert.equal(paper.retractionState.status, 'UNKNOWN');
  assert.equal(paper.license.content.status, 'UNKNOWN');
});

test('Semantic Scholar year-only metadata remains year precision', () => {
  const payload = semanticScholarPayload({ publicationDate: null, externalIds: {} });
  const paper = adaptSemanticScholarMetadata(payload, {
    retrievedAt,
    retrievedFrom: 'https://api.semanticscholar.org/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b',
  });
  assert.equal(paper.publishedAt, '2024');
  assert.equal(paper.paperId, `semantic_scholar:${payload.paperId}`);
});

test('arXiv adapter preserves base identity/version and does not invent content license or withdrawal state', () => {
  const paper = adaptArxivMetadata(arxivPayload({ comment: 'Withdrawn by the authors' }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  assert.equal(paper.paperId, 'doi:10.1234/external.001');
  assert.equal(paper.arXivId, '2402.00001');
  assert.equal(paper.version.workVersion, 'v2');
  assert.equal(paper.license.metadata.identifier, 'CC0-1.0');
  assert.equal(paper.license.content.status, 'UNKNOWN');
  assert.equal(paper.retractionState.status, 'UNKNOWN');
});

test('arXiv canonical URL exactly binds a modern base identity and version', () => {
  const paper = adaptArxivMetadata(arxivPayload({ doi: null }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  assert.equal(paper.canonicalUrl, 'https://arxiv.org/abs/2402.00001v2');
  assert.equal(assertResearchPaperV2(paper), paper);
});

test('arXiv canonical URL prefix collisions fail even with a recomputed hash', () => {
  const paper = adaptArxivMetadata(arxivPayload({ doi: null }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  const collision = rehashedPaper(paper, (changed) => {
    changed.canonicalUrl = 'https://arxiv.org/abs/2402.000010v2';
  });
  assert.throws(() => assertResearchPaperV2(collision), /ARXIV_CANONICAL_URL_MISMATCH/);
});

test('different arXiv canonical identities fail even with a recomputed hash', () => {
  const paper = adaptArxivMetadata(arxivPayload({ doi: null }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  const mismatch = rehashedPaper(paper, (changed) => {
    changed.canonicalUrl = 'https://arxiv.org/abs/2402.00002v2';
  });
  assert.throws(() => assertResearchPaperV2(mismatch), /ARXIV_CANONICAL_URL_MISMATCH/);
});

test('arXiv canonical URL version mismatches fail closed', () => {
  const paper = adaptArxivMetadata(arxivPayload({ doi: null }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  const mismatch = rehashedPaper(paper, (changed) => {
    changed.canonicalUrl = 'https://arxiv.org/abs/2402.00001v3';
  });
  assert.throws(() => assertResearchPaperV2(mismatch), /ARXIV_CANONICAL_URL_MISMATCH/);
});

test('arXiv canonical URLs reject query, fragment, and alternate-path tricks', () => {
  const paper = adaptArxivMetadata(arxivPayload({ doi: null }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  for (const canonicalUrl of [
    'https://arxiv.org/abs/2402.00001v2?target=2402.00002',
    'https://arxiv.org/abs/2402.00001v2#2402.00002',
    'https://arxiv.org/pdf/2402.00001v2.pdf',
  ]) {
    const mismatch = rehashedPaper(paper, (changed) => {
      changed.canonicalUrl = canonicalUrl;
    });
    assert.throws(() => assertResearchPaperV2(mismatch), /ARXIV_CANONICAL_URL_MISMATCH/);
  }
});

test('legacy arXiv category and identifier mismatches fail closed', () => {
  const paper = adaptArxivMetadata(arxivPayload({
    id: 'https://arxiv.org/abs/hep-th/9901001v2',
    doi: null,
  }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=hep-th%2F9901001v2',
  });
  assert.equal(paper.canonicalUrl, 'https://arxiv.org/abs/hep-th/9901001v2');
  const mismatch = rehashedPaper(paper, (changed) => {
    changed.canonicalUrl = 'https://arxiv.org/abs/hep-ph/9901001v2';
  });
  assert.throws(() => assertResearchPaperV2(mismatch), /ARXIV_CANONICAL_URL_MISMATCH/);
});

test('Crossref provider record identity is the normalized DOI', () => {
  const paper = adaptCrossrefMetadata(crossrefPayload(), {
    retrievedAt,
    retrievedFrom: 'https://api.crossref.org/works/10.1234/external.001',
  });
  assert.equal(paper.provenance.providerRecordId, paper.DOI);
  assert.equal(assertResearchPaperV2(paper), paper);
});

test('Crossref provider record identity mismatch fails with a recomputed hash', () => {
  const paper = adaptCrossrefMetadata(crossrefPayload(), {
    retrievedAt,
    retrievedFrom: 'https://api.crossref.org/works/10.1234/external.001',
  });
  const mismatch = rehashedPaper(paper, (changed) => {
    changed.provenance.providerRecordId = '10.9999/other';
  });
  assert.throws(() => assertResearchPaperV2(mismatch), /CROSSREF_PROVIDER_RECORD_ID_MISMATCH/);
});

test('arXiv provider record identity binds the base identifier and version', () => {
  const paper = adaptArxivMetadata(arxivPayload(), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  assert.equal(paper.provenance.providerRecordId, '2402.00001v2');
  const mismatch = rehashedPaper(paper, (changed) => {
    changed.provenance.providerRecordId = '2402.00002v2';
  });
  assert.throws(() => assertResearchPaperV2(mismatch), /ARXIV_PROVIDER_RECORD_ID_MISMATCH/);
});

test('Semantic Scholar keeps its independent provider-specific identity', () => {
  const payload = semanticScholarPayload({ externalIds: {} });
  const paper = adaptSemanticScholarMetadata(payload, {
    retrievedAt,
    retrievedFrom: `https://api.semanticscholar.org/graph/v1/paper/${payload.paperId}`,
  });
  assert.equal(paper.paperId, `semantic_scholar:${payload.paperId}`);
  assert.equal(paper.provenance.providerRecordId, payload.paperId);
  assert.equal(assertResearchPaperV2(paper), paper);
});

test('Semantic Scholar fallback provider identity tampering fails closed', () => {
  const payload = semanticScholarPayload({ externalIds: {} });
  const paper = adaptSemanticScholarMetadata(payload, {
    retrievedAt,
    retrievedFrom: `https://api.semanticscholar.org/graph/v1/paper/${payload.paperId}`,
  });
  const mismatch = rehashedPaper(paper, (changed) => {
    changed.provenance.providerRecordId = 'different-semantic-scholar-id';
  });
  assert.throws(() => assertResearchPaperV2(mismatch), /PAPER_ID_MISMATCH/);
});

test('invalid timestamps fail even with a recomputed metadata hash', () => {
  const paper = adaptArxivMetadata(arxivPayload(), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  const invalid = rehashedPaper(paper, (changed) => {
    changed.publishedAt = '2023-02-29T00:00:00Z';
  });
  assert.throws(() => assertResearchPaperV2(invalid), /PUBLISHED_AT_INVALID/);
});

test('provider payload property insertion order does not change deterministic hashes', () => {
  const payload = arxivPayload({ doi: null });
  const reordered = {
    doi: payload.doi,
    updated: payload.updated,
    published: payload.published,
    authors: payload.authors,
    title: payload.title,
    id: payload.id,
  };
  const context = {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  };
  const first = adaptArxivMetadata(payload, context);
  const second = adaptArxivMetadata(reordered, context);
  assert.equal(first.provenance.sourceHash, second.provenance.sourceHash);
  assert.equal(first.metadataHash, second.metadataHash);
});

test('meaningful arXiv version changes preserve identity and change metadata hash', () => {
  const v2 = adaptArxivMetadata(arxivPayload({ doi: null }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  const v3 = adaptArxivMetadata(arxivPayload({
    id: 'https://arxiv.org/abs/2402.00001v3',
    updated: '2024-04-01T01:02:03Z',
    doi: null,
  }), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v3',
  });
  assert.equal(v2.paperId, v3.paperId);
  assert.notEqual(v2.metadataHash, v3.metadataHash);
});

test('dispatcher rejects unsupported providers and private or malformed provenance', () => {
  assert.throws(() => adaptProviderMetadata('PRIVATE_PROVIDER', {}, {}), /SOURCE_UNSUPPORTED/);
  assert.throws(() => adaptArxivMetadata(arxivPayload(), {
    retrievedAt,
    retrievedFrom: 'https://example.test/api/query?id_list=2402.00001',
  }), /ARXIV_REQUEST_URL_INVALID/);
});

test('strict validation detects unknown fields and any normalized metadata tampering', () => {
  const paper = adaptArxivMetadata(arxivPayload(), {
    retrievedAt,
    retrievedFrom: 'https://export.arxiv.org/api/query?id_list=2402.00001v2',
  });
  const unknownField = { ...paper, extra: true };
  assert.equal(verifyResearchPaperV2(unknownField), false);
  assert.throws(() => assertResearchPaperV2(unknownField), /SHAPE_INVALID/);

  const tampered = structuredClone(paper);
  tampered.title = 'Tampered title';
  assert.equal(verifyResearchPaperV2(tampered), false);
  assert.throws(() => assertResearchPaperV2(tampered), /METADATA_HASH_MISMATCH/);

  const provenanceTampered = structuredClone(paper);
  provenanceTampered.provenance.sourceHash = '0'.repeat(64);
  assert.equal(verifyResearchPaperV2(provenanceTampered), false);
  assert.throws(() => assertResearchPaperV2(provenanceTampered), /METADATA_HASH_MISMATCH/);
});

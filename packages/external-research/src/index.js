export {
  ExternalResearchValidationError,
} from './errors.js';
export {
  canonicalArxivUrl,
  canonicalDoiUrl,
  derivePaperId,
  normalizeArxivId,
  normalizeDoi,
  normalizeTemporal,
} from './identifiers.js';
export {
  PROVIDER_POLICIES,
  PROVIDER_POLICY_VERSION,
  validateProviderRequestUrl,
} from './policies.js';
export {
  FIELD_SOURCE_KEYS,
  RESEARCH_PAPER_SCHEMA_VERSION,
  RESEARCH_PAPER_SOURCES,
  assertResearchPaperV2,
  computeResearchPaperMetadataHash,
  verifyResearchPaperV2,
} from './contract.js';
export {
  compareResearchPaperIdentity,
  groupResearchPaperDuplicates,
  researchPaperIdentityKeys,
} from './identity.js';
export { adaptCrossrefMetadata } from './providers/crossref.js';
export { adaptSemanticScholarMetadata } from './providers/semantic-scholar.js';
export { adaptArxivMetadata } from './providers/arxiv.js';

import { fail } from './errors.js';
import { adaptArxivMetadata } from './providers/arxiv.js';
import { adaptCrossrefMetadata } from './providers/crossref.js';
import { adaptSemanticScholarMetadata } from './providers/semantic-scholar.js';

export function adaptProviderMetadata(source, payload, context) {
  if (source === 'CROSSREF') return adaptCrossrefMetadata(payload, context);
  if (source === 'SEMANTIC_SCHOLAR') return adaptSemanticScholarMetadata(payload, context);
  if (source === 'ARXIV') return adaptArxivMetadata(payload, context);
  fail('SOURCE_UNSUPPORTED');
}

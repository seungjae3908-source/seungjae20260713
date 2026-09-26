export type ResearchPaperSource = 'CROSSREF' | 'SEMANTIC_SCHOLAR' | 'ARXIV';
export type CorrectionStatus = 'UNKNOWN' | 'CORRECTED' | 'CORRECTION_NOTICE';
export type RetractionStatus = 'UNKNOWN' | 'RETRACTED' | 'RETRACTION_NOTICE' | 'EXPRESSION_OF_CONCERN' | 'REINSTATED';

export interface IntegrityEvidence {
  relation: 'UPDATES' | 'UPDATED_BY';
  type: string;
  identifier: string | null;
  label: string | null;
  source: string | null;
  updatedAt: string | null;
}

export interface ResearchPaperVersion {
  workVersion: string | null;
  providerRecordVersion: string | null;
  providerUpdatedAt: string | null;
}

export interface ResearchPaperLicense {
  metadata: {
    status: 'PUBLIC_DOMAIN' | 'TERMS_GOVERNED';
    identifier: string | null;
    url: string;
    attributionRequired: boolean;
  };
  content: {
    status: 'KNOWN' | 'UNKNOWN';
    entries: readonly {
      identifier: string | null;
      url: string | null;
      appliesTo: string;
      startsAt: string | null;
      delayInDays: number | null;
      verificationRequired: boolean;
    }[];
  };
}

export interface ResearchPaperProvenance {
  provider: ResearchPaperSource;
  providerRecordId: string;
  retrievedFrom: string;
  retrievedAt: string;
  sourceHash: string;
  adapter: { name: string; version: string };
  accessMode: 'PUBLIC_ANONYMOUS';
  policyVersion: 'external-research-provider-policy-2026-08-24';
  fieldSources: Record<
    'title' | 'authors' | 'publishedAt' | 'DOI' | 'arXivId' | 'canonicalUrl' | 'version' | 'correctionState' | 'retractionState' | 'license',
    string
  >;
}

export interface ResearchPaperV2 {
  schemaVersion: 2;
  paperId: string;
  title: string;
  authors: readonly string[];
  /** ISO 8601 at the provider's actual precision: YYYY, YYYY-MM, YYYY-MM-DD, or an offset timestamp. */
  publishedAt: string;
  source: ResearchPaperSource;
  DOI: string | null;
  /** Canonical base identifier without a vN suffix. */
  arXivId: string | null;
  canonicalUrl: string;
  version: ResearchPaperVersion;
  correctionState: { status: CorrectionStatus; evidence: readonly IntegrityEvidence[] };
  retractionState: { status: RetractionStatus; evidence: readonly IntegrityEvidence[] };
  license: ResearchPaperLicense;
  retrievedAt: string;
  metadataHash: string;
  provenance: ResearchPaperProvenance;
}

export interface AdapterContext {
  retrievedAt: string;
  retrievedFrom: string;
}

export class ExternalResearchValidationError extends Error {
  readonly code: string;
}

export const RESEARCH_PAPER_SCHEMA_VERSION: 2;
export const RESEARCH_PAPER_SOURCES: readonly ResearchPaperSource[];
export const FIELD_SOURCE_KEYS: readonly string[];
export const PROVIDER_POLICY_VERSION: 'external-research-provider-policy-2026-08-24';
export const PROVIDER_POLICIES: Readonly<Record<ResearchPaperSource, Readonly<Record<string, unknown>>>>;

export function normalizeDoi(value: unknown): string | null;
export function canonicalDoiUrl(value: unknown): string;
export function normalizeArxivId(value: unknown): Readonly<{ arXivId: string; version: number | null }> | null;
export function canonicalArxivUrl(value: unknown, explicitVersion?: number | null): string;
export function normalizeTemporal(value: unknown, code?: string): string;
export function derivePaperId(input: { DOI?: unknown; arXivId?: unknown; source: ResearchPaperSource; providerRecordId: unknown }): string;
export function validateProviderRequestUrl(source: ResearchPaperSource, value: unknown): string;

export function adaptCrossrefMetadata(payload: unknown, context: AdapterContext): ResearchPaperV2;
export function adaptSemanticScholarMetadata(payload: unknown, context: AdapterContext): ResearchPaperV2;
export function adaptArxivMetadata(payload: unknown, context: AdapterContext): ResearchPaperV2;
export function adaptProviderMetadata(source: ResearchPaperSource, payload: unknown, context: AdapterContext): ResearchPaperV2;

export function computeResearchPaperMetadataHash(paper: Omit<ResearchPaperV2, 'metadataHash'> | ResearchPaperV2): string;
export function assertResearchPaperV2(paper: unknown): asserts paper is ResearchPaperV2;
export function verifyResearchPaperV2(paper: unknown): paper is ResearchPaperV2;
export function researchPaperIdentityKeys(paper: ResearchPaperV2): readonly string[];
export function compareResearchPaperIdentity(
  left: ResearchPaperV2,
  right: ResearchPaperV2,
): Readonly<{ status: 'SAME' | 'DISTINCT' | 'CONFLICT'; sharedKeys: readonly string[]; conflicts?: readonly string[] }>;
export function groupResearchPaperDuplicates(records: readonly ResearchPaperV2[]): readonly Readonly<{
  canonicalIdentity: string;
  identityKeys: readonly string[];
  records: readonly ResearchPaperV2[];
}>[];

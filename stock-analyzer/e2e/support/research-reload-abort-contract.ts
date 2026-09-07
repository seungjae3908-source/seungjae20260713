export const RESEARCH_CENTER_ROUTE = '/research-center';
export const RESEARCH_OVERVIEW_PATH = '/api/admin/research/overview';

export type ResearchReloadAbortCandidate = {
  method: string;
  rawUrl: string;
  errorText: string | undefined;
  origin: string;
  startedBeforeReload: boolean;
};

export type ResearchReloadAcceptanceProof = {
  fromRoute: string;
  toRoute: string;
  intentionalReload: boolean;
  obsoleteByReload: boolean;
  browserLifecycleCancelled: boolean;
  currentPageDataPresent: boolean;
  sessionRetained: boolean;
  capabilityRetained: boolean;
  noUserVisibleError: boolean;
  freshRequestIssued: boolean;
  freshResponseStatus: number | null;
  staleResponseBlocked: boolean;
};

export function isResearchOverviewRequestIdentity(input: {
  method: string;
  rawUrl: string;
  origin: string;
}) {
  try {
    const parsed = new URL(input.rawUrl);
    return input.method === 'GET'
      && parsed.origin === input.origin
      && parsed.pathname === RESEARCH_OVERVIEW_PATH
      && parsed.searchParams.size === 0;
  } catch {
    return false;
  }
}

export function isResearchReloadAbortCandidate(input: ResearchReloadAbortCandidate) {
  return input.startedBeforeReload
    && input.errorText === 'net::ERR_ABORTED'
    && isResearchOverviewRequestIdentity(input);
}

export function isCompleteResearchReloadProof(proof: ResearchReloadAcceptanceProof) {
  return proof.fromRoute === RESEARCH_CENTER_ROUTE
    && proof.toRoute === RESEARCH_CENTER_ROUTE
    && proof.intentionalReload
    && proof.obsoleteByReload
    && proof.browserLifecycleCancelled
    && proof.currentPageDataPresent
    && proof.sessionRetained
    && proof.capabilityRetained
    && proof.noUserVisibleError
    && proof.freshRequestIssued
    && proof.freshResponseStatus === 200
    && proof.staleResponseBlocked;
}

export function canClassifyResearchReloadAbort(
  candidate: ResearchReloadAbortCandidate,
  proof: ResearchReloadAcceptanceProof,
) {
  return isResearchReloadAbortCandidate(candidate)
    && isCompleteResearchReloadProof(proof);
}

export function responseBelongsToActiveDocument(
  requestDocumentLifecycle: string,
  activeDocumentLifecycle: string,
) {
  return requestDocumentLifecycle === activeDocumentLifecycle;
}

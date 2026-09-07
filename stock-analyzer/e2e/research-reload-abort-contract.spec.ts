import { expect, test } from '@playwright/test';
import {
  canClassifyResearchReloadAbort,
  isCompleteResearchReloadProof,
  isResearchReloadAbortCandidate,
  isResearchOverviewRequestIdentity,
  responseBelongsToActiveDocument,
  type ResearchReloadAbortCandidate,
  type ResearchReloadAcceptanceProof,
} from './support/research-reload-abort-contract';

const origin = 'https://staging.example.test';
const candidate: ResearchReloadAbortCandidate = {
  method: 'GET',
  rawUrl: `${origin}/api/admin/research/overview`,
  errorText: 'net::ERR_ABORTED',
  origin,
  startedBeforeReload: true,
};
const completeProof: ResearchReloadAcceptanceProof = {
  fromRoute: '/research-center',
  toRoute: '/research-center',
  intentionalReload: true,
  obsoleteByReload: true,
  browserLifecycleCancelled: true,
  currentPageDataPresent: true,
  sessionRetained: true,
  capabilityRetained: true,
  noUserVisibleError: true,
  freshRequestIssued: true,
  freshResponseStatus: 200,
  staleResponseBlocked: true,
};

test('accepts only the exact pre-reload Research overview request identity', () => {
  expect(isResearchOverviewRequestIdentity(candidate)).toBe(true);
  expect(isResearchReloadAbortCandidate(candidate)).toBe(true);
  expect(isResearchReloadAbortCandidate({ ...candidate, startedBeforeReload: false })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, errorText: 'net::ERR_FAILED' })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, method: 'POST' })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, rawUrl: `${candidate.rawUrl}?refresh=1` })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, rawUrl: `${origin}/api/admin/members` })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, rawUrl: 'https://other.example.test/api/admin/research/overview' })).toBe(false);
});

test('classifies the obsolete request only after the complete reload proof', () => {
  expect(isCompleteResearchReloadProof(completeProof)).toBe(true);
  expect(canClassifyResearchReloadAbort(candidate, completeProof)).toBe(true);
});

test('keeps authentication or capability loss as an unexpected failure', () => {
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, sessionRetained: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, capabilityRetained: false })).toBe(false);
});

test('requires current Research data, no visible error, and a successful replacement read', () => {
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, currentPageDataPresent: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, noUserVisibleError: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, freshRequestIssued: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, freshResponseStatus: 503 })).toBe(false);
});

test('does not turn an unrelated route change into a reload exemption', () => {
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, toRoute: '/account' })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, intentionalReload: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, obsoleteByReload: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, browserLifecycleCancelled: false })).toBe(false);
});

test('prevents an old-document response from being accepted by the reloaded lifecycle', () => {
  expect(responseBelongsToActiveDocument('document-before-reload', 'document-after-reload')).toBe(false);
  expect(responseBelongsToActiveDocument('document-after-reload', 'document-after-reload')).toBe(true);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, staleResponseBlocked: false })).toBe(false);
});

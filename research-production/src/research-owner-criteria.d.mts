export const RESEARCH_OWNER_CRITERIA_VERSION: 'research-owner-criteria-v1';
export function researchOwnerMarketCriteria(market: string, direction: string): Readonly<Record<string, unknown>>;
export function researchOwnerExposureBounds(market: string, direction: string, capitalKrw: number): Readonly<Record<string, unknown>>;
export function buildOwnerApprovedReferenceDsl(market: string, direction: string): Record<string, unknown>;

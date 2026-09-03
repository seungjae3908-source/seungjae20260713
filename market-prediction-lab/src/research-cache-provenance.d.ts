export function sha256Canonical(value: unknown): string;
export function buildResearchDatasetIdentity(value: Record<string, unknown>): Record<string, unknown>;
export function validateResearchDatasetIdentity(value: unknown): { valid: boolean; status: string; reason: string | null };

export type PublicNativeCryptoRosterValidationV1 = Readonly<{ ok: boolean; reason: string | null; rosterDigestSha256: string | null }>;
export function normalizePublicNativeCryptoRosterV1(input: Record<string, unknown>): Record<string, any>;
export function validatePublicNativeCryptoRosterV1(roster: unknown, expectedDigest?: string | null): PublicNativeCryptoRosterValidationV1;
export function validatePublicNativeCryptoRosterCaptureV1(envelope: unknown, expectedDigest?: string | null): PublicNativeCryptoRosterValidationV1;
export function fetchPublicNativeCryptoRosterV1(input?: Record<string, unknown>): Promise<Record<string, any>>;

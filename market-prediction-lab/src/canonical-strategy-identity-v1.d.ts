export function resolveCanonicalStrategyIdentity(value: Record<string, unknown>): {
  status: string; identity: Record<string, unknown> | null; strategyIdentityDigest: string | null;
  missingFields: string[]; blockers: string[];
};

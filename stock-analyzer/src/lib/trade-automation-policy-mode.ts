/**
 * Canonical persistence mode for the automatic-trading master switch.
 * AUTO OFF must clear both authority dimensions, not only automaticEnabled.
 * The API intentionally resets market/exchange entry gates in approval mode.
 */
export type AutomaticPolicyMode = 'approval' | 'automatic';

export function policyModeForAutomaticEnabled(automaticEnabled: boolean): AutomaticPolicyMode {
  return automaticEnabled === true ? 'automatic' : 'approval';
}

/**
 * Stop-safe reduction must remain reachable even if an old or partially
 * persisted policy already says automaticEnabled=false while its mode or
 * per-market auto switches are still active. This is display-only preflight,
 * not approval to enable execution.
 */
export function automaticPolicyNeedsSafeOff(policy: Readonly<{
  mode: AutomaticPolicyMode;
  automaticEnabled: boolean;
  marketEnabled?: object;
  exchangeEnabled?: object;
}>): boolean {
  const hasEnabled = (switches: object | undefined) =>
    switches != null && Object.values(switches).some((value) => value === true);
  return policy.mode !== 'approval' || policy.automaticEnabled === true
    || hasEnabled(policy.marketEnabled) || hasEnabled(policy.exchangeEnabled);
}

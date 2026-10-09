/**
 * Canonical persistence mode for the automatic-trading master switch.
 * AUTO OFF must clear both authority dimensions, not only automaticEnabled.
 * The API intentionally resets market/exchange entry gates in approval mode.
 */
export type AutomaticPolicyMode = 'approval' | 'automatic';

export function policyModeForAutomaticEnabled(automaticEnabled: boolean): AutomaticPolicyMode {
  return automaticEnabled === true ? 'automatic' : 'approval';
}

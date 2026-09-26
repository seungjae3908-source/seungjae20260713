export const EvidenceDisplayState: Readonly<{
  VALUE: 'VALUE';
  N_A: 'N_A';
  NOT_COLLECTED: 'NOT_COLLECTED';
  STALE: 'STALE';
  UNAVAILABLE: 'UNAVAILABLE';
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED';
}>;

export type EvidenceDisplayStateValue = typeof EvidenceDisplayState[keyof typeof EvidenceDisplayState];
export type EvidenceDisplayValue = number | string | null | undefined;

export type EvidenceDisplayResult = Readonly<{
  state: EvidenceDisplayStateValue;
  display: string;
  value: number | string | null;
  isActualZero: boolean;
  evidenceAvailable: boolean;
}>;

export function resolveEvidenceDisplay(input?: {
  value?: EvidenceDisplayValue;
  applicable?: boolean;
  collected?: boolean;
  stale?: boolean;
  available?: boolean;
  permitted?: boolean;
  state?: EvidenceDisplayStateValue;
  formatter?: (value: number | string) => string;
}): EvidenceDisplayResult;

export function evidenceStateLabel(state: EvidenceDisplayStateValue): string;

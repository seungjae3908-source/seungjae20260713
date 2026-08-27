export const EvidenceDisplayState = Object.freeze({
  VALUE: 'VALUE',
  N_A: 'N_A',
  NOT_COLLECTED: 'NOT_COLLECTED',
  STALE: 'STALE',
  UNAVAILABLE: 'UNAVAILABLE',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
});

const LABELS = Object.freeze({
  N_A: 'N/A · 해당 없음',
  NOT_COLLECTED: '미수집',
  STALE: '오래된 데이터',
  UNAVAILABLE: '사용 불가',
  PERMISSION_REQUIRED: '권한 없음',
});

function isUsableValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim().length > 0;
}

function defaultFormat(value) {
  if (typeof value === 'number') return String(value);
  return value;
}

/**
 * Fail-closed UI evidence projection shared by browser surfaces and contract tests.
 * A numeric zero is a real VALUE; missing/unknown states never fall back to zero.
 */
export function resolveEvidenceDisplay({
  value,
  applicable = true,
  collected = true,
  stale = false,
  available = true,
  permitted = true,
  state,
  formatter = defaultFormat,
} = {}) {
  const explicit = state && state !== EvidenceDisplayState.VALUE ? state : null;
  let resolvedState = explicit;

  if (!resolvedState) {
    if (!applicable) resolvedState = EvidenceDisplayState.N_A;
    else if (!permitted) resolvedState = EvidenceDisplayState.PERMISSION_REQUIRED;
    else if (!available) resolvedState = EvidenceDisplayState.UNAVAILABLE;
    else if (stale) resolvedState = EvidenceDisplayState.STALE;
    else if (!collected || value === null || value === undefined) resolvedState = EvidenceDisplayState.NOT_COLLECTED;
    else if (!isUsableValue(value)) resolvedState = EvidenceDisplayState.UNAVAILABLE;
    else resolvedState = EvidenceDisplayState.VALUE;
  }

  if (resolvedState !== EvidenceDisplayState.VALUE) {
    const display = LABELS[resolvedState];
    if (!display) throw new Error(`Unsupported evidence display state: ${resolvedState}`);
    return Object.freeze({
      state: resolvedState,
      display,
      value: null,
      isActualZero: false,
      evidenceAvailable: false,
    });
  }

  if (!isUsableValue(value)) {
    return Object.freeze({
      state: EvidenceDisplayState.UNAVAILABLE,
      display: LABELS.UNAVAILABLE,
      value: null,
      isActualZero: false,
      evidenceAvailable: false,
    });
  }

  const display = String(formatter(value));
  if (!display.trim()) throw new Error('Evidence VALUE formatter returned an empty display');
  return Object.freeze({
    state: EvidenceDisplayState.VALUE,
    display,
    value,
    isActualZero: typeof value === 'number' && Object.is(value, 0),
    evidenceAvailable: true,
  });
}

export function evidenceStateLabel(state) {
  if (state === EvidenceDisplayState.VALUE) return '실측값';
  return LABELS[state] ?? '사용 불가';
}

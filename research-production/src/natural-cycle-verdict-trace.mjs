export const NATURAL_PAPER_STAGE_ORDER = Object.freeze([
  'SCANNER_CANDIDATE',
  'PROFIT_GATE',
  'EXACT_IDENTITY',
  'PAPER_ADMISSION',
  'ENTRY_CREATED',
  'POSITION_OPENED',
  'EXIT_CONDITION_REACHED',
  'SETTLEMENT_COMPLETED',
]);

export const NATURAL_PAPER_STAGE_FIELDS = Object.freeze({
  SCANNER_CANDIDATE: 'scannerCandidateCount',
  PROFIT_GATE: 'profitGatePassCount',
  EXACT_IDENTITY: 'exactIdentityPassCount',
  PAPER_ADMISSION: 'paperAdmissionCount',
  ENTRY_CREATED: 'entryCreatedCount',
  POSITION_OPENED: 'positionOpenedCount',
  EXIT_CONDITION_REACHED: 'exitConditionReachedCount',
  SETTLEMENT_COMPLETED: 'settlementCompletedCount',
});

export const NATURAL_PAPER_FIRST_ZERO_CODES = Object.freeze({
  SCANNER_CANDIDATE: 'SCANNER_CANDIDATE_ZERO',
  PROFIT_GATE: 'PROFIT_GATE_ZERO',
  EXACT_IDENTITY: 'IDENTITY_REJECTED',
  PAPER_ADMISSION: 'PAPER_ADMISSION_ZERO',
  ENTRY_CREATED: 'ENTRY_NOT_CREATED',
  POSITION_OPENED: 'POSITION_NOT_OPENED',
  EXIT_CONDITION_REACHED: 'EXIT_NOT_MATURED',
  SETTLEMENT_COMPLETED: 'SETTLEMENT_FAILED',
});

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactSha(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function countOrUnknown(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('Paper stage counts must be non-negative integers or null');
  return number;
}

function blockerFor(stage, input) {
  const explicit = input?.blockerReasons?.[stage];
  if (nonEmpty(explicit)) return explicit.trim();
  if (stage === 'SCANNER_CANDIDATE' && input.scannerToPaperBridgeConnected === false) return 'SCANNER_TO_PAPER_BRIDGE_MISSING';
  if (stage === 'PROFIT_GATE' && input.profitGateEvidenceConnected === false) return 'PROFIT_GATE_EVIDENCE_MISSING';
  if (stage === 'EXACT_IDENTITY') return 'EXACT_IDENTITY_REJECTED';
  if (stage === 'PAPER_ADMISSION') return 'PAPER_ADMISSION_REJECTED';
  if (stage === 'ENTRY_CREATED' && input.outcomeAccumulationEnabled === false) return 'OUTCOME_ACCUMULATION_DISABLED';
  if (stage === 'POSITION_OPENED') return 'POSITION_OPEN_FAILED';
  if (stage === 'EXIT_CONDITION_REACHED') return 'EXIT_NOT_MATURED';
  if (stage === 'SETTLEMENT_COMPLETED') return 'SETTLEMENT_FAILED';
  return NATURAL_PAPER_FIRST_ZERO_CODES[stage];
}

export function buildNaturalPaperFirstZeroTrace(input = {}) {
  const cycleId = nonEmpty(input.cycleId) ? input.cycleId.trim() : null;
  const researchCodeSha = exactSha(input.researchCodeSha);
  const triggerSource = nonEmpty(input.triggerSource) ? input.triggerSource.trim().toLowerCase() : null;
  const naturalCycle = triggerSource === 'cron';
  const counts = {};
  const stages = [];
  let firstZeroStage = null;
  let firstUnknownStage = null;
  let earlierEvidenceKnown = true;

  for (const stage of NATURAL_PAPER_STAGE_ORDER) {
    const field = NATURAL_PAPER_STAGE_FIELDS[stage];
    const count = countOrUnknown(input[field]);
    counts[field] = count;
    let status = 'PASS';
    let firstZeroCode = null;
    let blockerReason = null;

    if (count === null) {
      status = 'UNKNOWN';
      if (firstUnknownStage === null && firstZeroStage === null) firstUnknownStage = stage;
      earlierEvidenceKnown = false;
    } else if (count === 0) {
      status = 'ZERO';
      firstZeroCode = NATURAL_PAPER_FIRST_ZERO_CODES[stage];
      blockerReason = blockerFor(stage, input);
      if (firstZeroStage === null && firstUnknownStage === null && earlierEvidenceKnown) {
        firstZeroStage = Object.freeze({
          stage,
          field,
          code: firstZeroCode,
          blockerReason,
        });
      }
    }

    stages.push(Object.freeze({ stage, field, count, status, firstZeroCode, blockerReason }));
  }

  const allObservedPositive = stages.every((stage) => stage.count !== null && stage.count > 0);
  const status = !naturalCycle
    ? 'NOT_NATURAL_CYCLE'
    : firstZeroStage
      ? 'BLOCKED'
      : firstUnknownStage
        ? 'WAITING_EVIDENCE'
        : allObservedPositive
          ? 'COMPLETE'
          : 'WAITING_EVIDENCE';

  return Object.freeze({
    schemaVersion: 'natural-paper-first-zero-trace-v1',
    cycleId,
    researchCodeSha,
    triggerSource,
    naturalCycle,
    status,
    counts: Object.freeze(counts),
    stages: Object.freeze(stages),
    firstZeroStage,
    firstUnknownStage,
    safety: Object.freeze({
      readOnly: true,
      executionAuthority: 'NONE',
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      transferEnabled: false,
      withdrawalEnabled: false,
      orderCount: 0,
      cancelCount: 0,
      amendCount: 0,
      transferCount: 0,
      withdrawalCount: 0,
    }),
  });
}

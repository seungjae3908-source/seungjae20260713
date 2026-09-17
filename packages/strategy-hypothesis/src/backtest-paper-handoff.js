// Transport only: this is not a new candidate identity authority or an admission certificate.
export const BACKTEST_PAPER_HANDOFF_VERSION = 'backtest-paper-reference-v1';
const MAX_HANDOFF_LENGTH = 12_000;
const STRINGS = ['candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'riskPolicyRef', 'costPolicyRef', 'exitPolicyRef'];
const HASH = /^[0-9a-f]{64}$/u;
const knownString = (value) => typeof value === 'string' && value.length > 0 && value.length <= 240
  && value === value.trim() && !['MISSING', 'UNKNOWN', 'UNAVAILABLE'].includes(value);

export function parseBacktestPaperHandoff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== BACKTEST_PAPER_HANDOFF_VERSION || value.source !== 'backtest-result'
    || value.executionAuthority !== 'NONE' || value.evidenceCredit !== 0 || value.orderSubmitted !== false
    || value.privateTradingApiAllowed !== false || value.status !== 'REFERENCE_ONLY') return null;
  const result = {};
  for (const field of STRINGS) {
    if (value[field] !== null && !knownString(value[field])) return null;
    result[field] = value[field];
  }
  if (result.market !== null && result.market !== 'CRYPTO_FUTURES') return null;
  if (result.symbol !== null && !/^[A-Z0-9]{2,16}USDT$/u.test(result.symbol)) return null;
  if (result.side !== null && !['LONG', 'SHORT'].includes(result.side)) return null;
  if (result.parameterHash !== null && !HASH.test(result.parameterHash)) return null;
  if (result.candidateId !== null && !/^paper-candidate-v1:[0-9a-f]{64}$/u.test(result.candidateId)) return null;
  if (value.leverage !== null && !(typeof value.leverage === 'number' && Number.isFinite(value.leverage)
    && value.leverage >= 1 && value.leverage <= 10)) return null;
  if (!Array.isArray(value.blockers) || value.blockers.length > 30
    || !value.blockers.every(knownString)) return null;
  return Object.freeze({
    schemaVersion: BACKTEST_PAPER_HANDOFF_VERSION, source: 'backtest-result', status: 'REFERENCE_ONLY',
    ...result, leverage: value.leverage, blockers: Object.freeze([...value.blockers]),
    executionAuthority: 'NONE', evidenceCredit: 0, orderSubmitted: false, privateTradingApiAllowed: false,
  });
}

export function backtestPaperHandoffPath(value) {
  const handoff = parseBacktestPaperHandoff(value);
  if (!handoff) throw new Error('INVALID_BACKTEST_PAPER_HANDOFF');
  const encoded = JSON.stringify(handoff);
  if (encoded.length > MAX_HANDOFF_LENGTH) throw new Error('BACKTEST_PAPER_HANDOFF_TOO_LARGE');
  return `/paper-trading?${new URLSearchParams({ backtestCandidate: encoded })}`;
}

export function readBacktestPaperHandoff(search) {
  const values = new URLSearchParams(search).getAll('backtestCandidate');
  if (!values.length) return Object.freeze({ active: false, handoff: null, error: null });
  if (values.length !== 1 || values[0].length > MAX_HANDOFF_LENGTH) {
    return Object.freeze({ active: true, handoff: null, error: 'INVALID_BACKTEST_PAPER_HANDOFF' });
  }
  try {
    const handoff = parseBacktestPaperHandoff(JSON.parse(values[0]));
    return Object.freeze({ active: true, handoff, error: handoff ? null : 'INVALID_BACKTEST_PAPER_HANDOFF' });
  } catch {
    return Object.freeze({ active: true, handoff: null, error: 'INVALID_BACKTEST_PAPER_HANDOFF' });
  }
}

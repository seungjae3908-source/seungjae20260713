export interface BacktestPaperHandoff {
  readonly schemaVersion: 'backtest-paper-reference-v1';
  readonly source: 'backtest-result';
  readonly status: 'REFERENCE_ONLY';
  readonly candidateId: string | null;
  readonly strategyId: string | null;
  readonly parameterHash: string | null;
  readonly market: 'CRYPTO_FUTURES' | null;
  readonly symbol: string | null;
  readonly timeframe: string | null;
  readonly side: 'LONG' | 'SHORT' | null;
  readonly leverage: number | null;
  readonly riskPolicyRef: string | null;
  readonly costPolicyRef: string | null;
  readonly exitPolicyRef: string | null;
  readonly blockers: readonly string[];
  readonly executionAuthority: 'NONE';
  readonly evidenceCredit: 0;
  readonly orderSubmitted: false;
  readonly privateTradingApiAllowed: false;
}
export const BACKTEST_PAPER_HANDOFF_VERSION: 'backtest-paper-reference-v1';
export function parseBacktestPaperHandoff(value: unknown): BacktestPaperHandoff | null;
export function backtestPaperHandoffPath(value: BacktestPaperHandoff, runId?: string): string;
export function readBacktestPaperHandoff(search: string): {
  active: boolean; handoff: BacktestPaperHandoff | null; error: string | null; runId?: string | null;
};

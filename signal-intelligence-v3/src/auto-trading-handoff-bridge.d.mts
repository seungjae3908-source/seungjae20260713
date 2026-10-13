import type {
  MemberAutoTradingPaperHandoff,
  MemberAutoTradingPaperHandoffEntry,
} from '../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';

export type SignalAdmissionSelection = Readonly<{
  status: 'READY' | 'BLOCKED_DATA';
  entries: readonly MemberAutoTradingPaperHandoffEntry[];
  blockers: readonly string[];
  candidateCount?: number;
  admittedCount?: number;
  rejectedCount?: number;
}>;

export function selectSignalAdmittedHandoffEntries(input: Readonly<{
  handoff: MemberAutoTradingPaperHandoff;
  snapshot: unknown;
  expectedServiceSha: string;
  nowMs?: number;
  maximumAgeMs?: number;
}>): SignalAdmissionSelection;

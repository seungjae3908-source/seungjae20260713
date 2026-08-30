import { PAPER_RESEARCH_PERSISTED_LEDGER_ID, PAPER_RESEARCH_PERSISTED_LEDGER_SCHEMA } from './paper-research-ledger-evidence';
import { PaperJournalError, type StoredPaperJournalRecord } from './paper-journal.types';

export type OtherPaperNamespace = 'currency-research' | 'signal-performance' | 'broker-execution';

export function otherPaperPayloadNamespace(payload: Record<string, unknown>): OtherPaperNamespace | null {
  if (payload.schemaVersion === PAPER_RESEARCH_PERSISTED_LEDGER_SCHEMA) return 'currency-research';
  if (payload.schemaVersion === 'signal-performance-event-v1' || payload.schemaVersion === 'signal-performance-outcome-v1') return 'signal-performance';
  if (payload.schemaVersion === 1 && payload.recordType === 'unified_trade_order') return 'broker-execution';
  return null;
}

export function reservedPaperRecordId(id: string) {
  return id === PAPER_RESEARCH_PERSISTED_LEDGER_ID || id.startsWith('signal-performance:') || id.startsWith('broker-exec-');
}

// Classification does not certify these domains' financial evidence. They remain in
// their own research/unified ledgers and never become a manual PaperTradingState.
export function otherPaperRecordNamespace(record: StoredPaperJournalRecord, owner: string): OtherPaperNamespace | null {
  const namespace = otherPaperPayloadNamespace(record.payload);
  const valid = namespace === 'currency-research' ? record.kind === 'account' && record.id === PAPER_RESEARCH_PERSISTED_LEDGER_ID
    : namespace === 'signal-performance' ? record.kind === 'journal' && record.payload.ownerId === owner
      && (record.payload.schemaVersion === 'signal-performance-event-v1' ? record.id === `signal-performance:event:${record.payload.signalId}` : record.id === `signal-performance:outcome:${record.payload.outcomeId}`)
    : namespace === 'broker-execution' ? record.kind === 'journal' && /^broker-exec-[a-f0-9]{32}$/.test(record.id)
    : !reservedPaperRecordId(record.id);
  if (!valid) throw new PaperJournalError('INVALID_RECORD_NAMESPACE', '저장된 원장 종류와 식별자가 일치하지 않습니다.');
  return namespace;
}

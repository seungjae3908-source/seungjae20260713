import type { PaperJournalEntry } from './paper-trading';
import { evidenceInstant, evidenceNumber } from './server-evidence';

export type PaperStatistics = {
  status: 'READY' | 'MISSING_EVIDENCE' | 'INVALID';
  totalTrades: number; wins: number | null; losses: number | null; winRate: number | null;
  averageProfit: number | null; averageLoss: number | null; expectancy: number | null; averageR: number | null;
  profitFactor: number | null; maximumConsecutiveWins: number | null; maximumConsecutiveLosses: number | null;
  cumulativeNetPnl: number | null; totalFees: number | null; totalSlippage: number | null; totalFunding: number | null;
};

type StatisticsEntry = Pick<PaperJournalEntry, 'status' | 'netPnl' | 'entryFee' | 'exitFee' | 'slippageCost' | 'fundingCost' | 'rMultiple' | 'closedAt' | 'conflictCopyOf'>;

export function calculatePaperStatistics(journal: readonly StatisticsEntry[]): PaperStatistics {
  const entries = journal.filter((item) => item.status === 'closed' && !item.conflictCopyOf);
  const total = entries.length;
  const valid = entries.every((item) => [item.netPnl, item.entryFee, item.exitFee, item.slippageCost, item.fundingCost].every(evidenceNumber));
  const ordered = entries.every((item) => evidenceInstant(item.closedAt, Date.now()));
  const completeR = total > 0 && entries.every((item) => evidenceNumber(item.rMultiple));
  const profits = entries.filter((item) => item.netPnl > 0);
  const losses = entries.filter((item) => item.netPnl < 0);
  const grossProfit = profits.reduce((sum, item) => sum + item.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, item) => sum + item.netPnl, 0));
  const net = entries.reduce((sum, item) => sum + item.netPnl, 0);
  let wins = 0; let lossCount = 0; let maxWins = 0; let maxLosses = 0;
  if (valid && ordered) {
    for (const item of [...entries].sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!))) {
      if (item.netPnl > 0) { wins += 1; lossCount = 0; }
      else if (item.netPnl < 0) { lossCount += 1; wins = 0; }
      else { wins = 0; lossCount = 0; }
      maxWins = Math.max(maxWins, wins); maxLosses = Math.max(maxLosses, lossCount);
    }
  }
  const finite = (value: number) => valid && Number.isFinite(value) ? value : null;
  const result: PaperStatistics = {
    status: !valid ? 'INVALID' : !total || !ordered || !completeR ? 'MISSING_EVIDENCE' : 'READY',
    totalTrades: total, wins: valid ? profits.length : null, losses: valid ? losses.length : null,
    winRate: total ? finite(profits.length / total * 100) : null,
    averageProfit: profits.length ? finite(grossProfit / profits.length) : null,
    averageLoss: losses.length ? finite(-grossLoss / losses.length) : null,
    expectancy: total ? finite(net / total) : null,
    averageR: completeR ? finite(entries.reduce((sum, item) => sum + item.rMultiple!, 0) / total) : null,
    profitFactor: grossLoss > 0 ? finite(grossProfit / grossLoss) : null,
    maximumConsecutiveWins: valid && ordered ? maxWins : null,
    maximumConsecutiveLosses: valid && ordered ? maxLosses : null,
    cumulativeNetPnl: finite(net),
    totalFees: finite(entries.reduce((sum, item) => sum + item.entryFee + item.exitFee, 0)),
    totalSlippage: finite(entries.reduce((sum, item) => sum + item.slippageCost, 0)),
    totalFunding: finite(entries.reduce((sum, item) => sum + item.fundingCost, 0)),
  };
  if (valid && [result.cumulativeNetPnl, result.totalFees, result.totalSlippage, result.totalFunding].includes(null)) result.status = 'INVALID';
  return result;
}

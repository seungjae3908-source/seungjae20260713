/**
 * Fail-closed, read-only interpretation of the deployed Research forward
 * cycle. "Observed" means the scheduled tasks ran; it does not imply a
 * profitable strategy or a Production Paper fill.
 */
export const EXPECTED_FORWARD_TASK_IDS = Object.freeze([
  'formula-backtest-queue',
  'shadow-forward',
  'paper-forward',
]);

export function assessForwardCycleEvidence({ expectedSha, timer, cycle, tasks } = {}) {
  const forward = Array.isArray(tasks)
    ? tasks.filter((row) => row?.profile === 'forward')
    : [];
  const exactTasks = forward.length === EXPECTED_FORWARD_TASK_IDS.length
    && EXPECTED_FORWARD_TASK_IDS.every((id) =>
      forward.filter((row) => row.id === id).length === 1);
  const trigger = String(timer?.last_trigger ?? '').trim();
  const lastTriggerPresent = Boolean(trigger)
    && !/^(?:n\/a|null|unknown|none|0)$/i.test(trigger);
  const sourceExact = typeof expectedSha === 'string'
    && /^[0-9a-f]{40}$/.test(expectedSha)
    && cycle?.research_sha === expectedSha;
  const allowedStatuses = forward.every((row) =>
    row.status === 'success' || row.status === 'blocked_data');
  const observed = Boolean(lastTriggerPresent
    && cycle?.present === 'true'
    && cycle?.failed_count === '0'
    && sourceExact && exactTasks && allowedStatuses);
  return Object.freeze({
    observed,
    sourceExact,
    exactTasks,
    hasBlockedData: observed && forward.some((row) => row.status === 'blocked_data'),
    allSucceeded: observed && forward.every((row) => row.status === 'success'),
  });
}

export function classifyNaturalCycleEvidence({
  releaseMatch, timersHealthy, forward, paperSafe,
  historicalComplete, historicalRunning,
} = {}) {
  // A stale server can yield useful diagnostics, but is NEVER a current
  // release PASS even when its timers and old Paper state are healthy.
  if (releaseMatch !== true) return 'stale_release';
  if (timersHealthy !== true || paperSafe !== true || forward?.observed !== true) {
    return 'failed';
  }
  // A completed timer with blocked tasks is NOT a healthy Research/Paper cycle.
  if (forward.hasBlockedData === true) return 'blocked_data';
  if (forward.allSucceeded !== true) return 'failed';
  if (historicalComplete === true) return 'passed';
  if (historicalRunning === true) return 'forward_pass_historical_running';
  return 'forward_pass_historical_unproven';
}

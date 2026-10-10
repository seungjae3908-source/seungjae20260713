// Research-only storage budget projection; never archives/deletes files.
export const WATCH_CAPACITY_CONTRACT = 'public-watch-capacity-planning-v1';
export const WATCH_CAPACITY_POLICY = Object.freeze({
  diskFloorBytes: 5 * 1024 ** 3,
  maxFileBytes: 64 * 1024 ** 2,
  maxDays: 366,
  categories: ['events', 'outcomes', 'cadence'],
});
const valid = v => Number.isSafeInteger(v) && v >= 0;
function validUtcDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day))
    return false;
  const at = Date.parse(day + 'T00:00:00Z');
  return Number.isSafeInteger(at)
    && new Date(at).toISOString().slice(0,10) === day;
}
export function summarizeWatchStorageCapacity({ files, diskFreeBytes, nowUtcDay }) {
  if (!Array.isArray(files) || files.length > WATCH_CAPACITY_POLICY.maxDays * 3
    || !valid(diskFreeBytes) || !validUtcDay(nowUtcDay))
    throw new Error('WATCH_CAPACITY_INPUT_INVALID');
  const seen = new Set(), sizeByDate = new Map();
  for(const f of files) {
    if (!f || !WATCH_CAPACITY_POLICY.categories.includes(f.category)
      || !validUtcDay(f.day)
      || !valid(f.bytes) || f.bytes === 0 || f.bytes > WATCH_CAPACITY_POLICY.maxFileBytes
      || f.day > nowUtcDay || seen.has(f.category+':'+f.day))
      throw new Error('WATCH_CAPACITY_FILE_INVALID');
    seen.add(f.category+':'+f.day);
    sizeByDate.set(f.day,(sizeByDate.get(f.day)??0)+f.bytes);
  }
  const ordered=[...sizeByDate.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  // Do not turn a single quiet day or a sparse, intermittently running worker
  // into a "healthy" multi-month capacity forecast. Require the last seven
  // CONSECUTIVE completed UTC dates; absence is UNKNOWN, never zero usage.
  const todayMs = Date.parse(nowUtcDay + 'T00:00:00Z');
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(todayMs - (7 - i) * 86_400_000).toISOString().slice(0,10));
  const observedCompletedDays = days.filter(d => sizeByDate.has(d)).length;
  const sevenDayHistoryComplete = observedCompletedDays === 7;
  const mean = sevenDayHistoryComplete
    ? Math.ceil(days.reduce((sum, day) => sum + sizeByDate.get(day), 0) / 7)
    : null;
  const remaining=Math.max(0,diskFreeBytes-WATCH_CAPACITY_POLICY.diskFloorBytes);
  const projectedDays=mean && mean>0?Math.floor(remaining/mean):null;
  return Object.freeze({
    contract:WATCH_CAPACITY_CONTRACT,
    status:diskFreeBytes<=WATCH_CAPACITY_POLICY.diskFloorBytes?'HOLD_LOW_DISK'
      :!sevenDayHistoryComplete?'INSUFFICIENT_HISTORY'
      :projectedDays!==null && projectedDays<7?'HOLD_CAPACITY_RISK':'OBSERVATION_ONLY',
    fileCount:files.length, datedDayCount:ordered.length,
    totalTrackedBytes:ordered.reduce((n,[,bytes])=>n+bytes,0),
    lastSevenCompletedDaysAverageBytes:mean,
    observedCompletedDays, sevenDayHistoryComplete,
    diskFreeBytes, reservedDiskFloorBytes:WATCH_CAPACITY_POLICY.diskFloorBytes,
    projectedDaysAboveFloor:projectedDays,
    retentionApplied:false, archiveVerified:false, deletionAllowed:false,
    continuous24hProven:false, profitabilityProven:false,
    executionAuthority:'NONE',
  });
}

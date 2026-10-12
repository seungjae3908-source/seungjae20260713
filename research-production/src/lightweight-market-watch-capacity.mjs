// Research-only storage budget projection; never archives/deletes files.
export const WATCH_CAPACITY_CONTRACT = 'public-watch-capacity-planning-v1';
export const WATCH_CAPACITY_POLICY = Object.freeze({
  diskFloorBytes: 5 * 1024 ** 3,
  maxFileBytes: 64 * 1024 ** 2,
  maxDays: 366,
  categories: ['events', 'outcomes', 'cadence', 'capped'],
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
  if (!Array.isArray(files)
    || files.length > WATCH_CAPACITY_POLICY.maxDays * WATCH_CAPACITY_POLICY.categories.length
    || !valid(diskFreeBytes) || !validUtcDay(nowUtcDay))
    throw new Error('WATCH_CAPACITY_INPUT_INVALID');
  const seen = new Set(), sizeByDate = new Map(), cadenceDays = new Set();
  for(const f of files) {
    if (!f || !WATCH_CAPACITY_POLICY.categories.includes(f.category)
      || !validUtcDay(f.day)
      || !valid(f.bytes) || f.bytes === 0 || f.bytes > WATCH_CAPACITY_POLICY.maxFileBytes
      || f.day > nowUtcDay || seen.has(f.category+':'+f.day))
      throw new Error('WATCH_CAPACITY_FILE_INVALID');
    seen.add(f.category+':'+f.day);
    sizeByDate.set(f.day,(sizeByDate.get(f.day)??0)+f.bytes);
    if (f.category === 'cadence') cadenceDays.add(f.day);
  }
  const ordered=[...sizeByDate.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  // A discovery/outcome event day does NOT prove the watch was even running.
  // Require actual cadence-file presence on all seven completed UTC dates;
  // file presence is still not proof of independently attested 24h uptime.
  // Missing days are UNKNOWN, never counted as zero-byte days.
  const todayMs = Date.parse(nowUtcDay + 'T00:00:00Z');
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(todayMs - (7 - i) * 86_400_000).toISOString().slice(0,10));
  const observedCompletedDays = days.filter(d => sizeByDate.has(d)).length;
  const cadenceCompletedDays = days.filter(d => cadenceDays.has(d)).length;
  const sevenDayHistoryComplete = observedCompletedDays === 7 && cadenceCompletedDays === 7;
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
    observedCompletedDays, cadenceCompletedDays, sevenDayHistoryComplete,
    diskFreeBytes, reservedDiskFloorBytes:WATCH_CAPACITY_POLICY.diskFloorBytes,
    projectedDaysAboveFloor:projectedDays,
    retentionApplied:false, archiveVerified:false, deletionAllowed:false,
    continuous24hProven:false, profitabilityProven:false,
    executionAuthority:'NONE',
  });
}

/**
 * Regular-session start calendar for the stock source verifier.
 *
 * It lists the START of each regular session (KRX 09:00 Asia/Seoul, US 09:30
 * America/New_York, DST aware) on weekdays that are not in the owner-supplied
 * holiday list. It never guesses holidays: without an explicit `holidays`
 * array it returns no sessions, so the verifier HOLDs instead of silently
 * accepting a calendar that may include closed days. Session ENDS (early
 * closes) come from the archive, not from here.
 *
 * Pure and read-only. It does not prove that the listed sessions are complete
 * in the archive; the verifier checks that.
 */
export const EXCHANGE_SESSION_CALENDAR_CONTRACT_V1 = 'research-exchange-session-calendar/v1';

const DAY_MS = 86_400_000;
const MINUTE = 60_000;
const MAX_DAYS = 800;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

const EXCHANGES = Object.freeze({
  KR_STOCK: Object.freeze({ zone: 'Asia/Seoul', hour: 9, minute: 0, sessionMinutes: 390 }),
  US_STOCK: Object.freeze({ zone: 'America/New_York', hour: 9, minute: 30, sessionMinutes: 390 }),
});

function localParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')), minute: Number(get('minute')), weekday: get('weekday'),
  };
}

/** UTC ms of local `hour:minute` on `date` (YYYY-MM-DD) in `zone`, or null when that wall time does not exist. */
function zonedStartMs(date, zone, hour, minute) {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, hour, minute);
  // The zone offset is within ±14h; try each whole-hour offset and keep the exact wall-time match.
  for (let offsetH = -14; offsetH <= 14; offsetH += 1) {
    const candidate = base - offsetH * 3_600_000;
    const local = localParts(candidate, zone);
    if (local.date === date && local.hour === hour && local.minute === minute) return candidate;
  }
  return null;
}

/**
 * @returns {(args: {market: string, periodStartMs: number, periodEndMs: number}) => number[]}
 */
export function createExchangeSessionCalendarV1({ holidays } = {}) {
  const holidaySet = Array.isArray(holidays) && holidays.every((v) => typeof v === 'string' && DATE.test(v))
    ? new Set(holidays) : null;
  return ({ market, periodStartMs, periodEndMs }) => {
    const config = Object.prototype.hasOwnProperty.call(EXCHANGES, market) ? EXCHANGES[market] : null;
    if (!config || holidaySet === null) return [];
    if (!Number.isSafeInteger(periodStartMs) || !Number.isSafeInteger(periodEndMs) || periodStartMs >= periodEndMs) return [];
    if ((periodEndMs - periodStartMs) / DAY_MS > MAX_DAYS) return [];
    const starts = [];
    const firstDay = Math.floor((periodStartMs - DAY_MS) / DAY_MS) * DAY_MS;
    for (let day = firstDay; day <= periodEndMs + DAY_MS; day += DAY_MS) {
      const date = localParts(day + 12 * 3_600_000, config.zone).date;
      const startMs = zonedStartMs(date, config.zone, config.hour, config.minute);
      if (startMs === null || holidaySet.has(date)) continue;
      const { weekday } = localParts(startMs, config.zone);
      if (weekday === 'Sat' || weekday === 'Sun') continue;
      if (startMs + config.sessionMinutes * MINUTE <= periodStartMs || startMs >= periodEndMs) continue;
      if (!starts.includes(startMs)) starts.push(startMs);
    }
    return starts.sort((a, b) => a - b);
  };
}

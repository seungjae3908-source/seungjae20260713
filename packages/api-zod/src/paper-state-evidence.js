// Pure transport/storage guards shared by the API and browser. No numeric coercion.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const nonnegative = (value) => finite(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 4000);
const oneOf = (value, values) => values.includes(value);
const fields = (value, keys, guard) => keys.split(' ').every((key) => guard(value[key]));
const optionalPrice = (value) => value == null || positive(value);
const side = (value) => oneOf(value, ['long', 'short']);
const symbol = (value) => typeof value === 'string' && /^[A-Z0-9]{2,20}$/.test(value);
const orderType = (value) => oneOf(value, ['market', 'limit', 'stop_market']);
const positionStatus = (value) => oneOf(value, ['open', 'partially_closed', 'closed']);
const fillReason = (value) => oneOf(value, ['market', 'limit', 'stop_trigger', 'stop_loss', 'take_profit', 'partial_close', 'manual_close']);

function instant(value, latest) {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const offsetHours = parts[7] === 'Z' ? 0 : Number(parts[7].slice(1, 3));
  const offsetMinutes = parts[7] === 'Z' ? 0 : Number(parts[7].slice(4, 6));
  const time = Date.parse(value);
  return year >= 1970 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHours <= 14 && offsetMinutes <= 59
    && (offsetHours !== 14 || offsetMinutes === 0) && Number.isFinite(time) && time > 0 && time <= latest;
}

function period(start, end, latest, nullableEnd = false) {
  return instant(start, latest) && (nullableEnd && end === null || instant(end, latest) && Date.parse(start) <= Date.parse(end));
}

export function validPaperTimestamp(value, latest = Infinity) { return instant(value, latest); }

function safeTree(value, depth = 0, seen = new Set()) {
  if (depth > 30 || typeof value === 'number' && !finite(value)) return false;
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const entries = Object.entries(value);
  const valid = entries.every(([key, child]) => !/(?:api.?key|secret|authorization|bearer|access.?token|refresh.?token|private.?key)/i.test(key)
    && safeTree(child, depth + 1, seen));
  seen.delete(value);
  return valid;
}

function rows(value, guard) {
  return Array.isArray(value) && value.length <= 10000 && value.every(guard)
    && new Set(value.map((row) => row.id)).size === value.length;
}

function order(value, latest) {
  if (!record(value) || !text(value.id) || !symbol(value.symbol) || !side(value.side) || !orderType(value.orderType)
    || !oneOf(value.status, ['pending', 'filled', 'cancelled', 'rejected', 'expired'])
    || value.mode !== 'paper-only' || value.orderSubmitted !== false || value.exchangeRequestSent !== false
    || !fields(value, 'leverage stopLossPrice', positive) || !(value.status === 'rejected' ? nonnegative(value.quantity) : positive(value.quantity))
    || !fields(value, 'requestedPrice triggerPrice takeProfitPrice1 takeProfitPrice2', optionalPrice)
    || !strings(value.rejectionCodes) || !strings(value.warnings)
    || !period(value.submittedAt, value.filledAt, latest, true) || !period(value.submittedAt, value.cancelledAt, latest, true)) return false;
  if (value.status === 'filled' && value.filledAt === null || value.status === 'cancelled' && value.cancelledAt === null) return false;
  if (value.riskResult === null) return true;
  return record(value.riskResult) && typeof value.riskResult.allowed === 'boolean'
    && strings(value.riskResult.blockCodes) && strings(value.riskResult.warnings)
    && (value.riskResult.estimatedLiquidationPrice === null || positive(value.riskResult.estimatedLiquidationPrice));
}

function position(value, latest) {
  return record(value) && fields(value, 'id orderId', text) && symbol(value.symbol) && side(value.side) && positionStatus(value.status)
    && fields(value, 'entryPrice currentPrice quantity leverage stopLossPrice', positive)
    && fields(value, 'remainingQuantity notionalValue requiredMargin totalFees totalSlippage', nonnegative)
    && fields(value, 'unrealizedPnl realizedPnl totalFunding', finite)
    && fields(value, 'takeProfitPrice1 takeProfitPrice2', optionalPrice) && strings(value.warnings)
    && value.remainingQuantity <= value.quantity && (value.status === 'closed' ? value.remainingQuantity === 0 && value.closedAt !== null : value.remainingQuantity > 0)
    && period(value.openedAt, value.closedAt, latest, true);
}

function fill(value, latest) {
  return record(value) && fields(value, 'id orderId positionId', text) && side(value.side) && fillReason(value.fillReason)
    && fields(value, 'price quantity grossValue referencePrice', positive) && fields(value, 'fee slippageCost', nonnegative)
    && fields(value, 'fundingCost grossPnl netPnl', finite) && instant(value.filledAt, latest);
}

export function validPaperRecord(kind, value, latest = Infinity) {
  if (!record(value) || !safeTree(value)) return false;
  if (kind === 'account') return text(value.id) && positive(value.initialBalance)
    && fields(value, 'cashBalance realizedPnl unrealizedPnl equity usedMargin availableMargin', finite)
    && nonnegative(value.usedMargin) && period(value.createdAt, value.updatedAt, latest);
  if (kind === 'order') return order(value, latest);
  if (kind === 'position') return position(value, latest);
  if (kind === 'fill') return fill(value, latest);
  if (kind === 'journal') return validPaperJournal(value, latest);
  return false;
}

export function validPaperJournal(value, latest = Infinity) {
  return record(value) && safeTree(value) && fields(value, 'id tradeId orderId positionId', text) && symbol(value.symbol) && side(value.side) && orderType(value.orderType)
    && fields(value, 'strategyName marketRegimeAtEntry', text) && positionStatus(value.status)
    && fields(value, 'entryPrice stopLossPrice initialQuantity leverage', positive)
    && fields(value, 'closedQuantity remainingQuantity notionalValue requiredMargin entryFee exitFee slippageCost', nonnegative)
    && fields(value, 'fundingCost grossPnl netPnl', finite) && (value.rMultiple === null || finite(value.rMultiple))
    && fields(value, 'takeProfitPrice1 takeProfitPrice2 exitPrice', optionalPrice)
    && (value.exitReason === null || fillReason(value.exitReason)) && typeof value.riskBlocked === 'boolean' && typeof value.ruleViolation === 'boolean'
    && typeof value.note === 'string' && value.note.length <= 100000 && strings(value.warnings)
    && oneOf(value.dataStatusAtEntry, ['live', 'delayed', 'stale', 'unavailable', 'partial'])
    && value.closedQuantity <= value.initialQuantity && value.remainingQuantity <= value.initialQuantity
    && (value.status !== 'closed' || value.remainingQuantity === 0 && value.closedAt !== null)
    && period(value.submittedAt, value.filledAt, latest) && period(value.filledAt, value.closedAt, latest, true);
}

export function validPaperState(value, latest = Infinity) {
  if (!record(value) || !safeTree(value) || value.schemaVersion !== 1 || !record(value.account) || !record(value.riskState)) return false;
  const account = value.account;
  const risk = value.riskState;
  return text(account.id) && positive(account.initialBalance)
    && fields(account, 'cashBalance realizedPnl unrealizedPnl equity usedMargin availableMargin', finite)
    && nonnegative(account.usedMargin)
    && period(account.createdAt, account.updatedAt, latest) && period(value.createdAt, value.updatedAt, latest)
    && typeof risk.dayKey === 'string' && typeof risk.weekKey === 'string'
    && fields(risk, 'dailyRealizedPnl weeklyRealizedPnl', finite) && Number.isSafeInteger(risk.consecutiveLosses) && risk.consecutiveLosses >= 0
    && strings(value.processedEventIds) && value.processedEventIds.length <= 10000 && value.processedEventIds.every(text)
    && new Set(value.processedEventIds).size === value.processedEventIds.length
    && rows(value.orders, (row) => order(row, latest)) && rows(value.positions, (row) => position(row, latest))
    && rows(value.fills, (row) => fill(row, latest)) && rows(value.journal, (row) => validPaperJournal(row, latest));
}

function same(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => same(value, right[index]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]));
}

export function validPaperActionResult(value, previous, eventId, latest = Infinity) {
  if (!record(value) || value.ok !== true || value.mode !== 'paper-only' || value.orderSubmitted !== false || value.exchangeRequestSent !== false
    || typeof value.duplicateEvent !== 'boolean' || !strings(value.warnings) || !validPaperState(value.state, latest)
    || !validPaperState(previous, latest) || value.state.account.id !== previous.account.id || !value.state.processedEventIds.includes(eventId)
    || value.state.account.initialBalance !== previous.account.initialBalance || value.state.account.createdAt !== previous.account.createdAt
    || value.state.createdAt !== previous.createdAt || Date.parse(value.state.updatedAt) < Date.parse(previous.updatedAt)
    || value.duplicateEvent !== previous.processedEventIds.includes(eventId)) return false;
  const expectedEvents = value.duplicateEvent ? previous.processedEventIds : [...previous.processedEventIds, eventId].slice(-500);
  if (!same(value.state.processedEventIds, expectedEvents)) return false;
  if (value.duplicateEvent && !same(value.state, previous)) return false;
  for (const key of ['orders', 'positions', 'fills', 'journal']) {
    if (!Array.isArray(previous[key]) || !previous[key].every((row) => value.state[key].some((next) => next.id === row.id))) return false;
  }
  const matches = (row, key) => row === null || record(row) && value.state[key].some((candidate) => same(candidate, row));
  return matches(value.order, 'orders') && matches(value.position, 'positions') && Array.isArray(value.fills)
    && value.fills.every((row) => record(row) && matches(row, 'fills'));
}

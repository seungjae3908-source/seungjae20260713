export class PaperLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaperLifecycleError";
    this.code = code;
  }
}

const FILLABLE_STATES = new Set(["ACCEPTED", "PARTIALLY_FILLED"]);
const BUY_LIKE = new Set(["BUY", "LONG"]);
const SELL_LIKE = new Set(["SELL", "SHORT"]);
const EPSILON = 1e-12;

function positive(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new PaperLifecycleError(code, message);
  return number;
}

function observedAt(value) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    throw new PaperLifecycleError("INVALID_PAPER_FILL_TIME", "paper fill requires a valid observedAt timestamp");
  }
  return new Date(parsed).toISOString();
}

function validateLimitFill(order, fillPrice) {
  if (String(order.intent?.orderType ?? "").toUpperCase() !== "LIMIT") return;
  const limitPrice = positive(
    order.intent?.limitPrice,
    "INVALID_PAPER_LIMIT_PRICE",
    "Paper LIMIT order requires a positive limitPrice",
  );
  const side = String(order.intent?.side ?? "").toUpperCase();
  if (BUY_LIKE.has(side) && fillPrice > limitPrice + EPSILON) {
    throw new PaperLifecycleError(
      "PAPER_FILL_LIMIT_VIOLATION",
      "BUY/LONG Paper fill cannot be worse than the limit price",
    );
  }
  if (SELL_LIKE.has(side) && fillPrice < limitPrice - EPSILON) {
    throw new PaperLifecycleError(
      "PAPER_FILL_LIMIT_VIOLATION",
      "SELL/SHORT Paper fill cannot be worse than the limit price",
    );
  }
  if (!BUY_LIKE.has(side) && !SELL_LIKE.has(side)) {
    throw new PaperLifecycleError("INVALID_PAPER_FILL_SIDE", "Paper fill side is unsupported");
  }
}

export function applyPaperFillTransition(order, fill) {
  if (!order || typeof order !== "object" || order.simulated !== true) {
    throw new PaperLifecycleError("PAPER_ORDER_REQUIRED", "partial-fill lifecycle accepts simulated Paper orders only");
  }
  if (!FILLABLE_STATES.has(order.status)) {
    throw new PaperLifecycleError(
      "INVALID_PAPER_FILL_TRANSITION",
      `paper fill cannot be applied from ${order.status ?? "UNKNOWN"}`,
    );
  }

  const totalQuantity = positive(
    order.intent?.quantity,
    "INVALID_PAPER_ORDER_QUANTITY",
    "paper order quantity must be positive",
  );
  const priorFilled = Number(order.filledQuantity ?? 0);
  if (!Number.isFinite(priorFilled) || priorFilled < 0 || priorFilled > totalQuantity) {
    throw new PaperLifecycleError("INVALID_PAPER_FILL_STATE", "existing filled quantity is invalid");
  }

  const fillQuantity = positive(fill?.quantity, "INVALID_PAPER_FILL_QUANTITY", "paper fill quantity must be positive");
  const fillPrice = positive(fill?.price, "INVALID_PAPER_FILL_PRICE", "paper fill price must be positive");
  validateLimitFill(order, fillPrice);

  const remainingBefore = totalQuantity - priorFilled;
  if (fillQuantity > remainingBefore + EPSILON) {
    throw new PaperLifecycleError("PAPER_OVERFILL_REJECTED", "paper fill cannot exceed remaining quantity");
  }

  const nextFilledRaw = priorFilled + fillQuantity;
  const nextFilled = Math.abs(nextFilledRaw - totalQuantity) <= EPSILON ? totalQuantity : nextFilledRaw;
  const remainingQuantity = Math.max(0, totalQuantity - nextFilled);
  const priorAverage = order.averageFillPrice == null ? null : Number(order.averageFillPrice);
  const priorNotional = priorFilled > 0 && Number.isFinite(priorAverage) ? priorFilled * priorAverage : 0;
  const averageFillPrice = (priorNotional + fillQuantity * fillPrice) / nextFilled;
  const priorEvidence = Array.isArray(order.paperFillEvidence) ? order.paperFillEvidence : [];
  if (priorEvidence.length >= 100) {
    throw new PaperLifecycleError("PAPER_FILL_EVIDENCE_LIMIT", "paper fill evidence is capped at 100 events");
  }

  const fillEvent = Object.freeze({
    sequence: priorEvidence.length + 1,
    quantity: fillQuantity,
    price: fillPrice,
    observedAt: observedAt(fill?.observedAt),
    source: "PAPER_SIMULATION_ONLY",
    realExchangeFill: false,
  });

  return Object.freeze({
    ...order,
    status: remainingQuantity === 0 ? "FILLED" : "PARTIALLY_FILLED",
    filledQuantity: nextFilled,
    remainingQuantity,
    averageFillPrice,
    paperFillEvidence: Object.freeze([...priorEvidence, fillEvent]),
    realOrderSubmitted: false,
    privateTradingRequestSent: false,
    actualExchangeFillEvidence: null,
  });
}

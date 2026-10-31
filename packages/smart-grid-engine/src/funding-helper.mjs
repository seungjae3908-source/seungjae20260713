/**
 * Bitget Perpetual Funding Cost Calculation
 * 
 * Rate Rules:
 *   rate > 0: LONG pays SHORT. Long cost = +notional*rate, Short cost = -notional*rate
 *   rate < 0: SHORT pays LONG. Short cost = +notional*|rate|, Long cost = -notional*|rate|
 * 
 * Convention: "cost" = amount DEDUCTED from strategy PnL (positive = loss)
 * 
 * @param {string} side - 'LONG' | 'SHORT'
 * @param {number} notionalUsdt - position notional at funding time (price * qty)
 * @param {number} rate - funding rate (signed, e.g., 0.0001 = 0.01%)
 * @returns {number} cost in USDT (positive = paid, negative = received)
 */
export function computeFundingCost(side, notionalUsdt, rate) {
  if (side === 'LONG') {
    return notionalUsdt * rate;  // positive rate → long pays, negative rate → long receives
  } else if (side === 'SHORT') {
    return -notionalUsdt * rate; // positive rate → short receives, negative rate → short pays
  }
  return 0;
}

/**
 * Test cases for verification:
 * computeFundingCost('LONG', 1000, 0.0001) = +0.10 USDT (LONG pays)
 * computeFundingCost('SHORT', 1000, 0.0001) = -0.10 USDT (SHORT receives)
 * computeFundingCost('LONG', 1000, -0.0001) = -0.10 USDT (LONG receives)
 * computeFundingCost('SHORT', 1000, -0.0001) = +0.10 USDT (SHORT pays)
 */

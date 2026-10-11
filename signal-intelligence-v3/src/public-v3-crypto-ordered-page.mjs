/**
 * V3-only (zero trading authority) canonical pagination over public crypto
 * tickers. Normal member search and Paper retain trading-volume ranking.
 * Identity input stays in memory and never appears in diagnostics.
 */
export function stablePublicV3CryptoRows(rows){
  if(!Array.isArray(rows)||rows.length===0||rows.some(r=>
    typeof r?.symbol!=='string'
    ||!/^[A-Z0-9][A-Z0-9._-]{0,39}$/u.test(r.symbol)))
    throw new Error('PUBLIC_V3_CRYPTO_ROSTER_INVALID');
  if(new Set(rows.map(r=>r.symbol)).size!==rows.length)
    throw new Error('PUBLIC_V3_CRYPTO_ROSTER_DUPLICATE');
  return [...rows].sort((a,b)=>a.symbol<b.symbol?-1:a.symbol>b.symbol?1:0);
}

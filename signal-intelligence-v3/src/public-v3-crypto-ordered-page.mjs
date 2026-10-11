/**
 * V3-only (zero trading authority) canonical pagination over public crypto
 * tickers. Normal member search and Paper retain trading-volume ranking.
 * Identity input stays in memory and never appears in diagnostics.
 */
export function stablePublicV3CryptoRows(rows){
  if(!Array.isArray(rows)||rows.length===0||rows.some(r=>
    typeof r?.symbol!=='string'
    ||r.symbol.length===0||r.symbol.length>128||r.symbol.trim()!==r.symbol
    ||/[\u0000-\u001F\u007F]/u.test(r.symbol)))
    throw new Error('PUBLIC_V3_CRYPTO_ROSTER_INVALID');
  if(new Set(rows.map(r=>r.symbol)).size!==rows.length)
    throw new Error('PUBLIC_V3_CRYPTO_ROSTER_DUPLICATE');
  return [...rows].sort((a,b)=>a.symbol<b.symbol?-1:a.symbol>b.symbol?1:0);
}

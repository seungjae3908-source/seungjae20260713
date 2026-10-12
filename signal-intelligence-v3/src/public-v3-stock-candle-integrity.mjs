/**
 * V3-only Yahoo candle PAGE integrity, before evaluating data quality.
 * This rejects broken source payloads, never reconstructs absent bars and
 * does NOT authorize a scanner signal, trade, Paper or profitability PASS.
 */
const ISO_WITH_OFFSET=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
export function validV3PublicYahooCandlePage(rows,{nowMs=Date.now()}={}){
  if(!Array.isArray(rows)||rows.length<1||rows.length>16000
    ||!Number.isSafeInteger(nowMs)||nowMs<=0)return false;
  let previous=0;
  for(const bar of rows){
    if(!bar||typeof bar!=='object'||Array.isArray(bar)
      ||typeof bar.time!=='string'||!ISO_WITH_OFFSET.test(bar.time))
      return false;
    const at=Date.parse(bar.time);
    if(!Number.isSafeInteger(at)||at<=previous||at>nowMs+5000)
      return false;
    const {open,high,low,close,volume}=bar;
    if(![open,high,low,close].every(positive)
      ||high<Math.max(open,low,close)
      ||low>Math.min(open,high,close)
      ||typeof volume!=='number'||!Number.isFinite(volume)||volume<0)
      return false;
    previous=at;
  }
  return true;
}

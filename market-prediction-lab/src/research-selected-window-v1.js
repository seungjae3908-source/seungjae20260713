/**
 * Historical research window requested by the user; never a fixed 3-year
 * collection limit. The old 2023-09-26 .. 2026-09-25 window is preserved ONLY
 * as a backwards-compatible example/default regression scope.
 *
 * A date selection never certifies that an exchange was open, that source
 * history was complete, or that a strategy would have made a profit.
 */
export const UTC_DAY_MS_V1=86_400_000;
export const RESEARCH_WINDOW_MAX_UTC_DAYS_V1=36_600;
export const LEGACY_THREE_YEAR_SAMPLE_WINDOW_V1=Object.freeze({
 startDate:"2023-09-26",endDate:"2026-09-25",
});
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const MIN_MS=Date.parse("1970-01-02T00:00:00.000Z");
const MAX_MS=Date.parse("2100-01-01T00:00:00.000Z");
function parseDay(v){
 if(typeof v!=="string"||!DATE.test(v))return null;
 const n=Date.parse(v+"T00:00:00.000Z");
 return Number.isSafeInteger(n)&&n>=MIN_MS&&n<MAX_MS
   &&new Date(n).toISOString().slice(0,10)===v?n:null;
}
export function isValidHistoricalUtcDayV1(ms){
 return Number.isSafeInteger(ms)&&ms>=MIN_MS&&ms<MAX_MS
   &&ms%UTC_DAY_MS_V1===0;
}
export function resolveSelectedResearchWindowV1(input=null){
 const explicit=input!==null&&input!==undefined;
 const value=explicit?input:LEGACY_THREE_YEAR_SAMPLE_WINDOW_V1;
 if(!value||typeof value!=="object"||Array.isArray(value)
    ||Object.keys(value).some(k=>!["startDate","endDate"].includes(k)))
   throw new TypeError("RESEARCH_WINDOW_START_END_REQUIRED");
 const startMs=parseDay(value.startDate),endMs=parseDay(value.endDate);
 if(startMs==null||endMs==null||endMs<startMs)
   throw new TypeError("RESEARCH_WINDOW_DATES_INVALID");
 const count=(endMs-startMs)/UTC_DAY_MS_V1+1;
 if(!Number.isSafeInteger(count)||count<1||
    count>RESEARCH_WINDOW_MAX_UTC_DAYS_V1)
   throw new RangeError("RESEARCH_WINDOW_EXCEEDS_BOUNDED_DAY_LIMIT");
 return Object.freeze({
  startDate:value.startDate,endDate:value.endDate,
  startMs,endInclusiveMs:endMs,
  endExclusiveMs:endMs+UTC_DAY_MS_V1,
  requestedUtcDayCount:count,
  selectedByUser:explicit,
  selectionMode:explicit?"USER_SELECTED":"LEGACY_THREE_YEAR_EXAMPLE",
 });
}
export function selectedCryptoUtcDaysV1(researchWindow=null){
 const period=resolveSelectedResearchWindowV1(researchWindow);
 const dates=Array.from({length:period.requestedUtcDayCount},
   (_,i)=>period.startMs+i*UTC_DAY_MS_V1);
 return Object.freeze({
  CRYPTO_SPOT:Object.freeze([...dates]),
  CRYPTO_FUTURES:Object.freeze([...dates]),
 });
}

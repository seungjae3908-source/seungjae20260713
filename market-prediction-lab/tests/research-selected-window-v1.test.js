import test from "node:test";
import assert from "node:assert/strict";
import {
 resolveSelectedResearchWindowV1 as resolve,
 selectedCryptoUtcDaysV1 as dates,
 RESEARCH_WINDOW_MAX_UTC_DAYS_V1 as MAX_DAYS,
} from "../src/research-selected-window-v1.js";

const DAY=86_400_000;
test("the old three years are a default TEST EXAMPLE, not a mandatory limit",()=>{
 const old=resolve();
 assert.equal(old.selectionMode,"LEGACY_THREE_YEAR_EXAMPLE");
 assert.equal(old.selectedByUser,false);
 assert.equal(old.requestedUtcDayCount,1096);
 assert.equal(old.startDate,"2023-09-26");
 assert.equal(old.endDate,"2026-09-25");
 assert.equal(dates().CRYPTO_SPOT.length,1096);
});
test("a selected leap-year, one-day, and ten-year range are valid",()=>{
 const leap=resolve({startDate:"2020-02-27",endDate:"2020-03-02"});
 assert.equal(leap.requestedUtcDayCount,5);
 assert.equal(leap.selectionMode,"USER_SELECTED");
 assert.equal(leap.endExclusiveMs-leap.startMs,5*DAY);
 const span=dates({startDate:"2020-02-27",endDate:"2020-03-02"});
 assert.equal(span.CRYPTO_SPOT.length,5);
 assert.deepEqual(span.CRYPTO_SPOT,span.CRYPTO_FUTURES);
 assert.equal(new Date(span.CRYPTO_SPOT[2]).toISOString().slice(0,10),
   "2020-02-29");
 const one=resolve({startDate:"2026-01-07",endDate:"2026-01-07"});
 assert.equal(one.requestedUtcDayCount,1);
 const decade=resolve({startDate:"2016-01-01",endDate:"2025-12-31"});
 assert.ok(decade.requestedUtcDayCount>3650);
 assert.ok(decade.requestedUtcDayCount<MAX_DAYS);
});
test("a range outside original sample (past or future) is allowed without inventing data",()=>{
 const old=resolve({startDate:"2005-01-01",endDate:"2005-01-31"});
 assert.equal(old.requestedUtcDayCount,31);
 const later=resolve({startDate:"2027-01-01",endDate:"2027-01-02"});
 assert.equal(later.requestedUtcDayCount,2);
});
test("bad dates, missing end/start, inverted or oversized spans are rejected",()=>{
 for(const options of [
  {startDate:"2025-02-30",endDate:"2025-03-01"},
  {startDate:"2025-04-01",endDate:"2025-03-31"},
  {startDate:"2025-01-01"},
  {endDate:"2025-01-01"},
  {startDate:"1970-01-02",endDate:"2099-12-31"},
  {startDate:"2025-02-01",endDate:"2025-02-02",unknown:true},
 ]){
  assert.throws(()=>resolve(options),/RESEARCH_WINDOW/);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {selectClosedV3PublicStockBars} from '../src/public-v3-stock-closed-bars.mjs';
const row=(time,price=100)=>({time,open:price,high:price+1,low:price-1,close:price,volume:10});
test('KR V3 daily intraday forming price bar is never used as a settled daily bar',()=>{
 const previous=row('2026-10-09T00:00:00.000Z');
 const monday=row('2026-10-12T00:00:00.000Z');
 const prices=[previous,monday];
 const filtered=selectClosedV3PublicStockBars(prices,{
   market:'KR_STOCK',timeframe:'1D',nowMs:Date.parse('2026-10-12T02:05:58Z'),
 });
 assert.deepEqual(filtered,[previous]);
 assert.equal(prices.length,2,'raw provider data is never mutated');
 assert.deepEqual(selectClosedV3PublicStockBars(prices,{
   market:'KR_STOCK',timeframe:'1D',nowMs:Date.parse('2026-10-12T06:30:00Z'),
 }),prices,'at 15:30 KST today is a completed session bar');
});
test('US stock daily close respects America/New_York DST and evening closure',()=>{
 const yesterday=row('2026-10-09T13:30:00Z');
 const monday=row('2026-10-12T13:30:00Z');
 const prices=[yesterday,monday];
 assert.deepEqual(selectClosedV3PublicStockBars(prices,{
   market:'US_STOCK',timeframe:'1D',nowMs:Date.parse('2026-10-12T15:20:00Z'),
 }),[yesterday],'11:20 AM EDT stock daily candle is forming');
 assert.deepEqual(selectClosedV3PublicStockBars(prices,{
   market:'US_STOCK',timeframe:'1D',nowMs:Date.parse('2026-10-12T20:00:00Z'),
 }),prices,'4:00 PM EDT may use the regular session close');
});
test('only trailing partial 15m/60m Yahoo observations can be removed',()=>{
 const prior=row('2026-10-12T01:00:00Z');
 const forming=row('2026-10-12T01:15:00Z');
 assert.deepEqual(selectClosedV3PublicStockBars([prior,forming],{
   market:'KR_STOCK',timeframe:'15m',nowMs:Date.parse('2026-10-12T01:23:00Z'),
 }),[prior]);
 assert.deepEqual(selectClosedV3PublicStockBars([prior,forming],{
   market:'KR_STOCK',timeframe:'15m',nowMs:Date.parse('2026-10-12T01:30:00Z'),
 }),[prior,forming]);
 assert.deepEqual(selectClosedV3PublicStockBars([prior,forming],{
   market:'KR_STOCK',timeframe:'60m',nowMs:Date.parse('2026-10-12T01:45:00Z'),
 }),[],'both hourly candles are still open, no fabricated close');
});
test('missing/invalid/future bars remain invalid for the separate strict source gate',()=>{
 const future=row('2026-10-12T09:00:00Z');
 assert.deepEqual(selectClosedV3PublicStockBars([future],{
   market:'KR_STOCK',timeframe:'1D',nowMs:Date.parse('2026-10-12T03:00:00Z'),
 }),[future],'a future-dated bar must not be hidden by the closed-bar selector');
 const invalid=row('UNKNOWN');
 assert.deepEqual(selectClosedV3PublicStockBars([invalid],{
   market:'KR_STOCK',timeframe:'15m',nowMs:Date.parse('2026-10-12T03:00:00Z'),
 }),[invalid]);
 assert.deepEqual(selectClosedV3PublicStockBars(null,{
   market:'US_STOCK',timeframe:'1D',nowMs:Date.parse('2026-10-12T03:00:00Z'),
 }),null);
 assert.throws(()=>selectClosedV3PublicStockBars([],{
   market:'CRYPTO_FUTURES',timeframe:'1D',
 }),/CONFIG_INVALID/);
});

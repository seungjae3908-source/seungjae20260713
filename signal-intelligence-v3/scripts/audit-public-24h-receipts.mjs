#!/usr/bin/env node
// OFFLINE, READ-ONLY audit of an existing sanitized local receipt log.
// No provider GET, private API, orders, runtime activation, DB or secrets.
// This reads a bounded tail and cannot attest actual server 24h uptime.
import {open} from 'node:fs/promises';
import path from 'node:path';
import {auditPublicReadOnly24hReceiptWindow} from '../src/public-runtime-receipt-window.mjs';

const file=process.argv[2]??'';
const sha=process.argv[3]??'';
const asOf=process.argv[4]??null;
const TAIL_BYTES=2*1024*1024;
try {
 if(!path.isAbsolute(file)||path.basename(file)!=='public-readonly-runtime-receipts.jsonl'
   ||!/^[a-f0-9]{40}$/u.test(sha)
   ||(asOf!==null&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(asOf)
     ||!Number.isSafeInteger(Date.parse(asOf)))))
   throw Error('PUBLIC_RECEIPT_INPUT_INVALID');
 const handle=await open(file,'r');
 let data;
 try {
   const stat=await handle.stat();
   if(!stat.isFile()||stat.size<2)throw Error('PUBLIC_RECEIPT_LOG_EMPTY');
   const start=Math.max(0,stat.size-TAIL_BYTES);
   const size=stat.size-start;
   const buffer=Buffer.alloc(size);
   const {bytesRead}=await handle.read(buffer,0,size,start);
   if(bytesRead!==size)throw Error('PUBLIC_RECEIPT_CONCURRENT_WRITE');
   data=buffer.toString('utf8');
   // A bounded tail may start inside a JSON line: discard only that
   // partial boundary. Never discard a malformed complete receipt.
   if(start>0){
     const firstNewline=data.indexOf('\n');
     if(firstNewline<0)throw Error('PUBLIC_RECEIPT_TAIL_MISSING_BOUNDARY');
     data=data.slice(firstNewline+1);
   }
 }finally{await handle.close();}
 if(!data.endsWith('\n'))throw Error('PUBLIC_RECEIPT_LAST_LINE_INCOMPLETE');
 const rows=data.slice(0,-1).split('\n');
 if(!rows.length||rows.some(line=>line.length===0||line.length>4096))
   throw Error('PUBLIC_RECEIPT_ROW_INVALID');
 // The worker allows at most one run each minute; last 1500 rows can cover
 // the 24h window at its documented maximum cadence.
 const selected=rows.slice(-1500).map(line=>{
   try{return JSON.parse(line);}
   catch{throw Error('PUBLIC_RECEIPT_JSON_INVALID');}
 });
 const evidence=auditPublicReadOnly24hReceiptWindow({
   observations:selected,serviceSha:sha,asOfMs:asOf?Date.parse(asOf):Date.now(),
 });
 process.stdout.write(JSON.stringify(evidence)+'\n');
}catch(error){
 // Do not echo arbitrary filesystem paths or source logs.
 const message=error instanceof Error?error.message:'UNKNOWN';
 const safe=message.startsWith('PUBLIC_')?message:'PUBLIC_RECEIPT_READ_FAILED';
 process.stderr.write(safe+'\n');
 process.exitCode=2;
}

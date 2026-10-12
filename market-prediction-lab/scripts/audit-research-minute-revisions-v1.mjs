#!/usr/bin/env node
/**
 * OFFLINE / READ-ONLY: inspect immutable source revisions for ONE original
 * minute session. No provider calls, source writes, user accounts or orders.
 * The emitted strict-superset SHA is only a reviewer candidate, never an
 * automatic strategy/OOS/Paper promotion or source authenticity claim.
 */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditResearchMinuteSessionRevisionsV1 } from
  "../src/research-minute-archive-v1.js";

const FLAGS=new Set(["--root","--market","--symbol","--day","--max-revisions"]);
const REQUIRED=["--root","--market","--symbol","--day"];
const MARKET=new Set(["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
const SYMBOL=/^[A-Z0-9\p{Script=Han}][A-Z0-9\p{Script=Han}._:-]{0,39}$/u;

export function parseResearchMinuteRevisionAuditArgsV1(args=[]){
 if(!Array.isArray(args)||(args.length!==8&&args.length!==10))
   throw new TypeError("MINUTE_REVISION_AUDIT_CLI_ARGUMENTS_INVALID");
 const values={};
 for(let i=0;i<args.length;i+=2){
  const key=args[i],val=args[i+1];
  if(!FLAGS.has(key)||Object.hasOwn(values,key)
    ||typeof val!=="string"||!val.trim()||val.startsWith("--"))
    throw new TypeError("MINUTE_REVISION_AUDIT_CLI_SCOPE_INVALID");
  values[key]=val;
 }
 if(!REQUIRED.every(key=>Object.hasOwn(values,key))
  ||!isAbsolute(values["--root"])
  ||resolve(values["--root"])!==values["--root"]
  ||!MARKET.has(values["--market"])
  ||!SYMBOL.test(values["--symbol"])
  ||!/^\d{4}-\d{2}-\d{2}$/u.test(values["--day"])
  ||!Date.parse(values["--day"]+"T00:00:00Z")
  ||new Date(Date.parse(values["--day"]+"T00:00:00Z"))
     .toISOString().slice(0,10)!==values["--day"]
  ||!/^(?:[1-9]|[12][0-9]|3[012])$/u.test(
    values["--max-revisions"]??"16"))
  throw new TypeError("MINUTE_REVISION_AUDIT_CLI_SCOPE_INVALID");
 return Object.freeze({
  root:values["--root"],market:values["--market"],
  symbol:values["--symbol"],
  sessionStartMs:Date.parse(values["--day"]+"T00:00:00Z"),
  maxRevisions:Number(values["--max-revisions"]??16),
 });
}

export async function runResearchMinuteRevisionAuditCliV1(config){
 const result=await auditResearchMinuteSessionRevisionsV1(config);
 return Object.freeze({
  schemaVersion:"research-minute-revision-audit-cli-v1",
  ...result,
  providerGETCount:0,
  sourceRevisionAutoSelected:false,
  profitabilityProven:false,
  executionAuthority:"NONE",
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=parseResearchMinuteRevisionAuditArgsV1(process.argv.slice(2));
 process.stdout.write(JSON.stringify(await runResearchMinuteRevisionAuditCliV1(args))+"\n");
}

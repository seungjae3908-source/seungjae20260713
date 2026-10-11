#!/usr/bin/env node
/** Explicit public GET only. No keys, server activation, or trading endpoints. */
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublicNativeCryptoRosterV1, validatePublicNativeCryptoRosterCaptureV1 } from "../src/public-native-crypto-roster-v1.js";
import { collectPublicNativeCryptoSourcePageV1 } from "../src/public-native-crypto-source-page-v1.js";

const KEYS=new Set(["--mode","--market","--day","--roster","--expected-roster-digest",
  "--root","--offset","--limit","--output"]);
const absolute=p=>typeof p==="string"&&isAbsolute(p)&&resolve(p)===p;
function parents(path){
  let at=dirname(path);
  while(true){
    try{const s=lstatSync(at);if(!s.isDirectory()||s.isSymbolicLink())
      throw new TypeError("PUBLIC_SOURCE_CLI_UNSAFE_PARENT");}
    catch(e){if(e?.code!=="ENOENT")throw e;}
    const next=dirname(at);if(at===next)break;at=next;
  }
}
function privateJson(path){
  parents(path);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const s=fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||(s.mode&0o077)!==0||s.size<2||s.size>4*1024**2)
      throw new TypeError("PUBLIC_SOURCE_CLI_PRIVATE_INPUT_REQUIRED");
    return JSON.parse(readFileSync(fd,"utf8"));
  }finally{closeSync(fd);}
}
export function parsePublicNativeSourcePageArgsV1(args=[]){
  const o={};let readPublic=false;
  if(!Array.isArray(args)||args.length>21)throw new TypeError("PUBLIC_SOURCE_CLI_ARGUMENT_INVALID");
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==="--read-public"){
      if(readPublic)throw new TypeError("PUBLIC_SOURCE_CLI_DUPLICATE_READ_FLAG");
      readPublic=true;continue;
    }
    const value=args[++i];
    if(!KEYS.has(key)||Object.hasOwn(o,key)||typeof value!=="string"
      ||!value||value.startsWith("--"))throw new TypeError("PUBLIC_SOURCE_CLI_OPTION_INVALID");
    o[key]=value;
  }
  const mode=o["--mode"]??"plan";
  if(!["roster","plan","capture"].includes(mode)
    ||!["CRYPTO_SPOT","CRYPTO_FUTURES"].includes(o["--market"])
    ||!absolute(o["--output"]))throw new TypeError("PUBLIC_SOURCE_CLI_SCOPE_INVALID");
  if(mode==="roster"){
    if(Object.keys(o).some(k=>!["--mode","--market","--output"].includes(k)))
      throw new TypeError("PUBLIC_SOURCE_CLI_ROSTER_SCOPE_INVALID");
  }else{
    if(!absolute(o["--roster"])||!absolute(o["--root"])
      ||new Set([o["--roster"],o["--root"],o["--output"]]).size!==3
      ||!/^[0-9a-f]{64}$/u.test(o["--expected-roster-digest"]??"")
      ||!/^(?:0|[1-9]\d{0,5})$/u.test(o["--offset"]??"0")
      ||!/^(?:[1-9]|1\d|20)$/u.test(o["--limit"]??"20")
      ||!/^\d{4}-\d{2}-\d{2}$/u.test(o["--day"]??""))
      throw new TypeError("PUBLIC_SOURCE_CLI_CAPTURE_SCOPE_INVALID");
    if(mode==="plan"&&readPublic)throw new TypeError("PUBLIC_SOURCE_CLI_PLAN_CANNOT_FETCH");
  }
  return Object.freeze({mode,market:o["--market"],day:o["--day"],
    rosterPath:o["--roster"],root:o["--root"],outputPath:o["--output"],
    expectedRosterDigestSha256:o["--expected-roster-digest"],
    offset:Number(o["--offset"]??0),limit:Number(o["--limit"]??20),
    allowPublicReadOnlyFetch:readPublic});
}
export async function runPublicNativeSourcePageCliV1(config,dependencies={}){
  if(!config||!absolute(config.outputPath)||!["roster","plan","capture"].includes(config.mode)
    ||typeof config.allowPublicReadOnlyFetch!=="boolean")throw new TypeError("PUBLIC_SOURCE_CLI_OUTPUT_INVALID");
  // Dependencies supply implementation seams, never authority or source scope.
  const injected={};
  for(const key of ["fetchImpl","nowImpl","statfsImpl"])
    if(Object.hasOwn(dependencies,key))injected[key]=dependencies[key];
  parents(config.outputPath);
  try{lstatSync(config.outputPath);throw new TypeError("PUBLIC_SOURCE_CLI_OUTPUT_EXISTS");}
  catch(e){if(e?.code!=="ENOENT")throw e;}
  mkdirSync(dirname(config.outputPath),{recursive:true,mode:0o700});
  const directory=lstatSync(dirname(config.outputPath));
  if(!directory.isDirectory()||(directory.mode&0o077)!==0)
    throw new TypeError("PUBLIC_SOURCE_CLI_PRIVATE_OUTPUT_DIRECTORY_REQUIRED");
  let receipt;
  if(config.mode==="roster"){
    receipt=await fetchPublicNativeCryptoRosterV1({market:config.market,
      allowPublicReadOnlyFetch:config.allowPublicReadOnlyFetch,...injected});
  }else{
    const input=privateJson(config.rosterPath);
    if(input&&Object.hasOwn(input,"roster")){
      const capture=validatePublicNativeCryptoRosterCaptureV1(input,config.expectedRosterDigestSha256);
      if(!capture.ok)throw new TypeError("PUBLIC_SOURCE_CLI_ROSTER_CAPTURE_INVALID");
    }
    const roster=input.roster??input;
    receipt=await collectPublicNativeCryptoSourcePageV1({
      root:config.root,market:config.market,day:config.day,roster,
      expectedRosterDigestSha256:config.expectedRosterDigestSha256,
      offset:config.offset,limit:config.limit,
      allowPublicReadOnlyFetch:config.mode==="capture"&&config.allowPublicReadOnlyFetch,
      ...injected});
  }
  parents(config.outputPath);
  writeFileSync(config.outputPath,JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o600});
  return Object.freeze({status:receipt.status,reason:receipt.reason??null,
    market:config.market,day:config.day??null,
    rosterDigestSha256:receipt.roster?.rosterDigestSha256??receipt.rosterDigestSha256??null,
    currentSourceSymbolCount:receipt.roster?.symbols?.length??receipt.currentSourceSymbolCount??null,
    selectedSymbolCount:receipt.selectedSymbolCount??null,
    retainedSymbolCount:receipt.currentPageRetainedSymbolCount??null,
    blockedSymbolCount:receipt.currentPageBlockedSymbolCount??null,
    sourceMinuteCount:receipt.sourceMinuteCount??null,
    missingUnverifiedMinuteSlots:receipt.missingUnverifiedMinuteSlots??null,
    nextOffset:receipt.nextOffset??null,providerReadOnlyGETs:receipt.providerReadOnlyGETs??null,
    historicalUniverseComplete:false,profitabilityProven:false,
    paperAdmissionAllowed:false,executionAuthority:"NONE"});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const config=parsePublicNativeSourcePageArgsV1(process.argv.slice(2));
  process.stdout.write(JSON.stringify(await runPublicNativeSourcePageCliV1(config))+"\n");
}

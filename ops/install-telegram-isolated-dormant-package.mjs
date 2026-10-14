/** DORMANT / CREATE-ONLY Telegram materialization. No Production app/PM2/Bot/DB/trading access. */
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SHA=/^[a-f0-9]{40}$/u;
const ROOT='/opt/stock-app-data/telegram-isolated-v1/release';
const FILES=Object.freeze([
 'api-server/dist/telegram-isolated-worker.mjs',
 'ops/telegram-legacy-owner-runtime-proof.mjs',
 'ops/run-telegram-isolated-worker.sh',
]);
const LIMITS=[64*1024*1024,128*1024,128*1024];
const deny=code=>{throw new Error(code);};
const inside=(root,child)=>{
 const rel=path.relative(root,child);
 return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));
};
const safeDir=p=>{
 try {const st=fs.lstatSync(p);return st.isDirectory()&&!st.isSymbolicLink()&&fs.realpathSync(p)===p;}
 catch{return false;}
};
function safeRead(filename,max) {
 let fd;
 try {
  const before=fs.lstatSync(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1
    ||before.size===0||before.size>max)deny('TELEGRAM_INSTALL_UNSAFE_INPUT');
  fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const after=fs.fstatSync(fd);
  if(!after.isFile()||after.nlink!==1||after.dev!==before.dev
     ||after.ino!==before.ino||after.size!==before.size)
    deny('TELEGRAM_INSTALL_UNSAFE_INPUT');
  const bytes=fs.readFileSync(fd);
  if(bytes.length!==before.size)deny('TELEGRAM_INSTALL_UNSAFE_INPUT');
  return bytes;
 }catch{deny('TELEGRAM_INSTALL_UNSAFE_INPUT');}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function put(filename,data,mode=0o600){
 const fd=fs.openSync(filename,'wx',mode);
 try{
  const bytes=Buffer.isBuffer(data)?data:Buffer.from(data,'utf8');
  let offset=0;
  while(offset<bytes.length){
   const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);
   if(n<=0)deny('TELEGRAM_INSTALL_WRITE_FAILED');
   offset+=n;
  }
  fs.fsyncSync(fd);
 }finally{fs.closeSync(fd);}
}
function sync(directory){
 const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}

/** Reusable locally in temporary-folder tests. CLI target is the immutable fixed ROOT. */
export function installTelegramDormantPackage({packageDir,expectedSha,releaseRoot}){
 if(typeof packageDir!=='string'||typeof releaseRoot!=='string'
   ||!path.isAbsolute(packageDir)||!path.isAbsolute(releaseRoot)
   ||typeof expectedSha!=='string'||!SHA.test(expectedSha))
  deny('TELEGRAM_INSTALL_INVALID_ARGUMENTS');
 const source=path.resolve(packageDir),root=path.resolve(releaseRoot);
 if(source!==packageDir||root!==releaseRoot
   ||inside('/opt/stock-app',source)||inside('/opt/stock-app',root)
   ||inside(source,root)||inside(root,source)
   ||!safeDir(source)||!safeDir(root))
  deny('TELEGRAM_INSTALL_UNSAFE_ROOT');
 for(const folder of ['api-server','api-server/dist','ops','.deploy'])
  if(!safeDir(path.join(source,folder)))deny('TELEGRAM_INSTALL_UNSAFE_INPUT');
 const current=path.join(root,'current');
 if(fs.existsSync(current))deny('TELEGRAM_INSTALL_DESTINATION_EXISTS');
 const manifest=safeRead(path.join(source,'.deploy/telegram-sha256.manifest'),8192).toString('utf8');
 const lines=manifest.split('\n');
 if(lines.length!==FILES.length+1||lines.at(-1)!=='')
  deny('TELEGRAM_INSTALL_MANIFEST_INVALID');
 const sealed=FILES.map((name,i)=>{
  const m=/^([0-9a-f]{64})  (.+)$/u.exec(lines[i]);
  if(!m||m[2]!==name)deny('TELEGRAM_INSTALL_MANIFEST_INVALID');
  const bytes=safeRead(path.join(source,name),LIMITS[i]);
  if(sha256(bytes)!==m[1])deny('TELEGRAM_INSTALL_DIGEST_MISMATCH');
  return bytes;
 });
 const marker=safeRead(path.join(source,'.deploy/current-sha'),128).toString('utf8');
 if(marker!==expectedSha+'\n')deny('TELEGRAM_INSTALL_SOURCE_SHA_MISMATCH');
 let receipt;
 try{receipt=JSON.parse(safeRead(path.join(source,'.deploy/preparation.json'),8192).toString('utf8'));}
 catch{deny('TELEGRAM_INSTALL_PREPARATION_INVALID');}
 if(receipt?.schemaVersion!=='telegram-isolated-dormant-package-v1'
   ||receipt.sha!==expectedSha||receipt.mode!=='PREPARE_ONLY'
   ||receipt.workerStarted!==false||receipt.productionAppChanged!==false
   ||receipt.pm2Restarts!==0||receipt.telegramMessages!==0
   ||receipt.financialMutations!==0||JSON.stringify(receipt.paths)!==JSON.stringify(FILES))
  deny('TELEGRAM_INSTALL_PREPARATION_INVALID');
 // Exclusive create-only final directory; marker is written LAST.
 fs.mkdirSync(current,{mode:0o700});
 let complete=false;
 try{
  for(const folder of ['api-server','api-server/dist','ops','.deploy'])
   fs.mkdirSync(path.join(current,folder),{mode:0o700});
  FILES.forEach((name,i)=>put(path.join(current,name),sealed[i],name.endsWith('.sh')?0o700:0o600));
  put(path.join(current,'.deploy/telegram-sha256.manifest'),manifest);
  put(path.join(current,'.deploy/preparation.json'),JSON.stringify(receipt)+'\n');
  const result=Object.freeze({
   schemaVersion:'telegram-isolated-dormant-install-v1',sha:expectedSha,
   mode:'STAGED_INACTIVE',workerStarted:false,productionAppChanged:false,
   pm2Restarts:0,telegramMessages:0,financialMutations:0,
   manifestSha256:sha256(Buffer.from(manifest,'utf8')),
  });
  put(path.join(current,'.deploy/installation.json'),JSON.stringify(result)+'\n');
  for(const folder of ['api-server/dist','api-server','ops','.deploy'])sync(path.join(current,folder));
  put(path.join(current,'.deploy/current-sha'),marker);
  sync(path.join(current,'.deploy'));sync(current);sync(root);
  complete=true;
  return result;
 }finally{
  if(!complete){
   // Never retain a runnable marker after any later write/fsync exception.
   try{fs.rmSync(path.join(current,'.deploy/current-sha'),{force:true});}catch{}
   try{sync(path.join(current,'.deploy'));}catch{}
   try{put(path.join(current,'.deploy/INSTALLATION_INCOMPLETE'),'FAIL_CLOSED\n');}catch{}
  }
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==4)deny('TELEGRAM_INSTALL_USAGE_PACKAGE_SHA');
 const result=installTelegramDormantPackage({
  packageDir:process.argv[2],expectedSha:process.argv[3],releaseRoot:ROOT,
 });
 process.stdout.write(JSON.stringify(result)+'\n');
}

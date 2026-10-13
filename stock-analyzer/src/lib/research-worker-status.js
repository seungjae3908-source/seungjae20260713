const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0&&x<=1000000;
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export function parseResearchWorkerStatus(raw){
  if(!object(raw)||raw.schemaVersion!=='research-worker-status-v9')throw new Error('INVALID_RESEARCH_WORKER_STATUS');
  if(raw.available===false)return {available:false,reason:'WORKER_STATUS_UNAVAILABLE'};
  if(raw.available!==true||!['ACTIVE','STALE','NOT_RUNNING','UNKNOWN'].includes(raw.workerState)||!object(raw.counts)||
    !['queued','running','succeeded','failed','blocked'].every(k=>integer(raw.counts[k]))||
    !object(raw.authority)||raw.authority.executionAuthority!=='NONE'||raw.authority.automaticActivation!==false||raw.authority.providerCallsFromStatus!==0||
    !iso(raw.checkedAt)||(raw.lastHeartbeatAt!==null&&!iso(raw.lastHeartbeatAt))||
    (raw.currentTaskKind!==null&&!['VIDEO_PREPARE','VIDEO_EXECUTE_APPROVED'].includes(raw.currentTaskKind)))throw new Error('INVALID_RESEARCH_WORKER_STATUS');
  return {available:true,checkedAt:raw.checkedAt,workerState:raw.workerState,lastHeartbeatAt:raw.lastHeartbeatAt,currentTaskKind:raw.currentTaskKind,counts:{...raw.counts}};
}

import type { GeneratedAiReview } from './paper-journal-sync';
export type ReviewStorage = Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const VERSION=1, MAX=10; const forbidden=/(?:api.?key|secret|token|authorization|payload|providerRequestId)/i;
export function aiReviewStorageKey(userId:string){let h=2166136261;for(const c of userId)h=Math.imul(h^c.charCodeAt(0),16777619);return `phase9.ai-review.v1:${(h>>>0).toString(36)}`;}
function safe(value:unknown):boolean{if(Array.isArray(value))return value.every(safe);if(!value||typeof value!=='object')return true;return Object.entries(value).every(([k,v])=>!forbidden.test(k)&&safe(v));}
export function loadSavedAiReviews(storage:ReviewStorage,userId:string):GeneratedAiReview[]{try{const x=JSON.parse(storage.getItem(aiReviewStorageKey(userId))||'{}');return x.schemaVersion===VERSION&&Array.isArray(x.items)&&safe(x.items)?x.items.slice(0,MAX):[];}catch{return[];}}
export function saveAiReview(storage:ReviewStorage,userId:string,review:GeneratedAiReview){const{providerRequestId:_discarded,...cleaned}=review;if(!safe(cleaned))throw new Error('Secret 또는 원본 payload는 저장할 수 없습니다.');const items=[cleaned as GeneratedAiReview,...loadSavedAiReviews(storage,userId)].slice(0,MAX);storage.setItem(aiReviewStorageKey(userId),JSON.stringify({schemaVersion:VERSION,items}));return items;}
export function deleteSavedAiReviews(storage:ReviewStorage,userId:string){storage.removeItem(aiReviewStorageKey(userId));}
export function exportSavedAiReviews(storage:ReviewStorage,userId:string){return JSON.stringify({schemaVersion:VERSION,exportedAt:new Date().toISOString(),items:loadSavedAiReviews(storage,userId)},null,2);}

import { createHash } from 'node:crypto';
import { answerAiChat, validateChatMessage } from './ai-chat.service';

type Provider = 'gemini'|'groq';
type ApprovalRequest = {provider:Provider;model:string;promptSha256:string};
type InvocationOptions = {signal:AbortSignal;expectedPromptSha256:string};
const reject = (code:string):never => { throw Object.assign(new Error(code),{code}); };
const digest = (text:string) => createHash('sha256').update(text).digest('hex');

/** Uses the existing canonical transport. Run in an isolated worker configured by its owner.
 * This function does NOT mutate process.env, mount an endpoint, or invoke on import.
 * freeTierReviewed is an explicit caller assertion, not proof of provider billing status.
 */
export function createCanonicalTranscriptInvoker({provider,model,freeTierReviewed,approve,fetchImpl=fetch}:{
  provider:Provider;model:string;freeTierReviewed:boolean;
  approve:(request:ApprovalRequest)=>Promise<boolean>;fetchImpl?:typeof fetch;
}) {
  if(!['gemini','groq'].includes(provider) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(model)
    || freeTierReviewed!==true || typeof approve!=='function')reject('TEXT_PROVIDER_REVIEW_REQUIRED');
  function assertIsolated() {
    if(process.env.AI_CHAT_PROVIDER!==provider || process.env.AI_CHAT_API_KEY || process.env.AI_CHAT_MODEL || process.env.OPENAI_API_KEY)reject('TEXT_PROVIDER_ISOLATION_REQUIRED');
    if(provider==='gemini') {
      if(!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) || process.env.GROQ_API_KEY || process.env.GEMINI_MODEL!==model)reject('TEXT_PROVIDER_ISOLATION_REQUIRED');
    } else if(!process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GROQ_MODEL!==model)reject('TEXT_PROVIDER_ISOLATION_REQUIRED');
  }
  return async function invoke(message:string,options:InvocationOptions) {
    assertIsolated();
    if(!(options.signal instanceof AbortSignal) || options.signal.aborted)reject('TEXT_PROVIDER_CANCELLED');
    if(message.length>1900 || validateChatMessage(message)!==message || digest(message)!==options.expectedPromptSha256)reject('TEXT_PROMPT_WOULD_CHANGE');
    if(await approve({provider,model,promptSha256:options.expectedPromptSha256})!==true)reject('TEXT_PROVIDER_NOT_APPROVED');
    let calls=0;
    const guarded:typeof fetch=async(input,init)=>{
      assertIsolated();
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      const expected=provider==='gemini'?`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`:'https://api.groq.com/openai/v1/chat/completions';
      if(!init || url!==expected || init.method!=='POST' || typeof init.body!=='string' || calls!==0) {
        return reject('TEXT_PROVIDER_ROUTE_MISMATCH');
      }
      if(provider==='groq' && (JSON.parse(init.body) as {model?:string}).model!==model)reject('TEXT_PROVIDER_MODEL_MISMATCH');
      if(options.signal.aborted)reject('TEXT_PROVIDER_CANCELLED');
      calls++;
      return fetchImpl(input,{...init,signal:init.signal?AbortSignal.any([init.signal,options.signal]):options.signal,redirect:'error'});
    };
    const result=await answerAiChat({message},guarded,options.signal,20000);
    if(options.signal.aborted || result.kind!=='answer' || result.model!==model || result.data.status!=='not_requested' || calls!==1)reject('TEXT_PROVIDER_RESPONSE_UNVERIFIED');
    return {answer:result.answer,model:result.model,generatedAt:result.generatedAt};
  };
}

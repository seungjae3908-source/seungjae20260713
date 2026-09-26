/** Read existing configuration in the selected process; never equate a key with a successful call. */

const fail = code => { throw Object.assign(new Error(code), { code }); };
const names = ['YOUTUBE_DATA_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','GROQ_API_KEY',
  'AI_CHAT_PROVIDER','AI_CHAT_API_KEY','AI_CHAT_MODEL','GEMINI_MODEL','GROQ_MODEL'];
const ids = ['youtube','gemini','groq'];
const gemini = new Set(['gemini','google','google-gemini']);
const keyPattern = /^[A-Za-z0-9_.-]{8,512}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function value(env, name) {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor,'value')) fail('PROVIDER_ENV_ACCESSOR_REJECTED');
  if (descriptor.value === undefined || descriptor.value === '') return undefined;
  if (typeof descriptor.value !== 'string' || descriptor.value.length > 1024) fail('PROVIDER_ENV_INVALID');
  return descriptor.value.trim() || undefined;
}
function selected(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('PROVIDER_ENV_INVALID');
  // Do not enumerate, clone, log or hash the rest of the server environment.
  return Object.fromEntries(names.map(name => [name, value(env,name)]));
}
function resolveOne(env, provider) {
  const explicit = env.AI_CHAT_PROVIDER?.toLowerCase();
  const canonicalMatch = provider === 'gemini' ? gemini.has(explicit) : explicit === provider;
  const fields = provider === 'youtube' ? ['YOUTUBE_DATA_API_KEY'] : provider === 'gemini' ? ['GEMINI_API_KEY','GOOGLE_API_KEY'] : ['GROQ_API_KEY'];
  if (provider !== 'youtube' && canonicalMatch) fields.push('AI_CHAT_API_KEY');
  const values = fields.map(field=>env[field]).filter(Boolean);
  let state = !values.length ? 'MISSING_IN_SELECTED_RUNTIME' : values.some(key=>!keyPattern.test(key)) ? 'INVALID' : new Set(values).size>1 ? 'CONFLICT' : 'PRESENT';
  const providerModel = env[provider === 'gemini' ? 'GEMINI_MODEL' : 'GROQ_MODEL'];
  const genericModel = canonicalMatch ? env.AI_CHAT_MODEL : undefined;
  const models = provider === 'youtube' ? [] : [providerModel,genericModel].filter(Boolean);
  const modelState = provider === 'youtube' ? 'NOT_APPLICABLE' : !models.length ? 'DEFAULT_NOT_RESOLVED' : models.some(m=>!modelPattern.test(m)) ? 'INVALID' : new Set(models).size>1 ? 'CONFLICT' : 'EXPLICIT';
  // A generic key with no explicit Gemini/Groq identity cannot be assigned by guess.
  const unmapped = Boolean(env.AI_CHAT_API_KEY && !gemini.has(explicit) && explicit !== 'groq');
  return {key:state==='PRESENT'?values[0]:null,state,modelState,unmapped};
}
export function inspectExistingResearchProviders(env, {now = new Date().toISOString(), source = 'API_PROCESS'} = {}) {
  if (!iso(now) || !['API_PROCESS','INHERITED_PROCESS','EXPLICIT_ENV_FILE'].includes(source)) fail('PROVIDER_CONTEXT_INVALID');
  const local = selected(env);
  return {schemaVersion:'research-provider-readiness-v8', checkedAt:now, source,
    scope:'SELECTED_RUNTIME_ONLY', providers:ids.map(provider=>{
      const resolved = resolveOne(local,provider);
      return {provider,credentialState:resolved.state,modelState:resolved.modelState,
        callVerified:false,quotaState:'NOT_CHECKED',billingState:'NOT_CHECKED'};
    }), unmappedGenericCredential:resolveOne(local,'gemini').unmapped,
    authority:{executionAuthority:'NONE',providerCalls:0,environmentMutated:false,automaticActivation:false}};
}

/** Server-side invocation bridge. Not an HTTP POST endpoint and not a credential export API.
 * Existing source/model/approval/reservation checks remain inside the V7 runner.
 * Extra provider keys are isolated in memory instead of deleting process.env fields.
 */
export async function runExistingEnvironmentVideo(argv, {env=process.env,invokeVideo} = {}) {
  if (!Array.isArray(argv) || argv.some(x=>typeof x!=='string')) fail('PROVIDER_ARGUMENTS_INVALID');
  if (typeof invokeVideo !== 'function') fail('PROVIDER_VIDEO_CALLER_REQUIRED');
  if (!argv.includes('--execute')) return invokeVideo(argv,{env:{}});
  const local = selected(env), resolved = resolveOne(local,'gemini');
  if (resolved.state !== 'PRESENT') fail('PROVIDER_GEMINI_CONFIGURATION_UNRESOLVED');
  if (resolved.unmapped) fail('PROVIDER_GENERIC_CREDENTIAL_UNMAPPED');
  // The model and free-tier review come from the V7 exact-plan approval, not chat defaults.
  return invokeVideo(argv,{env:{GEMINI_API_KEY:resolved.key}});
}

/** Auth and method checks occur before environment access; no paths or env keys from HTTP. */
export function createProviderReadinessHandler({authorize,readEnvironment=()=>process.env,clock=()=>new Date().toISOString()}) {
  if (![authorize,readEnvironment,clock].every(f=>typeof f==='function')) fail('PROVIDER_CALLER_REQUIRED');
  return async (req,res) => {
    res.setHeader('Cache-Control','no-store, max-age=0');
    res.setHeader('Vary','Authorization, Cookie');
    res.setHeader('X-Content-Type-Options','nosniff');
    if (req.method !== 'GET') {res.setHeader('Allow','GET');return res.status(405).json({error:'READ_ONLY'});}
    let allowed = false;
    try {allowed = await authorize(req) === true;} catch { /* Keep authorization fail closed. */ }
    if (!allowed) return res.status(403).json({error:'RESEARCH_ACCESS_REQUIRED'});
    try {return res.status(200).json(inspectExistingResearchProviders(readEnvironment(),{now:clock(),source:'API_PROCESS'}));}
    catch {return res.status(503).json({available:false,reason:'PROVIDER_CONFIGURATION_UNAVAILABLE'});}
  };
}

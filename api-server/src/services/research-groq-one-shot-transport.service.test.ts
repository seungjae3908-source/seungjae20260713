import test from 'node:test';
import assert from 'node:assert/strict';
import { AiChatError, answerGroqResearchJsonWithConfig } from './ai-chat.service';

test('research Groq JSON transport calls only the reviewed Groq endpoint and model', async () => {
  let calls=0;let url='';let body:any=null;let auth='';
  const result=await answerGroqResearchJsonWithConfig({
    message:'Return one JSON object with findings and disposition for synthetic reviewed evidence.',
    apiKey:'synthetic_groq_key',model:'openai/gpt-oss-20b',
  },async(input,init)=>{
    calls++;url=String(input);body=JSON.parse(String(init?.body));auth=new Headers(init?.headers).get('authorization')??'';
    return new Response(JSON.stringify({choices:[{message:{content:'{"findings":[],"missingRuleKinds":[],"disposition":"CONTINUE","summary":"Synthetic review only."}'}}]}),{status:200,headers:{'content-type':'application/json'}});
  });
  assert.equal(calls,1);
  assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(body.model,'openai/gpt-oss-20b');
  assert.match(String(body.messages[0].content),/adversarial research-evidence critic/);
  assert.match(String(body.messages[0].content),/Never invent a missing rule/);
  assert.equal(auth,'Bearer synthetic_groq_key');
  assert.ok(!JSON.stringify(body).includes('synthetic_groq_key'));
  assert.equal(result.model,'openai/gpt-oss-20b');
  assert.match(result.answer,/CONTINUE/);
});

test('research Groq JSON transport has no Gemini or provider fallback', async () => {
  let calls=0;
  await assert.rejects(
    answerGroqResearchJsonWithConfig({message:'Synthetic review.',apiKey:'synthetic_groq_key',model:'groq-test'},async input=>{
      calls++;assert.match(String(input),/api\.groq\.com/);
      return new Response('{}',{status:503,headers:{'content-type':'application/json'}});
    }),
    (cause:unknown)=>cause instanceof AiChatError && cause.code==='AI_CHAT_PROVIDER_ERROR',
  );
  assert.equal(calls,1);
});

test('research Groq JSON transport blocks secrets before provider access', async () => {
  let calls=0;
  await assert.rejects(
    answerGroqResearchJsonWithConfig({message:'api_key=secret-secret-secret-value',apiKey:'synthetic_groq_key',model:'groq-test'},async()=>{calls++;throw new Error('must not call');}),
    (cause:unknown)=>cause instanceof AiChatError && cause.code==='RESEARCH_GROQ_INPUT_INVALID',
  );
  assert.equal(calls,0);
});

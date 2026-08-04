#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,os,re,sys
from typing import Any
from urllib.error import HTTPError,URLError
from urllib.parse import urlencode
from urllib.request import Request,urlopen

REPORT='[WORKER_REPORT]'; COMMAND='[HUB_COMMAND]'; BOT='github-actions[bot]'
EXEC_MARK='<!-- agent-executor-report -->'; DONE='<!-- agent-executor-report-processed:'
API_VERSION='2022-11-28'

class Error(RuntimeError): pass

def fields(body:str)->dict[str,str]:
 out={}
 for raw in body.splitlines():
  line=raw.strip()
  if not line or line.startswith('[') or line.startswith('<!--') or ':' not in line: continue
  k,v=line.split(':',1); k=k.strip().lower()
  if re.fullmatch(r'[a-z_][a-z0-9_]*',k): out[k]=v.strip()
 return out

def marker(cid:int)->str: return f'{DONE}{cid} -->'

class GH:
 def __init__(self):
  self.token=os.environ.get('GITHUB_TOKEN','').strip(); self.repo=os.environ.get('GITHUB_REPOSITORY','').strip(); self.api=os.environ.get('GITHUB_API_URL','https://api.github.com').rstrip('/')
  if not self.token or '/' not in self.repo: raise Error('GitHub credentials are required')
 def req(self,method:str,url:str,payload:dict[str,Any]|None=None)->Any:
  data=None; headers={'Accept':'application/vnd.github+json','Authorization':f'Bearer {self.token}','X-GitHub-Api-Version':API_VERSION,'User-Agent':'agent-hub-executor-report/1.0'}
  if payload is not None: data=json.dumps(payload,ensure_ascii=False).encode(); headers['Content-Type']='application/json'
  try:
   with urlopen(Request(url,data=data,headers=headers,method=method),timeout=30) as r:
    raw=r.read().decode(); return json.loads(raw) if raw else None
  except HTTPError as e: raise Error(f'GitHub HTTP {e.code}: {e.read().decode(errors="replace")[:800]}') from e
  except (URLError,json.JSONDecodeError) as e: raise Error(f'GitHub request failed: {e}') from e
 def comments(self,issue:int)->list[dict[str,Any]]:
  out=[]
  for page in range(1,11):
   q=urlencode({'per_page':100,'page':page}); data=self.req('GET',f'{self.api}/repos/{self.repo}/issues/{issue}/comments?{q}')
   if not isinstance(data,list): raise Error('comments response was not a list')
   out.extend(data)
   if len(data)<100: break
  return out
 def post(self,issue:int,body:str)->None: self.req('POST',f'{self.api}/repos/{self.repo}/issues/{issue}/comments',{'body':body})

def find(comments:list[dict[str,Any]])->tuple[int,dict[str,str]]|None:
 all_body='\n'.join(str(c.get('body') or '') for c in comments)
 for c in reversed(comments):
  cid=int(c.get('id') or 0); body=str(c.get('body') or ''); login=str((c.get('user') or {}).get('login') or '')
  if cid<=0 or login!=BOT or REPORT not in body or EXEC_MARK not in body or marker(cid) in all_body: continue
  f=fields(body)
  if f.get('worker')!='github-executor' or not f.get('task_id'): continue
  return cid,f
 return None

def command(cid:int,f:dict[str,str])->str:
 approval=f.get('approval_required','').lower() in {'yes','true','required'}
 status='waiting_approval' if approval else 'no_action'
 instruction='Draft PR 검토와 사용자의 명시 승인을 기다린다.' if approval else '추가 자동 작업 없이 현재 실행 결과를 확정하고 종료한다.'
 stop='사용자 명시 승인 전 중단' if approval else '새로운 작업 보고가 있을 때까지 중단'
 return '\n'.join([COMMAND,f"source_task_id: {f['task_id']}",'target_worker: none',f'status: {status}','branch: none',f'instruction: {instruction}','validation: 실행기 보고의 checks, head_sha, draft_pr을 확인한다.',f'stop_conditions: {stop}','provider: gemini-developer-api-free','model: deterministic-executor-report-adapter',f'processed_report_comment_id: {cid}',f'<!-- agent-hub-processed:{cid} -->',marker(cid)])

def self_test()->None:
 body='''[WORKER_REPORT]\ntask_id: demo-exec\nworker: github-executor\nstatus: completed\napproval_required: yes\n<!-- agent-executor-report -->'''
 c={'id':7,'body':body,'user':{'login':BOT}}; got=find([c]); assert got and got[0]==7; assert 'status: waiting_approval' in command(*got); assert find([c,{'id':8,'body':marker(7),'user':{'login':BOT}}]) is None; print('executor-report self-test: pass')

def main()->int:
 p=argparse.ArgumentParser(); p.add_argument('--self-test',action='store_true'); a=p.parse_args()
 if a.self_test: self_test(); return 0
 try: issue=int(os.environ.get('HUB_ISSUE_NUMBER',''))
 except ValueError as e: raise Error('HUB_ISSUE_NUMBER must be an integer') from e
 gh=GH(); got=find(gh.comments(issue))
 if not got: print('No pending executor report.'); return 0
 gh.post(issue,command(*got)); print(json.dumps({'status':'posted','report_comment_id':got[0]})); return 0

if __name__=='__main__':
 try: raise SystemExit(main())
 except Error as e: print(f'executor-report error: {e}',file=sys.stderr); raise SystemExit(1)

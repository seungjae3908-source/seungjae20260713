import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderResearchWorkspaceReview } from '../src/research-workspace-review-v1.js';
const view={schemaVersion:'research-workspace-v1',authority:{executionAuthority:'NONE'},sourceState:'MISSING',sourceCount:null,sources:[],strategies:[],registryState:'MISSING',workerState:'UNVERIFIED'};
test('review is explicit about no live app integration',()=>assert.match(renderResearchWorkspaceReview(view),/운영 앱과 연결되지 않았습니다/));
test('test fixtures are visibly distinct from results',()=>assert.match(renderResearchWorkspaceReview(view,{fixtureMode:true}),/검증용 가상 자료 · 실제 영상 분석이나 투자 성과가 아닙니다/));
test('renderer refuses an authority-bearing view',()=>assert.throws(()=>renderResearchWorkspaceReview({...view,authority:{executionAuthority:'LIVE'}}),/WORKSPACE_VIEW_REQUIRED/));
test('embedded data cannot close the script tag',()=>{const html=renderResearchWorkspaceReview({...view,sources:[{title:'</script><script>alert(1)</script>'}]});assert.ok(!html.includes('</script><script>alert(1)'));assert.ok(html.includes('\\u003c/script\\u003e'));});
test('review prohibits external network and forms',()=>{const html=renderResearchWorkspaceReview(view);assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);assert.ok(!html.includes('innerHTML'));});

import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readdir,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexStreamRecorder,readCodexStream} from '../dist/agents/codexStream.js';
const ROOT='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',B='33333333-3333-4333-8333-333333333333';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'codex-stream-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const item=(phase,targets,status='completed')=>({type:`item.${phase}`,item:{id:'item_6',type:'collab_tool_call',tool:'wait',status,sender_thread_id:ROOT,receiver_thread_ids:targets,prompt:'PRIVATE PROMPT',agents_states:{[A]:{completed:'PRIVATE RESULT'}}}});

test('native CLI starts preserve requested targets when completion contains a subset or no results',async t=>{
 const root=await fixture(t),writer=new CodexStreamRecorder({root,cwd:'/workspace'});
 writer.write({type:'thread.started',thread_id:ROOT},1000);writer.write(item('started',[A,B],'in_progress'),1100);writer.write(item('completed',[A]),1200);writer.close();
 const source=await readCodexStream({root,nativeId:ROOT,cwd:'/workspace',now:1300});assert.ok(source);
 assert.deepEqual(source.events.map(e=>[e.kind,e.wait_for_native_ids,e.wait_result_native_ids]),[['call.start',[A,B],undefined],['call.end',[A,B],[A]]]);
 assert.equal(source.events[0].call_id,source.events[1].call_id);assert.ok(source.events[0].cursor_scope);
 const contents=(await Promise.all((await readdir(root)).map(f=>readFile(join(root,f),'utf8')))).join('');assert.doesNotMatch(contents,/PRIVATE/);
 const writer2=new CodexStreamRecorder({root,cwd:'/workspace'});writer2.write({type:'thread.started',thread_id:ROOT},1400);writer2.write(item('started',[A,B],'in_progress'),1500);writer2.write(item('completed',[]),1600);writer2.close();
 const again=await readCodexStream({root,nativeId:ROOT,cwd:'/workspace',now:1700});const end=again.events.find(e=>e.at===1600);assert.deepEqual(end.wait_for_native_ids,[A,B]);assert.deepEqual(end.wait_result_native_ids,[]);
 assert.equal(await readCodexStream({root,nativeId:ROOT,cwd:'/different',now:1700}),null);
});

test('app-server stream IDs correlate start and completion without exporting proposal or prompt text',async t=>{
 const root=await fixture(t),writer=new CodexStreamRecorder({root,cwd:'/fallback'});
 writer.write({method:'thread/started',params:{thread:{id:ROOT,cwd:'/workspace',preview:'PRIVATE PREVIEW'}}},1000);
 const rpc=(phase,targets,status)=>({method:`item/${phase}`,emittedAtMs:phase==='started'?1100:1200,params:{threadId:ROOT,item:{type:'collabAgentToolCall',id:'native-wait',tool:'wait',status,senderThreadId:ROOT,receiverThreadIds:targets,prompt:'PRIVATE PROMPT'}}});
 writer.write(rpc('started',[A,B],'inProgress'),1105);writer.write(rpc('completed',[A],'completed'),1205);writer.close();
 const source=await readCodexStream({root,nativeId:ROOT,cwd:'/workspace',now:1300});assert.ok(source);assert.deepEqual(source.events.map(e=>e.at),[1100,1200]);assert.deepEqual(source.events[1].wait_for_native_ids,[A,B]);
 const files=await readdir(root);await symlink(join(root,files[0]),join(root,ROOT+'.symlink.jsonl'));const same=await readCodexStream({root,nativeId:ROOT,cwd:'/workspace',now:1300});assert.equal(same.events.length,2);
});

test('a closed capture explicitly marks an unreturned native wait as having no confirmed end',async t=>{
 const root=await fixture(t),writer=new CodexStreamRecorder({root,cwd:'/workspace'});
 writer.write({type:'thread.started',thread_id:ROOT},1000);writer.write(item('started',[A],'in_progress'),1100);writer.close();
 const source=await readCodexStream({root,nativeId:ROOT,cwd:'/workspace',now:1200});assert.ok(source);assert.equal(source.closed_scopes.length,1);assert.equal(source.events.length,1);
});

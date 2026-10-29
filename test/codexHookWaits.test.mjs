import assert from'node:assert/strict';import test from'node:test';import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{captureCodexHook,readCodexHooks}from'../dist/agents/codexHooks.js';
test('targetless native waits provide live timing while keeping the target set unknown',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'codex-targetless-wait-'));t.after(()=>rm(dir,{recursive:true,force:true}));const sessions=join(dir,'sessions'),events=join(dir,'events');await mkdir(sessions);
 const id='11111111-1111-4111-8111-111111111111',turn='22222222-2222-4222-8222-222222222222',file=join(sessions,'root.jsonl');await writeFile(file,JSON.stringify({type:'session_meta',payload:{id,cwd:dir,source:'cli'}})+'\n');
 assert.equal(captureCodexHook({root:events,sessionsRoot:sessions,now:1000,raw:{session_id:id,turn_id:turn,cwd:dir,transcript_path:file,hook_event_name:'PreToolUse',tool_name:'collaboration.wait_agent',tool_use_id:'global-wait',tool_input:{timeout_ms:10000}}}),true);
 const source=readCodexHooks({root:events,nativeId:id,rootNativeId:id,cwd:dir,now:1100});assert.equal(source.events.length,1);assert.equal(source.events[0].label,'Native wait');assert.equal(source.events[0].wait_for_native_ids,undefined);assert.equal(source.pending[0].turnId,turn);
});

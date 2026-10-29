import assert from 'node:assert/strict';import test from 'node:test';import {mkdtemp,writeFile,rm,readFile,readdir}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{Writable}from'node:stream';
import{traceCodex,isCodexTraceInvocation}from'../dist/cli/codexTrace.js';import{readCodexStream}from'../dist/agents/codexStream.js';
test('trace transparently forwards native output/exit and records only scoped metadata',async t=>{
 const root=await mkdtemp(join(tmpdir(),'codex-trace-'));t.after(()=>rm(root,{recursive:true,force:true}));const eventsRoot=join(root,'events'),script=join(root,'native.mjs');
 const id='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';const frames=[{type:'thread.started',thread_id:id},{type:'item.started',item:{type:'collab_tool_call',tool:'wait',id:'item_1',status:'in_progress',sender_thread_id:id,receiver_thread_ids:[target],prompt:'PRIVATE'}},{type:'item.completed',item:{type:'collab_tool_call',tool:'wait',id:'item_1',status:'completed',sender_thread_id:id,receiver_thread_ids:[]}}];
 const expected=frames.map(x=>JSON.stringify(x)+'\n').join('');await writeFile(script,`process.stdout.write(${JSON.stringify(expected)});process.stderr.write('native diagnostic\\n');process.exitCode=7;`);
 let output='',diagnostics='';const stdout=new Writable({write(c,e,done){output+=c.toString();done();}}),stderr=new Writable({write(c,e,done){diagnostics+=c.toString();done();}});
 const code=await traceCodex({binary:process.execPath,args:[script],cwd:root,eventsRoot,stdout,stderr});assert.equal(code,7);assert.equal(output,expected);assert.equal(diagnostics,'native diagnostic\n');
 const source=await readCodexStream({root:eventsRoot,nativeId:id,cwd:root,now:Date.now()});assert.ok(source);assert.deepEqual(source.events[1].wait_for_native_ids,[target]);assert.deepEqual(source.events[1].wait_result_native_ids,[]);
 const saved=(await Promise.all((await readdir(eventsRoot)).map(f=>readFile(join(eventsRoot,f),'utf8')))).join('');assert.doesNotMatch(saved,/PRIVATE|diagnostic/);
});
test('trace requires an explicit structured native entry and supports app-server stdio',()=>{
 assert.equal(isCodexTraceInvocation(['exec','--json']),true);assert.equal(isCodexTraceInvocation(['app-server','--listen','stdio://']),true);assert.equal(isCodexTraceInvocation(['exec']),false);assert.equal(isCodexTraceInvocation([]),false);assert.equal(isCodexTraceInvocation(['app-server','--listen','ws://0.0.0.0:8080']),false);
});
test('an unavailable capture directory does not prevent the native command from running',async t=>{
 const root=await mkdtemp(join(tmpdir(),'codex-trace-unavailable-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const eventsRoot=join(root,'not-a-directory');await writeFile(eventsRoot,'existing file');
 let output='',diagnostics='';const stdout=new Writable({write(c,e,done){output+=c;done();}}),stderr=new Writable({write(c,e,done){diagnostics+=c;done();}});
 const code=await traceCodex({binary:process.execPath,args:['-e',"process.stdout.write('native still runs');process.exitCode=6"],cwd:root,eventsRoot,stdout,stderr});
 assert.equal(code,6);assert.equal(output,'native still runs');assert.match(diagnostics,/capture unavailable/);assert.equal(await readFile(eventsRoot,'utf8'),'existing file');
});

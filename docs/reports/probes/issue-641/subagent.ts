#!/usr/bin/env bun
// Repeat the real OMP task-child writer-contention test while deadline checks are active.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const repo=resolve(import.meta.dir,"../../../..");
const root=join(realpathSync(tmpdir()),"magic-context","issue-641");
mkdirSync(root,{recursive:true});
Object.assign(process.env,{TMPDIR:root,HOME:root,CFFIXED_USER_HOME:root,MC_E2E_KEEP:"1"});
const {createPiIsolatedEnv,childEnv,writeConfigs}=await import("../../../../packages/e2e-tests/src/pi-runner/spawn");
const {prepareContextDatabase}=await import("../../../../packages/e2e-tests/src/prepare-context-db");
const {PiRpcProtocol,attachStrictJsonlReader}=await import("../../../../packages/e2e-tests/src/pi-runner/rpc-client");
const {MockProvider}=await import("../../../../packages/e2e-tests/src/mock-provider/server");
const hold=Number(process.argv[2]??60);
if(![2.2,10,60].includes(hold)) throw new Error("use hold 2.2, 10 or 60");
const mock=new MockProvider();
const {baseURL}=await mock.start();
const iso=createPiIsolatedEnv(undefined,"omp");
prepareContextDatabase(iso.dataDir);
writeConfigs(iso,{host:"omp",mockProviderURL:baseURL,modelContextLimit:1000000,magicContextConfig:{memory:{enabled:false},embedding:{provider:"off"},dreamer:{disable:true}},piSettingsExtra:{task:{batch:false,isolation:{enabled:false},agentModels:{task:"mock/mock-model"}},async:{enabled:true}}});
const env=childEnv(iso);
Object.assign(env,{TMPDIR:root,MAGIC_CONTEXT_LOG_PATH:join(iso.baseDir,"magic-context.log"),MC641_ROOT:iso.baseDir,MC641_HOLD:String(hold),MC641_DB:join(iso.dataDir,"cortexkit/magic-context/context.db")});
const probe=join(iso.baseDir,"lock.mjs");
writeFileSync(probe,`
import {appendFileSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
export default function(pi){
 let locked=false;
 const audit=value=>appendFileSync(process.env.MC641_ROOT+'/audit.jsonl',JSON.stringify({at:Date.now(),...value})+'\\n');
 pi.on('context',async(event,ctx)=>{
  const child=!!ctx.sessionManager.getHeader()?.parentSession;
  audit({phase:'context',child,session:ctx.sessionManager.getSessionId(),messages:event.messages.length});
  if(!child || locked) return;
  locked=true;
  const p=spawn('python3',['-u','-c',"import sqlite3,sys,time;c=sqlite3.connect(sys.argv[1]);c.execute('BEGIN IMMEDIATE');print('locked',flush=True);time.sleep(float(sys.argv[2]));c.rollback()",process.env.MC641_DB,process.env.MC641_HOLD],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  await new Promise((done,fail)=>{p.stdout.once('data',done);p.once('error',fail);});
  audit({phase:'locked',pid:p.pid});
  for(const pid of [process.pid,p.pid]){
   const lsof=execFileSync('/usr/sbin/lsof',['-p',String(pid)],{encoding:'utf8',windowsHide:true});
   const dbLines=lsof.split('\\n').filter(line=>/\\.db(?:[- ]|$)/.test(line));
   if(!dbLines.length || dbLines.some(line=>!line.includes(process.env.MC641_ROOT))) throw new Error('store isolation failed');
   audit({phase:'lsof',pid,lsof,dbLines});
  }
 });
}
`);
const usage={input_tokens:1000,output_tokens:40};
let spawned=false;
mock.setDefault({text:"parent done",usage});
mock.addMatcher(body=>{
 const tools=(body.tools??[]) as Array<{name:string}>;
 const yieldTool=tools.find(t=>t.name.replace(/^_/,"")==="yield");
 if(yieldTool) return {content:[{type:"tool_use",id:"yield641",name:yieldTool.name,input:{data:"control completed"}}],stop_reason:"tool_use",usage};
 const task=tools.find(t=>t.name.replace(/^_/,"")==="task");
 if(!task || spawned) return null;
 spawned=true;
 return {content:[{type:"tool_use",id:"task641",name:task.name,input:{name:"Busy641",agent:"task",task:"Read the throwaway fixture then yield a result.",solutionSpace:"A single concrete tool action and result."}}],stop_reason:"tool_use",usage};
});
const cli=join(repo,".cache/issue-641/host/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
const version=execFileSync(process.execPath,[cli,"--version"],{env,cwd:iso.workdir,encoding:"utf8",windowsHide:true}).trim();
const host=spawn(process.execPath,[cli,"--mode","rpc","--no-extensions","--extension",probe,"--extension",iso.pluginDir,"--no-skills","--no-rules","--model","mock/mock-model","--api-key","test-key-not-real"],{env,cwd:iso.workdir,stdio:["pipe","pipe","pipe"],windowsHide:true});
const rpc=new PiRpcProtocol();
attachStrictJsonlReader(host.stdout!,line=>rpc.dispatchLine(line));
host.stderr!.on("data",data=>appendFileSync(join(iso.baseDir,"stderr.txt"),data));
rpc.onEvent(event=>appendFileSync(join(iso.baseDir,"events.jsonl"),JSON.stringify({at:Date.now(),...event})+"\n"));
const command=(type:string,params={})=>rpc.sendCommand(line=>host.stdin!.write(line),type,params,{timeoutMs:180000});
try{
 await command("get_state");
 const result=rpc.waitForEvent(e=>e.type==="message_end" && (e.message as {customType?:string})?.customType==="async-result",{timeoutMs:180000});
 const start=Date.now();
 await command("prompt",{message:"Use task to start one subagent and wait for its result."});
 const completed=await result;
 const requests=mock.requests();
 const children=requests.filter(request=>(request.body.tools as Array<{name:string}>??[]).some(t=>t.name.replace(/^_/,"")==="yield"));
 if(!children.length || children.some(request=>!JSON.stringify(request.body.messages).includes("§"))) throw new Error("task child missing a managed request");
 const lsof=execFileSync('/usr/sbin/lsof',["-p",String(host.pid)],{encoding:"utf8",windowsHide:true});
 const dbLines=lsof.split("\n").filter(line=>/\.db(?:[- ]|$)/.test(line));
 if(!dbLines.length || dbLines.some(line=>!line.includes(iso.baseDir))) throw new Error("end isolation failed");
 const {readFileSync}=await import("node:fs");
 const audit=readFileSync(join(iso.baseDir,"audit.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
 const lockedAt=audit.find(row=>row.phase==='locked')?.at;
 if(!lockedAt || (hold===60 && children.some(request=>request.receivedAt<lockedAt+hold*1000-500))) throw new Error("child dispatched while long writer held");
 const summary={version,root:iso.baseDir,hold,pid:host.pid,totalMs:Date.now()-start,childRequests:children.length,firstChildAfterLockMs:children[0].receivedAt-lockedAt,result:completed};
  const evidence=process.env.MC_PROBE_EVIDENCE_DIR ?? join(import.meta.dir,"evidence/implementation");
 mkdirSync(evidence,{recursive:true});
 writeFileSync(join(evidence,`subagent-hold-${hold}.json`),JSON.stringify({summary,audit,requests},null,2)+"\n");
 writeFileSync(join(evidence,`subagent-hold-${hold}-lsof.txt`),lsof);
 console.log(JSON.stringify(summary));
}finally{
 host.kill("SIGTERM");
 await new Promise(done=>host.once("exit",done));
 await mock.stop();
}

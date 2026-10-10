#!/usr/bin/env bun
// Run RPC probes against Oh My Pi, keeping host state and request captures in a temporary directory.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const root = join(realpathSync(tmpdir()), "magic-context", "issue-641");
mkdirSync(root, { recursive: true });
Object.assign(process.env, { TMPDIR: root, HOME: root, CFFIXED_USER_HOME: root, MC_E2E_KEEP: "1" });
const { createPiIsolatedEnv, childEnv, writeConfigs } = await import("../../../../packages/e2e-tests/src/pi-runner/spawn");
const { prepareContextDatabase } = await import("../../../../packages/e2e-tests/src/prepare-context-db");
const { PiRpcProtocol, attachStrictJsonlReader } = await import("../../../../packages/e2e-tests/src/pi-runner/rpc-client");
const { MockProvider } = await import("../../../../packages/e2e-tests/src/mock-provider/server");
const mode = process.argv[2] ?? "slow";
const fixed = process.argv.includes("--fixed");
const holdArg = process.argv.find(arg => arg.startsWith("--hold="));
const hold = holdArg ? Number(holdArg.slice(7)) : ["refuse","outcome"].includes(mode) && fixed ? 60 : 0;
if (!Number.isFinite(hold) || hold < 0) throw new Error("invalid writer hold");
if (!["fast", "slow", "refuse", "late-mc", "fenced", "ephemeral", "outcome"].includes(mode)) throw new Error("invalid mode");
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({ text: "mock reply", usage: { input_tokens: 1000, output_tokens: 10 } });
if (mode === "ephemeral") mock.addMatcher(body => JSON.stringify(body.messages).includes("MC641_SIDE") ? {text:"side reply",usage:{input_tokens:1000,output_tokens:10},delayMs:2000} : null);
const iso = createPiIsolatedEnv(undefined, "omp");
prepareContextDatabase(iso.dataDir);
writeConfigs(iso, { host: "omp", mockProviderURL: baseURL, modelContextLimit: 256000,
  magicContextConfig: { debug_rpc: true, memory: { enabled: false }, embedding: { provider: "off" }, dreamer: { disable: true } } });
const env = childEnv(iso);
Object.assign(env, { TMPDIR: root, MC641_ROOT: iso.baseDir, MC641_MODE: mode,
  MAGIC_CONTEXT_LOG_PATH: join(iso.baseDir, "magic-context.log"), MAGIC_CONTEXT_PI_SERVED_BODY_CAPTURE: "1" });
const probe = join(iso.baseDir, "probe.mjs");
writeFileSync(probe, `
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
const db = new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR + '/context.db');
const audit = value => appendFileSync(process.env.MC641_ROOT + '/audit.jsonl', JSON.stringify({at:Date.now(), ...value})+'\\n');
export default async function(pi) {
  const mode = process.env.MC641_MODE;
  let managed = false;
  if (mode === 'fenced' && !${JSON.stringify(fixed)}) pi.on('before_provider_request',(_event,ctx)=> {
    audit({phase:'provider-fence',managed});
    if (!managed) { pi.appendEntry('deadline-probe-refusal',{message:'No managed context receipt; refusing provider dispatch'}); ctx.abort(); }
  });
  const inspect = (event,ctx) => {
    db.query('SELECT count(*) FROM sqlite_master').get();
    const lsof = execFileSync('/usr/sbin/lsof',['-p',String(process.pid)],{encoding:'utf8'});
    const dbLines = lsof.split('\\n').filter(line => /\\.db(?:[- ]|$)/.test(line));
    audit({phase:'start',pid:process.pid,eventKeys:Object.keys(event),ctxKeys:Object.keys(ctx),eventSignal:!!event.signal,ctxSignal:!!ctx.signal,dbLines});
    if (!dbLines.length || dbLines.some(line => !line.includes(process.env.MC641_ROOT))) throw new Error('store isolation failed');
  };
  const fixed = ${JSON.stringify(fixed)};
  const sideReminder = 'Ephemeral side-channel turn; reuses current conversation context.';
   const sideContext = event => event.messages.at(-1)?.role === 'user' && event.messages.at(-1)?.attribution === 'agent' && event.messages.some(m => m.role === 'developer' && m.attribution === 'agent' && JSON.stringify(m.content).includes(sideReminder));
  const sidePayload = event => JSON.stringify(event.payload).includes(sideReminder);
  if (fixed) {
    const {default:magicContext} = await import(${JSON.stringify(join(repo, "packages/pi-plugin/dist/index.js"))});
    if (mode === 'fenced') pi.on('before_provider_request',()=>{throw new Error('MC641 injected payload-hook error');});
    const proxied = new Proxy(pi,{get(target,key){
      if (key === 'on') return (name,handler) => target.on(name,
        name === 'context' ? async (event,ctx) => {
           const side = sideContext(event);
           audit({phase:'hook-enter',side});
           inspect(event,ctx); audit({phase:'context-enter',side,sideSignature:side?event.messages.slice(-2):undefined});
           if (['slow','fenced'].includes(mode)) await Bun.sleep(32000);
           if (['fast','ephemeral'].includes(mode)) await Bun.sleep(10);
           if (['late-mc','outcome'].includes(mode)) {
             const original = ctx.sessionManager.getLeafId.bind(ctx.sessionManager);
            let stalled = false;
            ctx = Object.assign(Object.create(ctx),{sessionManager:new Proxy(ctx.sessionManager,{get(sm,k){
               if(k === 'getLeafId') return () => { if(!stalled){stalled=true;audit({phase:'stall-start'});const end=performance.now()+(mode==='outcome'?25100:32000);while(performance.now()<end){} audit({phase:'stall-end'});} return original();};
              const v=sm[k];return typeof v==='function'?v.bind(sm):v;
            }})});
          }
          const originalAbort=ctx.abort;
          ctx=Object.assign(Object.create(ctx),{abort:()=>{audit({phase:'abort',side});return originalAbort();}});
          try {const result=await handler(event,ctx);audit({phase:'context-end',side,returnedMessages:result?.messages?.length});return result;}
          catch(error){audit({phase:'context-error',side,error:String(error)});throw error;}
        } : name === 'before_provider_request' ? (event,ctx)=>{
          const side=sidePayload(event); audit({phase:'provider-fence',side,payloadKeys:Object.keys(event.payload)});
          const abort=ctx.abort;
          return handler(event,Object.assign(Object.create(ctx),{abort:()=>{audit({phase:'payload-abort',side});return abort();}}));
        } : handler);
       if (key === 'appendEntry') return (type,data)=>{audit({phase:'entry',type,data});return target.appendEntry(type,data);};
       const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
    await magicContext(proxied);
     if(mode==='ephemeral') pi.on('agent_start',async (_event,ctx)=>{
       void ctx.runEphemeralTurn({promptText:'MC641_SIDE',tools:false}).then(result=>audit({phase:'side-done',reply:result.replyText}),error=>audit({phase:'side-error',error:String(error)}));
       // Start the main context after the side callback has entered, not after it finishes.
       await Bun.sleep(20);
    });
    return;
  }
  if (mode === 'late-mc') {
    const {default:magicContext} = await import(${JSON.stringify(join(repo, "packages/pi-plugin/dist/index.js"))});
    const proxied = new Proxy(pi,{get(target,key){
      if (key === 'on') return (name,handler) => target.on(name,name === 'context' ? async (event,ctx) => {
        inspect(event,ctx); await Bun.sleep(32000);
        audit({phase:'late-mc-start'}); const result = await handler(event,ctx);
        audit({phase:'late-mc-end',returnedMessages:result?.messages?.length}); return result;
      } : handler);
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    }});
    await magicContext(proxied);
  } else pi.on('context',async (event,ctx) => {
    inspect(event,ctx);
    await Bun.sleep(mode === 'fast' ? 10 : mode === 'refuse' ? 25000 : 32000);
    if (mode === 'refuse') { pi.appendEntry('deadline-probe-refusal',{message:'Managed turn refused before host deadline'}); ctx.abort(); }
    managed = true;
    audit({phase:'end',eventSignal:!!event.signal,ctxSignal:!!ctx.signal});
    return {messages:event.messages.map(m => m.role === 'user' ? {...m,content:[{type:'text',text:'MC641_TRANSFORMED'}]} : m)};
  });
}
`);
const cli = resolve(repo, ".cache/issue-641/host/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
const version = execFileSync(process.execPath, [cli, "--version"], { env, cwd: iso.workdir, encoding: "utf8" }).trim();
const host = spawn(process.execPath, [cli, "--mode", "rpc", "--no-extensions", "--extension", probe, "--no-skills", "--no-rules", "--model", "mock/mock-model", "--api-key", "test-key-not-real"], { env, cwd: iso.workdir, stdio: ["pipe", "pipe", "pipe"] });
const rpc = new PiRpcProtocol();
attachStrictJsonlReader(host.stdout!, line => rpc.dispatchLine(line));
host.stderr!.on("data", data => appendFileSync(join(iso.baseDir, "stderr.txt"), data));
rpc.onEvent(event => appendFileSync(join(iso.baseDir, "events.jsonl"), JSON.stringify({at: Date.now(), ...event}) + "\n"));
const command = (type: string, params = {}) => rpc.sendCommand(line => host.stdin!.write(line), type, params, { timeoutMs: 90000 });
let locker: ReturnType<typeof spawn> | undefined;
try {
  await command("get_state");
  if (hold) {
    locker = spawn('python3',['-u','-c','import sqlite3,time,sys; db=sqlite3.connect(sys.argv[1]);db.execute("BEGIN IMMEDIATE");print("locked",flush=True);time.sleep(float(sys.argv[2]));db.rollback()',join(iso.dataDir,'cortexkit','magic-context','context.db'),String(hold)],{env,cwd:iso.workdir,stdio:['ignore','pipe','pipe']});
    await new Promise<void>((done,reject)=>{locker!.stdout!.once('data',()=>done());locker!.once('error',reject);});
    const descriptors = execFileSync('/usr/sbin/lsof',['-p',String(locker.pid)],{encoding:'utf8'});
    writeFileSync(join(iso.baseDir,'locker-lsof.txt'),descriptors);
    const databases=descriptors.split('\n').filter(line=>/\.db(?:[- ]|$)/.test(line));
    if(!databases.length || databases.some(line=>!line.includes(iso.baseDir))) throw new Error('locker isolation failed');
  }
  const done = rpc.waitForEvent(e => e.type === "agent_end", { timeoutMs: 90000 });
  const start = Date.now();
  await command("prompt", { message: "MC641_ORIGINAL" });
  await done;
  // Keep the host alive after its deadline so late context handlers can publish DB and replay results.
  await Bun.sleep(Math.max(0, start + 35000 - Date.now()));
  const requests = mock.requests();
  writeFileSync(join(iso.baseDir, "provider-requests.json"), JSON.stringify(requests, null, 2));
  const lsof = execFileSync("/usr/sbin/lsof", ["-p", String(host.pid)], { encoding: "utf8" });
  writeFileSync(join(iso.baseDir, "lsof-end.txt"), lsof);
  const dbLines = lsof.split("\n").filter(line => /\.db(?:[- ]|$)/.test(line));
  if (!dbLines.length || dbLines.some(line => !line.includes(iso.baseDir))) throw new Error("store isolation failed");
  const body = JSON.stringify(requests.map(r => r.body.messages));
  const summary = { mode, fixed, hold, version, root: iso.baseDir, pid: host.pid, requests: requests.length,
    firstRequestMs: requests[0] ? requests[0].receivedAt - start : null,
    originalOnWire: body.includes("MC641_ORIGINAL"), transformedOnWire: body.includes("MC641_TRANSFORMED"), dbLines };
  writeFileSync(join(iso.baseDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (fixed) {
    const {readFileSync}=await import('node:fs');
    const audit=readFileSync(join(iso.baseDir,'audit.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const notices=readFileSync(join(iso.baseDir,'events.jsonl'),'utf8');
    if(mode==='fast' && hold < 16.5 && requests.length!==1) throw new Error('managed fast pass missing');
     if(['slow','refuse','late-mc','fenced','outcome'].includes(mode) && requests.length) throw new Error('unmanaged provider dispatch');
     if(mode==='ephemeral' && (requests.length!==2 || !body.includes('MC641_SIDE') || !body.includes('MC641_ORIGINAL') || audit.some(row=>row.phase==='payload-abort'))) throw new Error('concurrent ephemeral/main operation unsafe');
     if(mode==='ephemeral') {
       const side=requests.find(request=>JSON.stringify(request.body.messages).includes('MC641_SIDE'));
       const main=requests.find(request=>JSON.stringify(request.body.messages).includes('MC641_ORIGINAL'));
       if(!side?.responseCompletedAt || !main || side.receivedAt>main.receivedAt || side.responseCompletedAt<=main.receivedAt) throw new Error('side/main requests did not overlap');
     }
     if(!['fast','ephemeral'].includes(mode) && (!notices.includes('Magic Context could not safely prepare') || !audit.some(row=>row.phase==='entry' && row.type==='magic-context-turn-refused' && /stage=.*elapsed=.*recovery=/.test(row.data.message)))) throw new Error('visible refusal missing');
     if(hold>16.5 && requests.length) throw new Error('held-writer refusal dispatched');
     if(mode==='outcome') {
       const stalled=audit.find(row=>row.phase==='stall-end');
       const returned=audit.find(row=>row.phase==='context-end');
       const entered=audit.find(row=>row.phase==='hook-enter');
       if(!stalled || !returned || !entered || returned.at-stalled.at>=1000 || returned.at-entered.at>=28000) throw new Error('outcome-edge fallback waited');
       const fallback={fallbackMs:returned.at-stalled.at,handlerElapsedMs:returned.at-entered.at,promptElapsedMs:returned.at-start,hold};
       writeFileSync(join(iso.baseDir,'fallback.json'),JSON.stringify(fallback,null,2));
       console.log(JSON.stringify(fallback));
     }
    if(locker) locker.kill('SIGTERM');
  } else {
  if (mode === "fast" && (!summary.transformedOnWire || summary.originalOnWire)) throw new Error("fast transform not observed");
  if (mode === "slow" && (!summary.originalOnWire || summary.transformedOnWire || requests.length !== 1)) throw new Error("timeout fallback not observed");
  if (["refuse","fenced"].includes(mode) && requests.length !== 0) throw new Error("refusal reached provider");
  }
} finally {
  locker?.kill('SIGTERM');
  host.kill("SIGTERM");
  await new Promise(done => host.once("exit", done));
  await mock.stop();
}

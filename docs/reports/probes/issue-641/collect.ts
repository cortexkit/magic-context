#!/usr/bin/env bun
// Preserve probe receipts in the selected evidence directory; databases remain disposable.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
const repo = resolve(import.meta.dir,"../../../..");
const allowed = join(realpathSync(tmpdir()),"magic-context","issue-641")+"/";
const implementation = process.argv.includes("--implementation");
const evidence = process.env.MC_PROBE_EVIDENCE_DIR ?? join(import.meta.dir,"evidence", ...(implementation ? ["implementation"] : []));
mkdirSync(evidence,{recursive:true});
const receipt: unknown[] = [];
for (const rootArg of process.argv.slice(2).filter(arg => arg !== "--implementation")) {
  const root = realpathSync(rootArg);
  if (!root.startsWith(allowed)) throw new Error("not a disposable issue-641 root: "+root);
  const names = readdirSync(root);
  if (names.includes("summary.json")) {
    const summary = JSON.parse(readFileSync(join(root,"summary.json"),"utf8"));
    const label = summary.mode + (summary.hold ? `-hold-${summary.hold}` : "");
    const fallback = names.includes("fallback.json") ? JSON.parse(readFileSync(join(root,"fallback.json"),"utf8")) : undefined;
    const requests = JSON.parse(readFileSync(join(root,"provider-requests.json"),"utf8"));
    const audit = readFileSync(join(root,"audit.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const events = readFileSync(join(root,"events.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const db = new Database(join(root,"data/cortexkit/magic-context/context.db"),{readonly:true});
    const state = {
      tags:db.query("SELECT session_id,status,count(*) AS n FROM tags GROUP BY session_id,status").all(),
      meta:db.query("SELECT session_id,last_transform_error,last_input_tokens,last_context_percentage FROM session_meta").all(),
      lkg:db.query("SELECT session_id,json_prefix_chars,json_prefix_hash,captured_at,capture_sequence FROM lkg_slots").all(),
      decisions:db.query("SELECT * FROM transform_decisions").all(),
    };
    db.close();
    const ledgerDir = join(root,"data/cortexkit/magic-context/pi-served-array-digests");
    let ledger: unknown[] = [];
    try {ledger=readdirSync(ledgerDir).flatMap(f=>readFileSync(join(ledgerDir,f),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)));} catch { /* Modes without Magic Context have no served-array ledger. */ }
    const bodyDir = join(root,"data/cortexkit/magic-context/pi-served-array-bodies");
    const identityDir = join(root,"data/cortexkit/magic-context/pi-served-tag-numbers");
    let servedNumbers: unknown[] = [];
    try {servedNumbers=readdirSync(identityDir).flatMap(f=>readFileSync(join(identityDir,f),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)));} catch { /* Refused turns have no durable served-number records. */ }
    let servedBodies: Array<{messages:Array<{content:unknown}>}> = [];
    try {servedBodies=readdirSync(bodyDir).flatMap(f=>readFileSync(join(bodyDir,f),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)));} catch { /* Refusing a turn produces no managed-body file; the missing directory is expected. */ }
    const texts = (messages:Array<{content:unknown}>) => messages.flatMap(message=>typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content.filter(part=>part.type==='text').map(part=>part.text) : []);
    const servedOnWire = servedBodies.map(body=>{
      const expected=texts(body.messages);
      return expected.length > 0 && requests.some((request:any)=>{
        const actual=texts(request.body.messages).join("\n");
        return expected.every(text=>actual.includes(text));
      });
    });
    if(implementation && servedOnWire.some(found=>!found)) throw new Error("captured managed text absent from actual provider body");
    if(implementation && summary.mode==='fast' && !servedOnWire.length) throw new Error("managed fast pass has no served-body capture");
    if(implementation && !summary.requests && (servedNumbers.length || ledger.length || servedBodies.length || state.lkg.length || state.decisions.length || state.tags.some((row:any)=>row.status==='dropped'))) throw new Error("late publication after refusal");
    const diagnostics = implementation && names.includes("magic-context.log") ? readFileSync(join(root,"magic-context.log"),"utf8").split("\n").filter(line=>/DISCARDED CONTEXT|OMP context counts|dispatch fence disabled|refused-turn diagnostic/.test(line)) : [];
    writeFileSync(join(evidence,`host-${label}.json`),JSON.stringify({summary,fallback,audit,state,ledger,servedNumbers,servedBodies,servedOnWire,diagnostics,events:events.filter(e=>["extension_error","agent_end","message_end","extension_ui_request"].includes(e.type)),requests},null,2)+"\n");
    copyFileSync(join(root,"lsof-end.txt"),join(evidence,`host-${label}-lsof.txt`));
    if (names.includes("locker-lsof.txt")) copyFileSync(join(root,"locker-lsof.txt"),join(evidence,`host-${label}-locker-lsof.txt`));
    receipt.push({mode:summary.mode,root,requestBodySha256:requests.map((r:any)=>createHash("sha256").update(r.rawBody ?? JSON.stringify(r.body)).digest("hex"))});
  } else {
    const report = JSON.parse(readFileSync(join(root,"report.json"),"utf8"));
    const label = receipt.filter((r:any)=>r.kind==="fixture").length === 0 ? "master" : "issue-640-tip";
    writeFileSync(join(evidence,`fixture-${label}.json`),JSON.stringify(report,null,2)+"\n");
    for (const file of names.filter(name=>name.endsWith("-lsof.txt") || name.endsWith("-markers.jsonl"))) copyFileSync(join(root,file),join(evidence,`${label}-${file}`));
    receipt.push({kind:"fixture",label,root});
  }
}
const sourceDir = join(repo,".cache/issue-641/host/node_modules/@oh-my-pi/pi-coding-agent");
const sources: Array<[string,Array<[number,number]>]> = [["src/extensibility/extensions/runner.ts",[[130,143],[261,279],[293,368],[1490,1575],[1969,2036],[2038,2073]]],["src/sdk.ts",[[4141,4150]]],["src/session/agent-session.ts",[[11161,11177]]]];
let excerpts = "OMP @oh-my-pi/pi-coding-agent 18.8.6; MIT; Stencil Labs, Inc. / Mario Zechner.\nOriginal line numbers preserved below.\n";
for (const [file,ranges] of sources) {
  const source = readFileSync(join(sourceDir,file),"utf8");
  excerpts += `\n${file} SHA256 ${createHash("sha256").update(source).digest("hex")}\n`;
  const lines=source.split("\n");
  for(const [first,last] of ranges) excerpts += lines.slice(first-1,last).map((line,i)=>`${i+first}: ${line}`.trimEnd()).join("\n")+"\n";
}
writeFileSync(join(evidence,"omp-source-excerpts.txt"),excerpts);
copyFileSync(join(sourceDir,"LICENSE"),join(evidence,"omp-LICENSE.txt"));
writeFileSync(join(evidence,"receipts.json"),JSON.stringify(receipt,null,2)+"\n");
console.log(`Preserved ${receipt.length} run receipts in ${evidence}`);

#!/usr/bin/env bun
// Reuse the baseline archive made by differential.ts without adding deadline or dispatch protections to its product code.
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const repo = resolve(import.meta.dir,"../../../..");
const base = join(repo,".cache/issue-641/ff8d438a16ebbc3eae82acd29ea572731b086971");
const root = join(realpathSync(tmpdir()),"magic-context","issue-641","base-acceptance");
mkdirSync(join(root,"home"),{recursive:true});
const source = "packages/pi-plugin/src";
for(const name of ["issue-641-deadline.test.ts","issue-641-publication.test.ts","issue-641-dispatch.test.ts","issue-640-deadline-review-r2.test.ts","pi-context-budget.ts"]) copyFileSync(join(repo,source,name),join(base,source,name));
// The missing-receipt dispatch test never calls clearPiContextReceipt. That
// export is absent from the baseline, so replace its import with a test-only no-op.
const dispatchPath=join(base,source,"issue-641-dispatch.test.ts");
const dispatchSource=readFileSync(dispatchPath,"utf8");
const adapted=dispatchSource.replace(/import\s*\{\s*clearPiContextReceipt,\s*registerPiGuardedContext,?\s*\}\s*from "\.\/pi-context-refusal";/, 'import { registerPiGuardedContext } from "./pi-context-refusal";\nconst clearPiContextReceipt = (_session: string) => {};');
if(adapted===dispatchSource) throw new Error("dispatch test compatibility import not found");
writeFileSync(dispatchPath,adapted);
// The budget module is only a test clock for the publication tests on base. None
// of base's product modules imports it, so they cannot inherit its deadline checks.
const env: NodeJS.ProcessEnv={...process.env, HOME:join(root,"home"), TMPDIR:root, XDG_DATA_HOME:join(root,"data"), XDG_CONFIG_HOME:join(root,"config"), XDG_STATE_HOME:join(root,"state"), XDG_RUNTIME_DIR:join(root,"runtime"), MAGIC_CONTEXT_STORAGE_DIR:join(root,"storage"), MC640_R2_DEADLINE:"1"};
delete env.OPENCODE_DB;
const cases = [
  {file:"issue-641-deadline.test.ts",timeout:"5000",name:"emergency foreground never joins a still-running historian"},
  {file:"issue-641-publication.test.ts",timeout:"5000",name:"expired deferred publication cannot flush LKG, served capture or a transform decision"},
  {file:"issue-641-publication.test.ts",timeout:"5000",name:"serialization stalled past deadline does not replace LKG or advance served tags"},
  {file:"issue-641-dispatch.test.ts",timeout:"5000",name:"OMP dispatch fence refuses missing, in-progress and expired receipts synchronously"},
  {file:"issue-640-deadline-review-r2.test.ts",timeout:"90000",name:"r2: writer wait plus in-flight historian must fit OMP's 30-second deadline"},
];
const results=[];
const evidence=join(import.meta.dir,"evidence/implementation");
mkdirSync(evidence,{recursive:true});
for(const [index,item] of cases.entries()) {
  const child=Bun.spawn([process.execPath,"test",join(base,source,item.file),"--timeout",item.timeout,"-t",item.name],{env,cwd:join(base,"packages/pi-plugin"),stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  const output=stdout+stderr;
  writeFileSync(join(evidence,`base-acceptance-${index+1}.txt`),output);
  const red=exit!==0 && output.includes("(fail) "+item.name) && !output.includes("between tests");
  const result={...item,exit,red};
  results.push(result);
  console.log(JSON.stringify(result));
  if(!red) throw new Error("baseline test did not fail for its behavior: "+item.name+"\n"+output);
}
writeFileSync(join(evidence,"base-acceptance.json"),JSON.stringify({revision:"ff8d438a16ebbc3eae82acd29ea572731b086971",results},null,2)+"\n");
// The native deadline test saves timings and lsof output listing its open files.
// Copy those small JSON and text receipts, never the disposable databases.
const {readdirSync}=await import("node:fs");
const nativeRoot=join(root,"magic-context/bg_a1704ae3546049d5");
for(const file of readdirSync(nativeRoot).filter(file=>file.endsWith(".json") || file.endsWith(".txt"))) writeFileSync(join(evidence,`base-native-${file}`),readFileSync(join(nativeRoot,file)));

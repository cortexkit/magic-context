import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
const root=resolve(".cortexkit/internal-docs/investigations/issue-632-isolated-host");
mkdirSync(root,{recursive:true});
const version=process.env.MC_E2E_OPENCODE2_VERSION!;
const cases=[
 ["long-running","tests/long-running-session.test.ts","exercises execute, notes, reduce, historian, native folds, and auto-search without native todos"],
 ["wrapup","tests/opencode2/commands-s2-wrapup.test.ts","converted-v1, reopen=true"],
 ["error-results","tests/opencode2/error-result-compaction.test.ts","converted OpenCode 1 error results"],
 ["recomp","tests/opencode2/recomp-hidden-executor.test.ts","converted-v1, reopen=true"],
 ["reporter","tests/opencode2/reporter-emergency-drop.test.ts","converted 750k session explicit flush"],
];
const records:Array<Record<string,unknown>>=[];
function run(args:string[],stage:string,cwd=process.cwd()) {
 const result=Bun.spawnSync(args,{cwd,env:{...process.env},stdout:"pipe",stderr:"pipe",timeout:900000});
 const text=new TextDecoder().decode(result.stdout)+new TextDecoder().decode(result.stderr);
 writeFileSync(join(root,`${version}-${stage}.log`),text);
 console.log("HOST_ISOLATED",JSON.stringify({version,stage,args,exit:result.exitCode}));
 console.log(text);
 records.push({version,stage,args,exit:result.exitCode});
 return result.exitCode;
}
let failed=0;
for(const phase of ["tip","base"]) {
 if(phase==="base") {
  const saved=JSON.parse(readFileSync("packages/e2e-tests/scripts/issue-632-base-sources.json","utf8"));
  for(const [path,text] of Object.entries(saved)) {
   if(text===null) {try{unlinkSync(path)}catch{}} else writeFileSync(path,text as string);
  }
 }
 if(run([process.execPath,"run","build:dists"],`${phase}-build`)) process.exit(1);
 const cwd=resolve("packages/e2e-tests");
 if(phase==="tip") failed ||= run([process.execPath,"test","--timeout","600000","tests/conflict-disable.test.ts","tests/deferred-compaction-marker.test.ts"],"tip-approved-contracts",cwd);
 for(const [name,file,pattern] of cases) run([process.execPath,"test","--timeout","600000",file,"-t",pattern],`${phase}-${name}`,cwd);
}
writeFileSync(join(root,`${version}-results.json`),JSON.stringify(records,null,2));
for(const [name] of cases) {
 const tip=records.find(r=>r.stage===`tip-${name}`), base=records.find(r=>r.stage===`base-${name}`);
 if(tip?.exit!==0 && base?.exit===0) failed=1;
}
process.exit(failed);

#!/usr/bin/env bun
// Archive a revision inside this worktree; resolve core imports into that archive.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const repo = resolve(import.meta.dir, "../../../..");
const ref = process.env.MC_PROBE_BASE_REF ?? "ff8d438a16ebbc3eae82acd29ea572731b086971";
const snapshot = join(repo,".cache","issue-641",ref);
mkdirSync(snapshot,{recursive:true});
execFileSync("git",["archive","--format=tar","--output",join(snapshot,"source.tar"),ref],{cwd:repo});
execFileSync("tar",["-xf",join(snapshot,"source.tar"),"-C",snapshot]);
for (const relative of ["node_modules",...readdirSync(join(repo,"packages")).map(p=>join("packages",p,"node_modules"))]) {
  if (existsSync(join(repo,relative)) && !existsSync(join(snapshot,relative))) symlinkSync(realpathSync(join(repo,relative)),join(snapshot,relative),"dir");
}
const target = join(snapshot,"docs","reports","probes","issue-641");
mkdirSync(target,{recursive:true});
copyFileSync(join(import.meta.dir,"differential-fixture.ts"),join(target,"differential-fixture.ts"));
const parent = join(realpathSync(tmpdir()),"magic-context","issue-641");
mkdirSync(parent,{recursive:true});
const root = mkdtempSync(join(parent,"differential-"));
mkdirSync(join(root,"work"),{recursive:true});
execFileSync("git",["init",join(root,"work")]);
execFileSync("git",["-C",join(root,"work"),"remote","add","origin","https://example.invalid/issue-641-differential.git"]);
const receipts: Array<{revision:string; root:string; outputSha256:string; rowsSha256:string}> = [];
for (const [revision,dir] of [[ref,snapshot],["head",repo]]) {
  const laneRoot=join(root,revision);
  const env={...process.env, HOME:join(root,"home"), XDG_DATA_HOME:join(root,"data"), XDG_CONFIG_HOME:join(root,"config"), XDG_STATE_HOME:join(root,"state"), XDG_RUNTIME_DIR:join(root,"runtime"), OPENCODE_DB:join(root,"opencode.db"), MAGIC_CONTEXT_STORAGE_DIR:laneRoot, MC641_DIFF_ROOT:laneRoot, MC641_DIFF_CWD:join(root,"work")};
  const tsconfig=join(dir,"packages","pi-plugin","tsconfig.json");
  const resolution=execFileSync(process.execPath,["--tsconfig-override",tsconfig,"-e","console.log(import.meta.resolve('@magic-context/core/shared/sqlite'))"],{cwd:join(dir,"packages","pi-plugin"),env,encoding:"utf8"}).trim();
  if(!resolution.includes(dir+"/packages/plugin/src/shared/sqlite.ts")) throw new Error("wrong core resolution: "+resolution);
  execFileSync(process.execPath,["--tsconfig-override",tsconfig,join(dir,"docs/reports/probes/issue-641/differential-fixture.ts")],{cwd:dir,env,stdio:"inherit"});
  const hash=(file:string)=>createHash("sha256").update(readFileSync(join(laneRoot,file))).digest("hex");
  receipts.push({revision,root:laneRoot,outputSha256:hash("output.json"),rowsSha256:hash("rows.json")});
}
for (const file of ["output.json","rows.json"]) {
  if (!readFileSync(join(receipts[0].root,file)).equals(readFileSync(join(receipts[1].root,file)))) throw new Error("differential differs: "+file);
}
const evidence=process.env.MC_PROBE_EVIDENCE_DIR ?? join(import.meta.dir,"evidence","implementation");
mkdirSync(evidence,{recursive:true});
for (const lane of receipts) for(const file of ["output.json","rows.json","lsof.txt"]) copyFileSync(join(lane.root,file),join(evidence,`diff-${lane.revision==='head'?'head':'base'}-${file}`));
writeFileSync(join(evidence,"differential.json"),JSON.stringify({passed:true,turns:3,receipts},null,2)+"\n");
console.log(JSON.stringify({passed:true,turns:3,receipts}));

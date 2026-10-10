#!/usr/bin/env bun
// Materialize another revision inside this worktree, without switching or editing product files.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
const repo = resolve(import.meta.dir,"../../../..");
const ref = process.argv[2];
if (!ref || !/^[a-f0-9]{40}$/.test(ref)) throw new Error("supply a full commit SHA");
const dir = join(repo,".cache","issue-641",ref);
mkdirSync(dir,{recursive:true});
const archive = join(dir,"snapshot.tar");
execFileSync("git",["archive","--format=tar","--output",archive,ref],{cwd:repo});
execFileSync("tar",["-xf",archive,"-C",dir]);
for (const relative of ["node_modules",...readdirSync(join(repo,"packages")).flatMap(p => [join("packages",p,"node_modules"),join("packages",p,"dist")])]) {
  if (existsSync(join(repo,relative)) && !existsSync(join(dir,relative))) symlinkSync(realpathSync(join(repo,relative)),join(dir,relative),"dir");
}
const target = join(dir,"docs","reports","probes","issue-641");
mkdirSync(target,{recursive:true});
for(const file of ["fixture.ts"]) execFileSync("cp",[join(import.meta.dir,file),join(target,file)]);
const tsconfig = join(dir,"packages","pi-plugin","tsconfig.json");
const probe = Bun.spawn([process.execPath,"--tsconfig-override",tsconfig,"-e","console.log(JSON.stringify({sqlite:import.meta.resolve('@magic-context/core/shared/sqlite')}))"],{cwd:join(dir,"packages","pi-plugin"),stdout:"pipe",stderr:"inherit"});
const resolution = await new Response(probe.stdout).text();
if (await probe.exited !== 0 || !resolution.includes(dir+"/packages/plugin/src/shared/sqlite.ts")) throw new Error("snapshot resolved base SQLite: "+resolution);
console.log(JSON.stringify({ref,snapshot:dir,resolution:JSON.parse(resolution)}));
const child = Bun.spawn([process.execPath,"--tsconfig-override",tsconfig,join(target,"fixture.ts")],{cwd:join(dir,"packages","pi-plugin"),stdout:"inherit",stderr:"inherit"});
process.exitCode = await child.exited;

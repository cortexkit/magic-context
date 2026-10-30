import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const { ensureSharedOpenCode2 } = await import(resolve("packages/e2e-tests/scripts/ensure-shared-opencode2.ts"));
const requested = process.argv[2] ?? "2.1.0";
let version = requested;
if (requested === "newest-2.2") {
  const registry = await (await fetch("https://registry.npmjs.org/@opencode%2fcli")).json() as {versions:Record<string,unknown>};
  version = Object.keys(registry.versions).filter(v=>/^2\.2\.\d+$/.test(v)).sort((a,b)=>Number(a.split('.')[2])-Number(b.split('.')[2])).at(-1)!;
  if (!version) throw new Error("No stable 2.2.x CLI in registry");
}
const root = join(process.env.TMPDIR ?? "/tmp", "magic-context/issue-632");
mkdirSync(root, { recursive: true });
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR"]) {
  process.env[key] = join(root, "installer", key);
  mkdirSync(process.env[key]!, { recursive: true });
}
process.env.OPENCODE_DB = join(root, "installer/opencode.db");
process.env.PATH = [process.env.PATH, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":");
process.env.TMPDIR = root;
const artifacts = resolve(`.cortexkit/internal-docs/investigations/issue-632-fixed-evidence/${requested === "newest-2.2" ? requested : version}`);
mkdirSync(artifacts, { recursive: true });
writeFileSync(join(artifacts,"install.json"),JSON.stringify({requested,version,root},null,2));
console.log("ISSUE632_INSTALL", JSON.stringify({requested,version,root}));
const cli = ensureSharedOpenCode2(version, join(root, "hosts"));
if (version.startsWith("2.2.")) {
  // Probe-only matching schema bundle. The product's pinned matrix stays unchanged.
  const schemaRoot = join(root, "schema", version);
  mkdirSync(schemaRoot,{recursive:true});
  writeFileSync(join(schemaRoot,"package.json"), JSON.stringify({name:"issue-632-host-schema",private:true,dependencies:{"@opencode/ai":version}}));
  const install = Bun.spawnSync(["bun","install","--linker=hoisted"],{cwd:schemaRoot,env:{...process.env},stdout:"inherit",stderr:"inherit"});
  if (install.exitCode) process.exit(install.exitCode);
  const guardPath = "packages/e2e-tests/src/opencode2-runner/schema-guard.ts";
  const guard = readFileSync(guardPath,"utf8")
    .replace('const generation = schemaGeneration(probe.stdout.trim());', `if (probe.stdout.trim() !== ${JSON.stringify(`opencode v${version}`)}) throw new Error("wrong exact host version"); const generation = ${JSON.stringify(version)};`)
    .replace('const module = generation === "2.1" ? "@opencode/ai-2-1" : "@opencode/ai";', '')
    .replace(/Bun\.resolveSync\(\s*path\.replace\("@opencode\/ai", module\),\s*import\.meta\.dir,?\s*\)/, `(${JSON.stringify(join(schemaRoot, "node_modules/@opencode/ai/dist/"))} + path.replace("@opencode/ai/", "") + ".js")`);
  if (guard.includes('path.replace("@opencode/ai", module)')) throw new Error("matching schema override did not apply");
  writeFileSync(guardPath,guard);
  writeFileSync(join(artifacts,"schema-guard.probe.ts"),guard);
}
const probe = "packages/e2e-tests/scripts/issue-632-fold-probe.ts";
let text = readFileSync(probe, "utf8").replace('resolve(`target/issue-632-hosts/${version}/node_modules/@opencode/cli/bin/opencode.exe`)', JSON.stringify(cli));
text = text.replace('join(process.env.TMPDIR!, "evidence", version)', JSON.stringify(artifacts));
writeFileSync(probe, text);
const build = Bun.spawnSync(["bun", "run", "--cwd", "packages/plugin", "build"], {env:{...process.env},stdout:"inherit", stderr:"inherit"});
if (build.exitCode) process.exit(build.exitCode);
const run = Bun.spawnSync(["bun", probe, version], {env:{...process.env,TMPDIR:root},stdout:"pipe", stderr:"pipe", timeout:600000});
writeFileSync(join(artifacts,"probe.stdout.log"),run.stdout);
writeFileSync(join(artifacts,"probe.stderr.log"),run.stderr);
console.log(new TextDecoder().decode(run.stdout));
console.error(new TextDecoder().decode(run.stderr));
console.log("ISSUE632_FIXED_EXIT", run.exitCode);
process.exit(run.exitCode);

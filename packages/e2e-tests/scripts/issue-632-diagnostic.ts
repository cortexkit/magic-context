import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
const { ensureSharedOpenCode2 } = await import(resolve("packages/e2e-tests/scripts/ensure-shared-opencode2.ts"));

const root = join(process.env.TMPDIR ?? "/tmp", "magic-context/issue-632");
mkdirSync(root, { recursive: true });
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR"]) {
  process.env[key] = join(root, "installer", key);
  mkdirSync(process.env[key]!, { recursive: true });
}
process.env.OPENCODE_DB = join(root, "installer/opencode.db");
process.env.TMPDIR = root;
const artifacts = resolve(".cortexkit/internal-docs/investigations/issue-632-current-evidence");
mkdirSync(artifacts, { recursive: true });
const cli = ensureSharedOpenCode2("2.0.22", join(root, "hosts"));
const probe = "packages/e2e-tests/scripts/issue-632-fold-probe.ts";
let text = readFileSync(probe, "utf8").replace('resolve(`target/issue-632-hosts/${version}/node_modules/@opencode/cli/bin/opencode.exe`)', JSON.stringify(cli));
text = text.replace('join(process.env.TMPDIR!, "evidence", version)', JSON.stringify(artifacts));
writeFileSync(probe, text);
const instrument = (path: string, before: string, after: string) => {
  const text = readFileSync(path, "utf8");
  if (!text.includes(before)) throw new Error(`instrumentation anchor missing: ${path}`);
  writeFileSync(path, text.replace(before, after));
};
instrument("packages/plugin/src/v2/fold/memory-cache.ts", "if (!state.active && state.bytes > this.budget.maxSessionBytes) this.evict(id);", 'if (!state.active && state.bytes > this.budget.maxSessionBytes) { console.error("ISSUE632_BUDGET", JSON.stringify({id, ...state, budget:this.budget.maxSessionBytes})); this.evict(id); }');
instrument("packages/plugin/src/v2/hooks/context.ts", 'if (event.type !== "session.execution.succeeded") continue;', 'if (event.type !== "session.execution.succeeded") continue; console.error("ISSUE632_SUCCEEDED", sessionID, "baseline", typeof (await nativeFoldReplay?.baseline(sessionID)));');
instrument("packages/plugin/src/v2/fold/idle.ts", "this.active(sessionID);\n        let ttl", 'console.error("ISSUE632_IDLE", sessionID, cacheTtl, lastResponseTime, this.now()); this.active(sessionID);\n        let ttl');
instrument("packages/plugin/src/v2/fold/policy.ts", 'const { storage, session, threshold } = this.deps;', 'console.error("ISSUE632_POLICY", sessionID); const { storage, session, threshold } = this.deps;');
const build = Bun.spawnSync(["bun", "run", "--cwd", "packages/plugin", "build"], {stdout:"inherit", stderr:"inherit"});
if (build.exitCode) process.exit(build.exitCode);
const run = Bun.spawnSync(["bun", probe, "2.0.22"], {stdout:"pipe", stderr:"pipe", timeout:600000});
writeFileSync(join(artifacts,"diagnostic.stdout.log"),run.stdout);
writeFileSync(join(artifacts,"diagnostic.stderr.log"),run.stderr);
console.log(new TextDecoder().decode(run.stdout));
console.error(new TextDecoder().decode(run.stderr));
console.log("ISSUE632_DIAGNOSTIC_EXIT", run.exitCode);
process.exit(run.exitCode);

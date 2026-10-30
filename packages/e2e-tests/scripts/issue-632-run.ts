import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const { ensureSharedOpenCode2 } = await import(resolve("packages/e2e-tests/scripts/ensure-shared-opencode2.ts"));
const version = process.argv[2] ?? "2.0.22";
const root = join(process.env.TMPDIR ?? "/tmp", "magic-context/issue-632");
mkdirSync(root, { recursive: true });
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR"]) {
  process.env[key] = join(root, "installer", key);
  mkdirSync(process.env[key]!, { recursive: true });
}
process.env.OPENCODE_DB = join(root, "installer/opencode.db");
process.env.PATH = [process.env.PATH, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":");
process.env.TMPDIR = root;
const artifacts = resolve(`.cortexkit/internal-docs/investigations/issue-632-fixed-evidence/${version}`);
mkdirSync(artifacts, { recursive: true });
const cli = ensureSharedOpenCode2(version, join(root, "hosts"));
const probe = "packages/e2e-tests/scripts/issue-632-fold-probe.ts";
let text = readFileSync(probe, "utf8").replace('resolve(`target/issue-632-hosts/${version}/node_modules/@opencode/cli/bin/opencode.exe`)', JSON.stringify(cli));
text = text.replace('join(process.env.TMPDIR!, "evidence", version)', JSON.stringify(artifacts));
writeFileSync(probe, text);
const build = Bun.spawnSync(["bun", "run", "--cwd", "packages/plugin", "build"], {stdout:"inherit", stderr:"inherit"});
if (build.exitCode) process.exit(build.exitCode);
const run = Bun.spawnSync(["bun", probe, version], {env:{...process.env,TMPDIR:root},stdout:"pipe", stderr:"pipe", timeout:600000});
writeFileSync(join(artifacts,"probe.stdout.log"),run.stdout);
writeFileSync(join(artifacts,"probe.stderr.log"),run.stderr);
console.log(new TextDecoder().decode(run.stdout));
console.error(new TextDecoder().decode(run.stderr));
console.log("ISSUE632_FIXED_EXIT", run.exitCode);
process.exit(run.exitCode);

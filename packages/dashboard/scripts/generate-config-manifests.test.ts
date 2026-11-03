import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("regenerating unchanged config manifests never rewrites their source files", () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const paths = ["tool-descriptions", "pi-thinking-levels"].map((name) =>
    join(packageRoot, "src/generated", `${name}.json`),
  );
  const before = paths.map((path) => ({
    text: readFileSync(path, "utf8"),
    modified: statSync(path, { bigint: true }).mtimeNs,
  }));
  const home = mkdtempSync(join(tmpdir(), "mc-dashboard-manifest-test-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_STATE_HOME: home,
      MAGIC_CONTEXT_STORAGE_DIR: home,
    };
    delete env.OPENCODE_DB;
    const result = spawnSync(process.execPath, ["run", "scripts/generate-config-manifests.ts"], {
      cwd: packageRoot,
      env,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const [index, path] of paths.entries()) {
      expect(readFileSync(path, "utf8")).toBe(before[index]!.text);
      expect(statSync(path, { bigint: true }).mtimeNs).toBe(before[index]!.modified);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

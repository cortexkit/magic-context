import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { piThinkingManifest, toolDescriptionManifest } from "./config-manifests";

const root = resolve(import.meta.dir, "..");
const target = resolve(root, "src/generated");
// Run Biome through its JavaScript launcher with Bun's own timeout. The GNU `timeout`
// command and the extensionless `.bin/biome` shim don't exist on Windows runners.
const biome = require.resolve("@biomejs/biome/bin/biome");

/** Format one manifest exactly as Biome formats the checked-in file at `path`. */
function formatted(path: string, raw: string): string {
  const name = relative(root, path);
  const result = Bun.spawnSync(
    [process.execPath, biome, "format", `--stdin-file-path=${name}`],
    {
      cwd: root,
      stdin: Buffer.from(raw),
      stdout: "pipe",
      stderr: "inherit",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.exitCode !== 0) throw new Error(`Could not format generated manifest ${name}`);
  return result.stdout.toString();
}

mkdirSync(target, { recursive: true });
for (const [name, value] of Object.entries({
  "tool-descriptions": toolDescriptionManifest(),
  "pi-thinking-levels": await piThinkingManifest(),
})) {
  const path = resolve(target, `${name}.json`);
  const next = formatted(path, `${JSON.stringify(value, null, 2)}\n`);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  // These manifests are checked in. Rewrite one only when its content changed:
  // remote build servers run gates on checkouts whose tracked files are
  // read-only, and an unchanged manifest must not fail the build there.
  if (current !== next) writeFileSync(path, next);
  console.log(
    `${current === next ? "Up to date" : "Generated"} ${name}: ${Object.keys(value).length} entries`,
  );
}

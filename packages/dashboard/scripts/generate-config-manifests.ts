import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { piThinkingManifest, toolDescriptionManifest } from "./config-manifests";

const target = resolve(import.meta.dir, "../src/generated");
mkdirSync(target, { recursive: true });
const biome = require.resolve("@biomejs/biome/bin/biome");
for (const [name, value] of Object.entries({ "tool-descriptions": toolDescriptionManifest(), "pi-thinking-levels": await piThinkingManifest() })) {
  const path = resolve(target, `${name}.json`);
  // Format before comparison so an unchanged read-only source snapshot needs no write.
  const format = Bun.spawnSync([process.execPath, biome, "format", "--stdin-file-path", path], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    stdout: "pipe",
    stderr: "inherit",
    timeout: 30_000,
    windowsHide: true,
  });
  if (format.exitCode !== 0) throw new Error("Could not format generated config manifests");
  const rendered = new TextDecoder().decode(format.stdout);
  if (!existsSync(path) || readFileSync(path, "utf8") !== rendered) writeFileSync(path, rendered);
  console.log(`Generated ${name}: ${Object.keys(value).length} entries`);
}

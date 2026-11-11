/** Plain Pi has no OMP dispatch structure fence; keep its native extension path unchanged. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2]!);
if (!process.argv[2]) throw new Error("Pass a throwaway output directory");
mkdirSync(out, { recursive: true });
const runtimeRoot = mkdtempSync(join(tmpdir(), "mc-pi-superpowers-"));
for (const name of [
  "HOME",
  "CFFIXED_USER_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "MAGIC_CONTEXT_STORAGE_DIR",
  "PI_CODING_AGENT_DIR",
]) {
  process.env[name] = join(runtimeRoot, name);
  mkdirSync(process.env[name]!, { recursive: true });
}
process.env.OPENCODE_DB = join(runtimeRoot, "opencode.db");
const { PiTestHarness } = await import("../src/pi-harness");
const { resolvePiHostInvocation } = await import("../src/pi-runner/spawn");
const version = JSON.parse(readFileSync(resolvePiHostInvocation("pi").packageJson, "utf8")).version;
if (version !== "0.87.1") throw new Error(`Expected pinned Pi 0.87.1, got ${version}`);
const harness = await PiTestHarness.create({
  host: "pi",
  extensionsAfterMagicContext: [
    resolve("target/scratch/superpowers-7.0.2/.pi/extensions/superpowers.ts"),
  ],
  magicContextConfig: {
    memory: { enabled: false },
    compressor: { enabled: false },
    dreamer: { disable: true },
  },
});
try {
  const session = await harness.createSession();
  await harness.sendPrompt(session, "PLAIN_PI_SUPERPOWERS_CONTROL");
  const requests = harness.mock
    .requests()
    .filter((request) => JSON.stringify(request.body).includes("PLAIN_PI_SUPERPOWERS_CONTROL"));
  if (
    requests.length !== 1 ||
    !JSON.stringify(requests[0].body).includes("superpowers:using-superpowers bootstrap for pi")
  )
    throw new Error("Real Pi did not send the Superpowers bootstrap and managed turn");
  if (harness.lastTurn?.stdout.includes("prepared turn structure"))
    throw new Error("Plain Pi acquired an OMP-only refusal");
  writeFileSync(join(out, "request.json"), requests[0].rawBody ?? JSON.stringify(requests[0].body));
  writeFileSync(
    join(out, "summary.json"),
    JSON.stringify(
      { host: "pi", version, requests: requests.length, completed: true, dataDir: harness.dataDir },
      null,
      2,
    ),
  );
  console.log(
    `real Pi ${version}: 1 request with Superpowers, completed without an OMP dispatch fence`,
  );
} finally {
  await harness.dispose();
  rmSync(runtimeRoot, { recursive: true, force: true });
}

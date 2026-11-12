import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const action = Bun.YAML.parse(await Bun.file(resolve(root, ".github/actions/restore-ci-dists/action.yml")).text()) as {
    runs: { steps: { name?: string; run?: string }[] };
};

function run(command: string[], env = process.env): string {
    const result = Bun.spawnSync(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

test("verified dist restoration selects production entry despite newer checkout mtimes", () => {
    const entry = resolve(root, "packages/plugin/dist/index.js");
    const original = statSync(entry);
    const scratch = mkdtempSync(resolve(tmpdir(), "ci-dist-freshness-"));
    const artifactDir = resolve(scratch, "ci-dists");
    mkdirSync(artifactDir);
    const archive = resolve(artifactDir, "ci-dists.tar.gz");
    const probe = () => run([process.execPath, "-e", "const {PLUGIN_ENTRY}=await import('./packages/e2e-tests/src/opencode-runner/spawn.ts'); console.log(PLUGIN_ENTRY)"]);
    try {
        utimesSync(entry, new Date(0), new Date(0));
        run(["tar", "-czf", archive, "packages/plugin/dist/index.js"]);
        writeFileSync(resolve(artifactDir, "ci-dists.sha256"), `${new Bun.CryptoHasher("sha256").update(readFileSync(archive)).digest("hex")}  ci-dists.tar.gz\n`);
        writeFileSync(resolve(artifactDir, "ci-dists.commit"), "same-checkout\n");
        expect(probe()).toMatch(/\/packages\/plugin\/src\/index\.ts$/);
        // The step before this one downloads the artifact and needs GitHub; this
        // test supplies the downloaded files itself and runs only the unpack step.
        const restore = action.runs.steps.find((step) => step.name === "Verify and unpack")?.run;
        expect(restore).toBeDefined();
        run(["bash", "-e", "-o", "pipefail", "-c", restore!], {
            ...process.env, RUNNER_TEMP: scratch, GITHUB_WORKSPACE: root, GITHUB_SHA: "same-checkout",
        });
        expect(probe()).toMatch(/\/packages\/plugin\/dist\/index\.js$/);
    } finally {
        utimesSync(entry, original.atime, original.mtime);
        rmSync(scratch, { recursive: true, force: true });
    }
}, 30_000);

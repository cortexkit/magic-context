import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realGit = Bun.which("git");
if (!realGit) throw new Error("git is required for release worktree tests");
const packages = ["plugin", "pi-plugin", "cli", "retina-local-fs"];
const temporaryRoots: string[] = [];

type Command = { name: string; args: string[]; cwd: string; head: string; branch: string };

// Only build checks run: schema generation stops the fixture before version
// edits, commits, tags or publication. Network tools are refused independently.
const bunShim = `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
const args = process.argv.slice(2);
const cwd = process.cwd();
const git = (...args) => execFileSync(process.env.REAL_GIT, args, { cwd, encoding: "utf8" }).trim();
const name = "bun";
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ name, args, cwd, head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current") }) + "\\n");
const fail = process.env.FAIL_STAGE;
if (args[0] === "install" && args[1] === "--frozen-lockfile") {
    if (fail === "install") process.exit(7);
} else if (args[0] === "run" && args[1] === "--cwd") {
    const directory = resolve(args[2]);
    const action = args[3];
    if (action === "build" || action === "typecheck") {
        if (action === "build") {
            mkdirSync(join(directory, "dist"), { recursive: true });
            writeFileSync(join(directory, "dist/index.js"), "release build\\n");
        }
        // Package typechecks also emit the shared Retina declarations.
        const declarations = join(directory, "../retina-local-fs/dist");
        mkdirSync(declarations, { recursive: true });
        writeFileSync(join(declarations, "index.js"), "release declarations\\n");
        if (fail === directory.split("/").at(-1)) process.exit(7);
    } else if (action === "audit:packed-packages") {
        for (const pkg of ["plugin", "pi-plugin", "cli"]) {
            if (readFileSync(join(directory, "packages", pkg, "dist/index.js"), "utf8") !== "release build\\n") process.exit(8);
        }
        if (fail === "audit") process.exit(7);
    } else if (!["lint", "test"].includes(action)) {
        throw new Error("Unexpected package action: " + action);
    }
    if (action === "test") console.log("1 pass\\n0 fail");
} else if (args[0].endsWith("validate-mode-manifest.ts")) {
    console.log("fixture.test.ts");
} else if (args[0].endsWith("run-slow-unit-tests.ts")) {
    console.log("1 pass\\n0 fail");
} else if (args[0] === "packages/plugin/scripts/build-schema.ts") {
    console.log("Fixture stopped before release edits");
    if (fail === "signal") process.kill(process.ppid, "SIGTERM");
    process.exit(79);
} else {
    throw new Error("Unexpected bun invocation: " + args.join(" "));
}
`;

function fixture(existingDists = true) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "release-build-test-")));
    temporaryRoots.push(root);
    const repo = join(root, "repo with spaces");
    const bin = join(root, "bin");
    const buildTemp = join(root, "build-temp");
    const log = join(root, "commands.jsonl");
    for (const path of [repo, bin, buildTemp]) mkdirSync(path);
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: join(root, "home"),
        TMPDIR: buildTemp,
        REAL_GIT: realGit,
        COMMAND_LOG: log,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
    });
    const git = (...args: string[]) =>
        execFileSync(realGit, args, { cwd: repo, env, encoding: "utf8", windowsHide: true }).trim();
    const put = (path: string, text: string, executable = false) => {
        writeFileSync(path, text);
        if (executable) chmodSync(path, 0o755);
    };
    mkdirSync(join(repo, "scripts"));
    copyFileSync(join(import.meta.dir, "release.sh"), join(repo, "scripts/release.sh"));
    put(join(repo, "README.md"), "release readme\n");
    put(join(repo, "CHANGELOG.md"), "# Changelog\n");
    put(join(repo, ".gitignore"), "dist/\n");
    mkdirSync(join(repo, ".cortexkit/release-notes"), { recursive: true });
    put(join(repo, ".cortexkit/release-notes/v9.8.7.md"), "Fixture release notes\n");
    for (const pkg of packages) {
        const directory = join(repo, "packages", pkg);
        mkdirSync(directory, { recursive: true });
        put(join(directory, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
        if (existingDists) {
            mkdirSync(join(directory, "dist"));
            put(join(directory, "dist/index.js"), `live ${pkg}\n`);
            put(join(directory, "dist/live-chunk.js"), "live chunk\n");
        }
    }
    const consumerShim = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "{\\"name\\":\\"$1\\",\\"args\\":[],\\"cwd\\":\\"$PWD\\"}" >> "$COMMAND_LOG"
test "$(cat packages/plugin/dist/index.js)" = 'release build'
test "$(cat packages/pi-plugin/dist/index.js)" = 'release build'
`;
    for (const [file, name] of [
        ["release-e2e-docker.sh", "docker-consumer"],
        ["run-rust-hermetic-e2e.sh", "rust-consumer"],
    ]) {
        put(join(repo, "scripts", file), consumerShim.replaceAll("$1", name), true);
    }
    put(join(bin, "bun"), bunShim, true);
    put(
        join(bin, "python3"),
        '#!/usr/bin/env bash\n[[ "$1" == */ci-gate.py ]] || exit 90\n',
        true,
    );
    put(join(bin, "docker"), '#!/usr/bin/env bash\n[[ "$1" == info ]] || exit 90\n', true);
    for (const name of ["gh", "npm", "curl", "opencode"]) {
        put(join(bin, name), "#!/usr/bin/env bash\necho 'Network/host command refused' >&2\nexit 90\n", true);
    }
    put(
        join(bin, "git"),
        `#!/usr/bin/env bash
if [[ "\${FAIL_STAGE:-}" == worktree && "$*" == *'worktree add'* ]]; then exit 7; fi
for arg in "$@"; do
    case "$arg" in push|fetch|pull|clone|commit|tag) echo 'Release mutation refused' >&2; exit 90;; esac
done
exec "$REAL_GIT" "$@"
`,
        true,
    );
    git("init", "-b", "master");
    git("config", "user.name", "Release Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", ".");
    git("commit", "-m", "Fixture base");
    const head = git("rev-parse", "HEAD");
    return {
        repo,
        head,
        git,
        run(ci = true, failStage = "") {
            const result = spawnSync(
                "bash",
                ["scripts/release.sh", "9.8.7", ...(ci ? [`--ci-gate=${head}`] : [])],
                {
                    cwd: repo,
                    env: { ...env, FAIL_STAGE: failStage },
                    encoding: "utf8",
                    timeout: 15_000,
                    windowsHide: true,
                },
            );
            if (result.error) throw result.error;
            return { status: result.status, output: result.stdout + result.stderr };
        },
        commands(): Command[] {
            return existsSync(log)
                ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
                : [];
        },
        assertCleaned() {
            expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
            expect(readdirSync(buildTemp)).toEqual([]);
            expect(git("status", "--porcelain")).toBe("");
            expect(git("rev-parse", "HEAD")).toBe(head);
        },
    };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function expectLiveDists(repo: string) {
    for (const pkg of packages) {
        const dist = join(repo, "packages", pkg, "dist");
        expect(readdirSync(dist).sort()).toEqual(["index.js", "live-chunk.js"]);
        expect(readFileSync(join(dist, "index.js"), "utf8")).toBe(`live ${pkg}\n`);
        expect(readFileSync(join(dist, "live-chunk.js"), "utf8")).toBe("live chunk\n");
    }
}

function expectDetachedBuilds(test: ReturnType<typeof fixture>) {
    const commands = test.commands();
    const install = commands.find((command) => command.args[0] === "install");
    expect(install).toBeDefined();
    if (!install) throw new Error("No frozen install ran");
    expect(install.args).toEqual(["install", "--frozen-lockfile"]);
    expect(install.cwd).not.toBe(test.repo);
    expect(install.head).toBe(test.head);
    expect(install.branch).toBe("");
    expect(commands.filter((command) => command.args.at(-1) === "build").map((command) => command.args)).toEqual(
        ["plugin", "pi-plugin", "cli"].map((pkg) => [
            "run", "--cwd", join(install.cwd, "packages", pkg), "build",
        ]),
    );
    const audit = commands.find((command) => command.args.at(-1) === "audit:packed-packages");
    expect(audit?.args).toEqual(["run", "--cwd", install.cwd, "audit:packed-packages"]);
    const generation = commands.find((command) => command.args[0] === "packages/plugin/scripts/build-schema.ts");
    expect(generation?.cwd).toBe(test.repo);
    for (const command of commands.filter((command) => command !== generation)) {
        expect(command.cwd).toBe(install.cwd);
    }
}

describe("release build worktree", () => {
    it("keeps live checkout dists unchanged while checking release builds", () => {
        const test = fixture();
        const result = test.run();
        expect(result.status).toBe(1);
        expect(result.output).toContain("Fixture stopped before release edits");
        expectLiveDists(test.repo);
        expectDetachedBuilds(test);
        test.assertCleaned();
    });

    it("does not create dists in a checkout without build output", () => {
        const test = fixture(false);
        const result = test.run();
        expect(result.status).toBe(1);
        expect(result.output).toContain("Fixture stopped before release edits");
        for (const pkg of packages) expect(existsSync(join(test.repo, "packages", pkg, "dist"))).toBe(false);
        expectDetachedBuilds(test);
        test.assertCleaned();
    });

    it("runs local gates and downstream host consumers in the detached checkout", () => {
        const test = fixture();
        const result = test.run(false);
        expect(result.status).toBe(1);
        expect(result.output).toContain("Fixture stopped before release edits");
        expectLiveDists(test.repo);
        expectDetachedBuilds(test);
        for (const name of ["docker-consumer", "rust-consumer"]) {
            expect(test.commands().filter((command) => command.name === name)).toHaveLength(1);
        }
        for (const action of ["lint", "typecheck", "test"]) {
            expect(test.commands().filter((command) => command.args.at(-1) === action)).toHaveLength(3);
        }
        test.assertCleaned();
    });

    it("cleans up when a later release step is terminated", () => {
        const test = fixture();
        const result = test.run(true, "signal");
        expect(result.status).toBe(143);
        expect(result.output).toContain("Fixture stopped before release edits");
        expectLiveDists(test.repo);
        test.assertCleaned();
    });

    it("removes the temporary directory if worktree creation fails", () => {
        const test = fixture();
        const result = test.run(true, "worktree");
        expect(result.status).toBe(7);
        expect(test.commands()).toEqual([]);
        expectLiveDists(test.repo);
        test.assertCleaned();
    });

    it.each([
        ["install", ""],
        ["plugin", "Error: Plugin build failed"],
        ["pi-plugin", "Error: Pi-plugin build failed"],
        ["cli", "Error: CLI build failed"],
        ["audit", "Error: Packed-package audit failed"],
    ])("removes the worktree after a %s failure", (stage, message) => {
        const test = fixture();
        const result = test.run(true, stage);
        expect(result.status).not.toBe(0);
        if (message) expect(result.output).toContain(message);
        expect(result.output).not.toContain("Fixture stopped before release edits");
        expectLiveDists(test.repo);
        test.assertCleaned();
    });
});

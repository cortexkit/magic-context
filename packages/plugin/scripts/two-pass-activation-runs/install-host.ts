import { cpSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const hostPackages = {
    "opencode-1": "opencode-ai@1.18.31",
    "opencode-2": "@opencode/cli@2.0.22",
    pi: "@earendil-works/pi-coding-agent@1.4.0",
    omp: "@oh-my-pi/pi-coding-agent@18.12.3",
} as const;

if (import.meta.main) {
    const [operation, source, root, lane] = process.argv.slice(2);
    if (!Object.hasOwn(hostPackages, lane)) throw new Error("host_lane");
    if (operation === "stage") {
        if (resolve(source) === resolve(root)) throw new Error("stage_source_is_destination");
        cpSync(source, root, { recursive: true, dereference: false, filter: (path) =>
            ![".git", ".cortexkit", "node_modules", "target", "dist", ".venv", ".npmrc", ".yarnrc"].includes(basename(path)) &&
            !basename(path).startsWith(".env") && !/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(path) && !lstatSync(path).isSymbolicLink(),
        });
    } else if (operation === "build") {
        if (process.platform !== "linux") throw new Error("host_build_requires_linux");
        const run = (argv: string[], cwd: string) => {
            const result = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
            if (result.status !== 0) throw new Error("isolated_host_build_failed");
        };
        run([process.execPath, "install", "--frozen-lockfile"], root);
        run([process.execPath, "run", "--cwd", "packages/plugin", "build"], root);
        if (lane === "omp" || lane === "pi") run([process.execPath, "run", "--cwd", "packages/pi-plugin", "build"], root);
        const host = join(root, "host-dist");
        mkdirSync(host, { recursive: true });
        const pinned = hostPackages[lane as keyof typeof hostPackages];
        writeFileSync(join(host, "package.json"), JSON.stringify({ private: true, trustedDependencies: [pinned.slice(0, pinned.lastIndexOf("@"))] }));
        run([process.execPath, "add", "--exact", hostPackages[lane as keyof typeof hostPackages]], host);
        if (lane === "opencode-2") run([process.execPath, join(host, "node_modules/@opencode/cli/postinstall.mjs")], host);
        if (lane !== "omp" && lane !== "pi") {
            // OpenCode otherwise installs its plugin SDK on first directory initialization,
            // which cannot finish when the proof container has external networking disabled.
            const config = process.env.XDG_CONFIG_HOME;
            if (!config) throw new Error("isolated_config_root_required");
            mkdirSync(config, { recursive: true });
            if (!existsSync(join(config, "package.json"))) writeFileSync(join(config, "package.json"), '{"private":true}');
            run([process.execPath, "add", "--exact", lane === "opencode-1" ? "@opencode-ai/plugin@1.18.31" : "@opencode/plugin@2.0.22"], config);
        }
    } else throw new Error("install_operation");
}

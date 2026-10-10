/**
 * @cortexkit/magic-context — unified CLI for Magic Context.
 *
 * Subcommands:
 *   setup           Interactive setup wizard for OpenCode, Pi, or OMP.
 *   doctor          Health-check + auto-fix for installed harnesses.
 *     --force         Force-clear plugin cache.
 *     --fix           Repair safe, Magic Context-owned store rows.
 *     --issue         Bundle a sanitized issue report and submit/open.
 *     --clear         Interactive picker to clear plugin caches.
 *     --verbose       Print long listings in full instead of a capped summary.
 *   doctor migrate  Migrate OpenCode session content to Pi/OMP JSONL.
 *   doctor migrate-session  Re-home an OpenCode session to another directory/project.
 *   doctor merge-identity   Merge all project-scoped rows between identities.
 *   doctor repair-db        Back up and salvage a corrupted shared database.
 *   doctor list-hidden-sessions  List reusable OpenCode 2 historian/Dreamer roots.
 *
 * Common flags:
 *   --harness opencode|pi|omp   Target one harness (default: auto-detect / prompt)
 *   --version, -v           Print CLI version and exit
 *   --help, -h              Print help and exit
 */
import { createRequire } from "node:module";
import { loadPluginConfig } from "@magic-context/core/config";
import { setStoragePrivatePermissionEnforcement } from "@magic-context/core/shared/storage-permissions";
import { subcommandHelp } from "./lib/cli-help";
import { isPromptCancelledError } from "./lib/prompts";
import { runSqlitePreflight } from "./lib/sqlite-preflight";

function getVersion(): string {
    const req = createRequire(import.meta.url);
    // In source layout (src/index.ts) package.json is two levels up.
    // In published layout (dist/index.js) it's one level up. Try both so
    // `--version` works regardless of how the binary was launched.
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
                return pkg.version;
            }
        } catch {
            // try next layout
        }
    }
    return "0.0.0";
}

function valueAfter(args: string[], flag: string): string | null {
    const index = args.indexOf(flag);
    if (index === -1) return null;
    // Reject a flag-shaped value so `--rekey-v22-dir-identity --force` doesn't
    // consume `--force` as the project path (see doctor-pi.ts valueAfter).
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) return null;
    return next;
}

function printUsage(): void {
    console.log("");
    console.log("  Magic Context CLI");
    console.log("  ─────────────────");
    console.log("");
    console.log("  Commands:");
    console.log("    setup            Interactive setup wizard");
    console.log("    doctor           Check and fix configuration issues");
    console.log("    doctor --force   Force-clear plugin cache");
    console.log("    doctor --fix     Repair safe, Magic Context-owned store rows");
    console.log("    doctor --issue   Collect diagnostics and open a GitHub issue");
    console.log("    doctor --issue --report <path>  Write diagnostics without prompting");
    console.log("    doctor --clear   Interactive cache cleanup picker");
    console.log("    doctor store init   Provision context.db without a host");
    console.log("    doctor --check-v22-backfill       Show v22 memory backfill status");
    console.log("    doctor --retry-v22-backfill       Retry failed v22 memory backfill rows");
    console.log("    doctor --rekey-v22-dir-identity <path>  Re-key legacy dir identity rows");
    console.log(
        "    doctor single-store migrate      Move Rust domain rows into context.db offline",
    );
    console.log("    doctor migrate   Migrate OpenCode session to Pi or OMP JSONL");
    console.log("    doctor migrate-session   Re-home an OpenCode session to another directory");
    console.log(
        "    doctor merge-identity   Merge project rows (--from ID --to ID [--dry-run] [--yes])",
    );
    console.log("    doctor repair-db   Back up and salvage a corrupted shared database");
    console.log("    doctor list-hidden-sessions   List Magic Context OpenCode 2 roots");
    console.log("");
    console.log("  Harness selection:");
    console.log("    --harness opencode    Target OpenCode only");
    console.log("    --harness pi          Target Pi only");
    console.log("    --harness omp         Target Oh My Pi (OMP) only");
    console.log("    (default: auto-detect, prompt if multiple installed)");
    console.log("");
    console.log("  Usage:");
    console.log(
        "    npx @cortexkit/magic-context@latest <command> --help   # help for one command",
    );
    console.log("    npx @cortexkit/magic-context@latest setup");
    console.log("        # add --dry-run to preview the wizard without writing any files");
    console.log("    npx @cortexkit/magic-context@latest doctor");
    console.log("    npx @cortexkit/magic-context@latest doctor --issue");
    console.log("    npx @cortexkit/magic-context@latest doctor migrate \\");
    console.log("        --from opencode --to <pi|omp> --session ses_xxx --dry-run");
    console.log("");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
        printUsage();
        return 0;
    }

    if (argv[0] === "--version" || argv[0] === "-v") {
        console.log(getVersion());
        return 0;
    }

    const command = argv[0];
    const rest = argv.slice(1);

    // Answer `<command> --help` before any command runs: without this, a help
    // flag was ignored and `doctor --help` ran the whole doctor.
    const help = subcommandHelp(argv);
    if (help !== null) {
        console.log(help);
        return 0;
    }

    try {
        setStoragePrivatePermissionEnforcement(
            loadPluginConfig(process.cwd()).storage.enforce_private_permissions,
        );
        // Await here, inside the try: returning the command's promise directly
        // would let a cancelled prompt reject past this handler, so the
        // process-level handler printed "Cancelled." again and exited 1.
        const code = await runCommand(command, rest);
        if (code !== null) return code;
    } catch (error) {
        if (isPromptCancelledError(error)) return 0;
        throw error;
    }

    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
}

/** Run one command; null means the command name is unknown. */
async function runCommand(command: string | undefined, rest: string[]): Promise<number | null> {
    if (command === "setup") {
        const { runSetup } = await import("./commands/setup");
        return runSetup(rest);
    }

    if (command === "doctor") {
        if (!(await runSqlitePreflight())) return 1;

        if (rest[0] === "store") {
            const { runDoctorStoreCli } = await import("./commands/doctor-store");
            return runDoctorStoreCli(rest.slice(1));
        }
        if (rest[0] === "single-store") {
            const { runDoctorSingleStoreCli } = await import("./commands/doctor-single-store");
            return runDoctorSingleStoreCli(rest.slice(1));
        }
        if (rest[0] === "merge-identities" || rest[0] === "merge-identity") {
            const { runMergeIdentityCli } = await import("./commands/doctor-merge-identity");
            return runMergeIdentityCli(rest.slice(1));
        }
        if (rest[0] === "repair-db") {
            const { runRepairDbCli } = await import("./commands/doctor-repair-db");
            return runRepairDbCli(rest.slice(1));
        }
        if (rest[0] === "git-fts-map") {
            const { runDoctorGitFtsMapCli } = await import("./commands/doctor-git-fts-map");
            return runDoctorGitFtsMapCli(rest.slice(1));
        }
        if (rest[0] === "list-hidden-sessions") {
            const { runListHiddenSessions } = await import("./commands/doctor-hidden-sessions");
            return runListHiddenSessions();
        }
        if (rest[0] === "migrate") {
            const { runMigrateCli } = await import("./commands/migrate");
            return runMigrateCli(rest.slice(1));
        }
        if (rest[0] === "migrate-session") {
            const { runMigrateSessionCli } = await import("./commands/migrate-session");
            return runMigrateSessionCli(rest.slice(1));
        }
        if (rest.includes("--prune-discovery")) {
            const { runPruneDiscoveryCli } = await import("./commands/doctor-prune-discovery");
            return runPruneDiscoveryCli(rest);
        }
        const { runDoctor } = await import("./commands/doctor");
        const rekeyV22DirIdentity = valueAfter(rest, "--rekey-v22-dir-identity");
        const report = valueAfter(rest, "--report");
        return runDoctor({
            force: rest.includes("--force"),
            fix: rest.includes("--fix"),
            issue: rest.includes("--issue") || report !== null,
            ...(report !== null ? { report } : {}),
            clear: rest.includes("--clear"),
            verbose: rest.includes("--verbose"),
            checkV22Backfill: rest.includes("--check-v22-backfill"),
            retryV22Backfill: rest.includes("--retry-v22-backfill"),
            ...(rekeyV22DirIdentity !== null ? { rekeyV22DirIdentity } : {}),
            argv: rest,
        });
    }
    return null;
}

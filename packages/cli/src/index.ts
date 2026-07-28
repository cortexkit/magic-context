#!/usr/bin/env node
/**
 * @cortexkit/magic-context — unified CLI for Magic Context.
 *
 * Subcommands:
 *   setup           Interactive setup wizard for OpenCode, Pi, or OMP.
 *   doctor          Health-check + auto-fix for installed harnesses.
 *     --force         Force-clear plugin cache.
 *     --issue         Bundle a sanitized issue report and submit/open.
 *     --clear         Interactive picker to clear plugin caches.
 *   doctor migrate  Migrate OpenCode session content to Pi/OMP JSONL.
 *   doctor migrate-session  Re-home an OpenCode session to another directory/project.
 *   doctor merge-identity   Merge all project-scoped rows between identities.
 *
 * Common flags:
 *   --harness opencode|pi|omp   Target one harness (default: auto-detect / prompt)
 *   --version, -v           Print CLI version and exit
 *   --help, -h              Print help and exit
 */
import { createRequire } from "node:module";
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
    console.log("    doctor --issue   Collect diagnostics and open a GitHub issue");
    console.log("    doctor --clear   Interactive cache cleanup picker");
    console.log("    doctor --check-v22-backfill       Show v22 memory backfill status");
    console.log("    doctor --retry-v22-backfill       Retry failed v22 memory backfill rows");
    console.log("    doctor --rekey-v22-dir-identity <path>  Re-key legacy dir identity rows");
    console.log(
        "    doctor drain-authority <project>  Drain module memory/note authority back to TypeScript",
    );
    console.log("    doctor migrate   Migrate OpenCode session to Pi or OMP JSONL");
    console.log("    doctor migrate-session   Re-home an OpenCode session to another directory");
    console.log(
        "    doctor merge-identity   Merge project rows (--from ID --to ID [--dry-run] [--yes])",
    );
    console.log("");
    console.log("  Harness selection:");
    console.log("    --harness opencode    Target OpenCode only");
    console.log("    --harness pi          Target Pi only");
    console.log("    --harness omp         Target Oh My Pi (OMP) only");
    console.log("    (default: auto-detect, prompt if multiple installed)");
    console.log("");
    console.log("  Usage:");
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

    try {
        if (command === "setup") {
            const { runSetup } = await import("./commands/setup");
            return runSetup(rest);
        }

        if (command === "doctor") {
            if (!(await runSqlitePreflight())) return 1;

            if (rest[0] === "drain-authority") {
                const projectRoot = rest[1];
                if (!projectRoot || projectRoot.startsWith("-")) {
                    console.error("Usage: magic-context doctor drain-authority <project>");
                    return 1;
                }
                const [{ runDoctorDrainAuthority }, { getMagicContextStorageDir }, { join }] =
                    await Promise.all([
                        import("./commands/doctor-authority"),
                        import("@magic-context/core/shared/data-path"),
                        import("node:path"),
                    ]);
                return runDoctorDrainAuthority(
                    projectRoot,
                    join(getMagicContextStorageDir(), "context.db"),
                );
            }
            if (rest[0] === "merge-identity") {
                const { runMergeIdentityCli } = await import("./commands/doctor-merge-identity");
                return runMergeIdentityCli(rest.slice(1));
            }
            if (rest[0] === "migrate") {
                const { runMigrateCli } = await import("./commands/migrate");
                return runMigrateCli(rest.slice(1));
            }
            if (rest[0] === "migrate-session") {
                const { runMigrateSessionCli } = await import("./commands/migrate-session");
                return runMigrateSessionCli(rest.slice(1));
            }
            const { runDoctor } = await import("./commands/doctor");
            const rekeyV22DirIdentity = valueAfter(rest, "--rekey-v22-dir-identity");
            return runDoctor({
                force: rest.includes("--force"),
                issue: rest.includes("--issue"),
                clear: rest.includes("--clear"),
                checkV22Backfill: rest.includes("--check-v22-backfill"),
                retryV22Backfill: rest.includes("--retry-v22-backfill"),
                ...(rekeyV22DirIdentity !== null ? { rekeyV22DirIdentity } : {}),
                argv: rest,
            });
        }
    } catch (error) {
        if (isPromptCancelledError(error)) return 0;
        throw error;
    }

    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });

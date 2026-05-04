#!/usr/bin/env node
/**
 * @cortexkit/magic-context — unified CLI for Magic Context.
 *
 * Subcommands:
 *   setup           Interactive setup wizard for OpenCode and/or Pi.
 *   doctor          Health-check + auto-fix for installed harnesses.
 *     --force         Force-clear plugin cache.
 *     --issue         Bundle a sanitized issue report and submit/open.
 *     --clear         Interactive picker to clear plugin caches.
 *   doctor migrate  Migrate OpenCode session content to Pi JSONL.
 *
 * Common flags:
 *   --harness opencode|pi   Target one harness (default: auto-detect / prompt)
 *   --version, -v           Print CLI version and exit
 *   --help, -h              Print help and exit
 */
import { createRequire } from "node:module";

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
    console.log("    doctor migrate   Migrate OpenCode session to Pi JSONL");
    console.log("");
    console.log("  Harness selection:");
    console.log("    --harness opencode    Target OpenCode only");
    console.log("    --harness pi          Target Pi only");
    console.log("    (default: auto-detect, prompt if multiple installed)");
    console.log("");
    console.log("  Usage:");
    console.log("    bunx --bun @cortexkit/magic-context@latest setup");
    console.log("    bunx --bun @cortexkit/magic-context@latest doctor");
    console.log("    bunx --bun @cortexkit/magic-context@latest doctor --issue");
    console.log("    bunx --bun @cortexkit/magic-context@latest doctor migrate \\");
    console.log("        --from opencode --to pi --session ses_xxx --dry-run");
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

    if (command === "setup") {
        const { runSetup } = await import("./commands/setup");
        return runSetup(rest);
    }

    if (command === "doctor") {
        if (rest[0] === "migrate") {
            const { runMigrateCli } = await import("./commands/migrate");
            return runMigrateCli(rest.slice(1));
        }
        const { runDoctor } = await import("./commands/doctor");
        return runDoctor({
            force: rest.includes("--force"),
            issue: rest.includes("--issue"),
            clear: rest.includes("--clear"),
            argv: rest,
        });
    }

    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
}

main().then((code) => process.exit(code));

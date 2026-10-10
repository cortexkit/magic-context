/**
 * Per-subcommand `--help` / `-h` text for the CLI.
 *
 * `main()` checks for a help flag before it runs a command, so asking for help
 * never starts the doctor, the setup wizard, or a database operation. The
 * doctor subcommands whose runners already print their own help (`migrate`,
 * `migrate-session`, `repair-db`) are left to those runners.
 */

const HELP_FLAGS = new Set(["--help", "-h"]);

export function hasHelpFlag(args: readonly string[]): boolean {
    return args.some((arg) => HELP_FLAGS.has(arg));
}

/** Doctor subcommands whose own runner handles `--help`. */
export const DOCTOR_SUBCOMMANDS_WITH_OWN_HELP: ReadonlySet<string> = new Set([
    "migrate",
    "migrate-session",
    "repair-db",
    "git-fts-map",
]);

const HARNESS_LINES = [
    "  Harness selection:",
    "    --harness opencode    Target OpenCode only",
    "    --harness pi          Target Pi only",
    "    --harness omp         Target Oh My Pi (OMP) only",
    "    (default: auto-detect, prompt if multiple installed)",
];

export const SETUP_HELP = [
    "",
    "  Usage: magic-context setup [--harness opencode|pi|omp] [--dry-run]",
    "",
    "  Interactive setup wizard: registers the Magic Context plugin with the",
    "  selected harness and writes its Magic Context config.",
    "",
    "  Options:",
    "    --dry-run             Preview the wizard without writing any files",
    ...HARNESS_LINES,
    "",
].join("\n");

export const DOCTOR_HELP = [
    "",
    "  Usage: magic-context doctor [options]",
    "         magic-context doctor <subcommand> [options]",
    "",
    "  Check the installed harnesses and fix configuration issues.",
    "",
    "  Options:",
    "    --fix                               Repair safe, Magic Context-owned store rows and clear an outdated OpenCode 2 plugin cache",
    "    --force                             Force-clear the plugin cache",
    "    --clear                             Interactive cache cleanup picker",
    "    --verbose                           Print long listings in full instead of a capped summary",
    "    --prune-discovery [--yes]           List RPC discovery records that block offline maintenance, then remove them after confirmation",
    "    --issue                             Collect diagnostics and open a GitHub issue",
    "    --report <path>                     Write the issue diagnostics to <path> without prompting",
    "    --check-v22-backfill                Show v22 memory backfill status",
    "    --retry-v22-backfill                Retry failed v22 memory backfill rows",
    "    --rekey-v22-dir-identity <path>     Re-key legacy dir identity rows",
    ...HARNESS_LINES,
    "",
    "  Subcommands (each accepts --help):",
    "    store init                  Provision context.db without a host",
    "    single-store migrate        Move Rust domain rows into context.db offline",
    "    migrate                     Migrate an OpenCode session to Pi or OMP JSONL",
    "    migrate-session             Re-home an OpenCode session to another directory",
    "    merge-identities            Preview or explicitly merge split identities",
    "    repair-db                   Back up and salvage a corrupted shared database",
    "    git-fts-map                 Diagnose git FTS inventory; --repair backs up both stores offline",
    "    list-hidden-sessions        List Magic Context OpenCode 2 roots",
    "",
].join("\n");

export const SINGLE_STORE_HELP = [
    "",
    "  Usage: magic-context doctor single-store migrate [options]",
    "",
    "  Quit OpenCode, Pi and ck-mc (`ck stop magic-context`) before migrating every project.",
    "  --ck-mc <path>          Override the installed engine executable",
    "  --backup-root <dir>     Backup parent directory (default: <data>/backups)",
    "  --dry-run              Verify, then roll back the engine transaction",
    "  --skip-foreign         Leave foreign-context store rows only in the backup",
    "  --prefer <project>=store|context  Resolve an ambiguous project (repeatable)",
    "  --accept-id-change     Accept changed memory IDs in Claude Code sessions",
    "",
].join("\n");

export const MERGE_IDENTITY_HELP = [
    "",
    "  Usage: magic-context doctor merge-identities [--from <identity> --to <identity>] [--apply] [--force] [--db <path>]",
    "",
    "  Merge every project-scoped row from one project identity into another.",
    "",
    "  Options:",
    "    --from <identity>   Identity whose rows are moved",
    "    --to <identity>     Identity that receives them",
    "    (no flags)          List splits; --from/--to previews without writing",
    "    --apply             Confirm the reviewed preview; hosts must be closed",
    "    --force             Permit a target not resolving on this machine",
    "    --db <path>         Use this context.db instead of the shared one",
    "    --host-db <path>    Read session directories from this host database",
    "    Legacy alias: doctor merge-identity; --dry-run previews, --yes applies",
    "",
].join("\n");

export const LIST_HIDDEN_SESSIONS_HELP = [
    "",
    "  Usage: magic-context doctor list-hidden-sessions",
    "",
    "  List the hidden OpenCode 2 root sessions Magic Context reuses for its",
    "  historian and dreamer runs. Read-only.",
    "",
].join("\n");

/**
 * The help text for `argv` when it asks for help, or null when it does not or
 * when the named subcommand prints its own help.
 */
export function subcommandHelp(argv: readonly string[]): string | null {
    const [command, ...rest] = argv;
    if (!hasHelpFlag(rest)) return null;
    if (command === "setup") return SETUP_HELP;
    if (command !== "doctor") return null;
    const subcommand = rest[0];
    if (subcommand === "store")
        return "Usage: magic-context doctor store init\n\nCreate context.db at the current schema fence. Existing stores are reported without changes.\nHonours XDG_DATA_HOME and MAGIC_CONTEXT_STORAGE_DIR; no harness is required.";
    if (subcommand === "single-store") return SINGLE_STORE_HELP;
    if (subcommand === "merge-identity" || subcommand === "merge-identities")
        return MERGE_IDENTITY_HELP;
    if (subcommand === "list-hidden-sessions") return LIST_HIDDEN_SESSIONS_HELP;
    if (subcommand !== undefined && DOCTOR_SUBCOMMANDS_WITH_OWN_HELP.has(subcommand)) return null;
    return DOCTOR_HELP;
}

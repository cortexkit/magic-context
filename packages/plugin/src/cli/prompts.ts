import {
    confirm as clackConfirm,
    text as clackText,
    intro,
    isCancel,
    log,
    note,
    outro,
    select,
    spinner,
} from "@clack/prompts";

export { intro, log, note, outro, spinner };

/**
 * Runtime note on interactive prompts under `curl | bash`:
 *
 * `install.sh` does `bunx ... setup </dev/tty` to reconnect the setup
 * process's stdin to the terminal after the install script was piped through
 * bash. For that path to work with Clack's `select()` prompt (which relies on
 * raw-mode keypress events), the setup process needs to run under a Node
 * runtime — Bun's TTY stream handling does not currently deliver `data`/
 * `keypress` events through a fresh `/dev/tty` open and `select()` freezes.
 *
 * `install.sh` is structured to prefer `bunx` *without* `--bun`, so the CLI's
 * `#!/usr/bin/env node` shebang is honored and setup runs on Node, which
 * handles `</dev/tty` redirects correctly. When the user has no compatible
 * Node on PATH we fall back to `bunx --bun` with a warning pointing users to
 * the direct `bunx --bun ... setup` invocation (which inherits an interactive
 * TTY and works fine).
 *
 * If you're tempted to pass a custom `input: Readable` here, don't — we
 * verified that both `fs.createReadStream("/dev/tty")` and
 * `new tty.ReadStream(openSync("/dev/tty"))` fail under Bun 1.3.x: the latter
 * advertises `isTTY=true` but emits zero data events. The only reliable fix
 * is at the runtime boundary (install.sh).
 */

function handleCancel(value: unknown): void {
    if (isCancel(value)) {
        log.warn("Setup cancelled.");
        process.exit(0);
    }
}

export async function confirm(message: string, defaultYes = true): Promise<boolean> {
    const result = await clackConfirm({
        message,
        initialValue: defaultYes,
    });
    handleCancel(result);
    return result as boolean;
}

export async function text(
    message: string,
    options: {
        placeholder?: string;
        initialValue?: string;
        validate?: (value: string) => string | undefined;
    } = {},
): Promise<string> {
    const result = await clackText({
        message,
        placeholder: options.placeholder,
        initialValue: options.initialValue,
        validate: options.validate
            ? (value) => {
                  const str = typeof value === "string" ? value : "";
                  const error = options.validate?.(str);
                  return error ?? undefined;
              }
            : undefined,
    });
    handleCancel(result);
    return result as string;
}

export async function selectOne(
    message: string,
    options: { label: string; value: string; recommended?: boolean }[],
): Promise<string> {
    const result = await select({
        message,
        options: options.map((opt) => ({
            label: opt.recommended ? `${opt.label} (recommended)` : opt.label,
            value: opt.value,
            hint: opt.recommended ? "recommended" : undefined,
        })),
    });
    handleCancel(result);
    return result as string;
}

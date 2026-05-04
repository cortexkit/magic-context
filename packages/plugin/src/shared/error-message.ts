export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Produce a rich, safe-to-log description of any thrown value.
 *
 * Motivated by SDK errors whose `.message` is empty while `.name`/`toString()`
 * carry the actual signal (e.g. `NotFoundError` with no message on OpenCode
 * session-delete races). Using {@link getErrorMessage} alone erases that signal.
 *
 * Captures:
 * - `name` from the Error (defaults to `constructor.name`)
 * - `message` (may be empty)
 * - first few stack frames
 * - `String(error)` so objects and custom toString surfaces are visible
 * - Common HTTP-shape fields (`status`, `statusCode`, `code`)
 * - `cause` chain summary (first level only)
 *
 * Returns a compact, single-line-friendly string suitable for log lines,
 * plus a structured object for callers that want individual fields.
 */
export interface ErrorDescription {
    name: string;
    message: string;
    status?: string;
    code?: string;
    causeName?: string;
    stackHead?: string;
    stringForm: string;
    /** Best short summary for human-readable logs. Never empty. */
    brief: string;
}

function readString(value: unknown): string | undefined {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
    return undefined;
}

function clip(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}…`;
}

export function describeError(error: unknown): ErrorDescription {
    const stringForm = clip(safeString(error), 400);

    if (!(error instanceof Error) && !(error && typeof error === "object")) {
        return {
            name: typeof error,
            message: "",
            stringForm,
            brief: stringForm || "<empty>",
        };
    }

    const obj = error as Record<string, unknown>;
    const nameFromField = readString(obj.name);
    const nameFromCtor = error?.constructor?.name;
    const name = nameFromField ?? nameFromCtor ?? "Error";

    const message = readString(obj.message) ?? "";
    const status = readString(obj.status) ?? readString(obj.statusCode);
    const code = readString(obj.code);

    let causeName: string | undefined;
    const cause = obj.cause;
    if (cause && typeof cause === "object") {
        const causeRecord = cause as Record<string, unknown>;
        causeName =
            readString(causeRecord.name) ??
            (cause as { constructor?: { name?: string } }).constructor?.name;
    }

    const stack = readString(obj.stack);
    const stackHead = stack
        ? stack
              .split("\n")
              .slice(0, 4)
              .map((l) => l.trim())
              .filter((l) => l.length > 0)
              .join(" | ")
        : undefined;

    const briefParts: string[] = [];
    if (name) briefParts.push(name);
    if (message) briefParts.push(`message="${clip(message, 200)}"`);
    if (status) briefParts.push(`status=${status}`);
    if (code) briefParts.push(`code=${code}`);
    if (causeName) briefParts.push(`cause=${causeName}`);
    if (!message && stringForm && stringForm !== name) {
        briefParts.push(`str="${clip(stringForm, 200)}"`);
    }
    const brief = briefParts.join(" ") || stringForm || name;

    return {
        name,
        message,
        ...(status ? { status } : {}),
        ...(code ? { code } : {}),
        ...(causeName ? { causeName } : {}),
        ...(stackHead ? { stackHead } : {}),
        stringForm,
        brief,
    };
}

function safeString(value: unknown): string {
    try {
        return String(value);
    } catch {
        return "<unstringifiable>";
    }
}

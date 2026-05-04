import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export interface SubstituteInput {
    /** Raw config text before JSONC parsing. */
    text: string;
    /**
     * Path of the config file the text came from. Used to resolve relative
     * `{file:...}` references and to emit useful warnings. Pass undefined for
     * virtual/synthetic inputs (tests) — in that case `{file:}` tokens with
     * relative paths resolve against `cwd`, which is rarely what callers want,
     * so callers should prefer passing a real path when one exists.
     */
    configPath?: string;
}

export interface SubstituteResult {
    /** Config text with all `{env:X}` and `{file:path}` tokens replaced. */
    text: string;
    /**
     * Human-readable warnings for missing env vars, unreadable files, and
     * unresolved tokens that fell back to empty string. Safe to surface to the
     * user via logger/toast/startup notification.
     */
    warnings: string[];
}

const ENV_PATTERN = /\{env:([^}]+)\}/g;
const FILE_PATTERN = /\{file:([^}]+)\}/g;

/**
 * Expand `{env:VAR}` and `{file:path}` tokens in raw config text.
 *
 * Mirrors OpenCode's `ConfigVariable.substitute` semantics so users can share
 * the same patterns across `opencode.json(c)` and `magic-context.jsonc`:
 *   - `{env:VAR}` → `process.env.VAR` (trimmed key), empty string when missing
 *   - `{file:~/path}` → contents of `~/path`, JSON-escaped for safe inlining
 *   - `{file:./rel}` or `{file:rel}` → resolved against the config file's dir
 *   - `{file:/abs}` → resolved as absolute
 *
 * Unlike OpenCode we treat missing values as warnings rather than hard errors:
 * magic-context config is less critical than the main OpenCode config, and a
 * typo in an optional embedding key should not prevent the plugin from loading
 * with other (valid) settings.
 *
 * File content substitution is JSON-escaped (wrapped then unwrapped through
 * `JSON.stringify`) so line breaks, quotes, and backslashes in file contents
 * survive the subsequent JSONC parse. Env value substitution is NOT escaped,
 * matching OpenCode — env values are typically API keys without JSON-special
 * characters. Users who need to embed a value with quotes or newlines should
 * use `{file:...}`.
 */
export function substituteConfigVariables(input: SubstituteInput): SubstituteResult {
    const warnings: string[] = [];
    let text = input.text;

    text = text.replace(ENV_PATTERN, (_, rawName: string) => {
        const varName = rawName.trim();
        const value = varName ? process.env[varName] : undefined;
        if (value === undefined || value === "") {
            warnings.push(
                `Environment variable ${varName} is not set (referenced via {env:${varName}}); using empty string`,
            );
            return "";
        }

        return value;
    });

    const fileMatches = Array.from(text.matchAll(FILE_PATTERN));
    if (fileMatches.length === 0) {
        return { text, warnings };
    }

    const configDir = input.configPath ? dirname(input.configPath) : process.cwd();

    let output = "";
    let cursor = 0;

    for (const match of fileMatches) {
        const token = match[0];
        const rawPath = match[1] ?? "";
        const index = match.index ?? 0;

        output += text.slice(cursor, index);
        cursor = index + token.length;

        // Skip tokens inside line comments: agents-only feature, matches OpenCode.
        // We run before JSONC parsing so raw comments are still in the text.
        const lineStart = text.lastIndexOf("\n", index - 1) + 1;
        const prefix = text.slice(lineStart, index).trimStart();
        if (prefix.startsWith("//")) {
            output += token;
            continue;
        }

        let filePath = rawPath.trim();
        if (filePath.startsWith("~/")) {
            filePath = resolve(homedir(), filePath.slice(2));
        } else if (!isAbsolute(filePath)) {
            filePath = resolve(configDir, filePath);
        }

        if (!existsSync(filePath)) {
            warnings.push(
                `File not found for ${token} (resolved to ${filePath}); using empty string`,
            );
            continue;
        }

        let contents: string;
        try {
            contents = readFileSync(filePath, "utf-8").trim();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(
                `Failed to read file for ${token} (${filePath}): ${message}; using empty string`,
            );
            continue;
        }

        // JSON-escape so embedded quotes, newlines, and backslashes don't break
        // the surrounding JSONC. Slice(1, -1) strips the outer quotes that
        // JSON.stringify adds so the token stays inside the caller's own string.
        output += JSON.stringify(contents).slice(1, -1);
    }

    output += text.slice(cursor);
    return { text: output, warnings };
}

/**
 * Send one recorded dreamer request to a model, with read-only tools over
 * one checkout, and write the model's whole trajectory beside it.
 *
 * The request is a `verify.request.json` or `map.request.json` that one of
 * ck-mc's replay harnesses wrote (`verify_replay_tests.rs` and
 * `map_replay_tests.rs` in `crates/mc-module/src/dreamer/`): the system and
 * user text a `verify`, `verify-broad` or `map-memories` batch sends, the
 * model settings, and the step bound the module's plan gives the run. This
 * runner plays the runner's part: it offers `read` (with a line range),
 * `grep` and `glob`, confined to the checkout, and runs the tool loop until
 * the model answers without a tool call or the step bound is reached.
 *
 * Everything goes to the request kind's trajectory file in the request's
 * folder (`verify.trajectory.json` or `map.trajectory.json`): each request
 * body sent, each reply as the provider returned it (reasoning included),
 * and each tool call with its full input and output. Nothing is written
 * anywhere else, and an existing trajectory is never overwritten.
 *
 * The provider key is read from standard input, never from arguments, the
 * environment or a file, and is never written: any text that contains it is
 * redacted before it is saved. `with-deepseek-key.ts` fetches the key from
 * the vault and pipes it in.
 *
 *   bun packages/plugin/scripts/dreamer-replay/verify-run.ts \
 *     --request <out>/verify/batch-0/verify.request.json --checkout <path> < key
 *   bun packages/plugin/scripts/dreamer-replay/verify-run.ts \
 *     --request <out>/map-memories/batch-0/map.request.json --checkout <path> < key
 */
import {
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
export const DEFAULT_TEMPERATURE = 0.1;

/**
 * The task kinds this runner replays: the root element of the one manifest
 * the module requires the final message to hold, and the file the
 * trajectory is written to.
 */
export const KINDS: Readonly<Record<string, { manifest: string; trajectory: string }>> = {
    verify: { manifest: "verify", trajectory: "verify.trajectory.json" },
    "verify-broad": { manifest: "verify", trajectory: "verify.trajectory.json" },
    "map-memories": { manifest: "mappings", trajectory: "map.trajectory.json" },
};
export const TRAJECTORY = KINDS.verify.trajectory;
export const MAP_TRAJECTORY = KINDS["map-memories"].trajectory;

/** How a request of `kind` runs; an unknown kind is refused. */
export function kindOf(kind: string): { manifest: string; trajectory: string } {
    const known = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
    if (!known) throw new Error(`${kind} is not a task kind this runner replays (${Object.keys(KINDS).join(", ")})`);
    return known;
}

/**
 * Whether `text` holds a whole `<root>` manifest, opening and closing tag,
 * as the module reads one: case-insensitive, with any attributes.
 */
export function completeManifest(text: string, root: string): boolean {
    return new RegExp(`<${root}\\b[^>]*>[\\s\\S]*?</${root}>`, "i").test(text);
}

/** How much one tool call may return, so one call can't fill the window. */
const READ_MAX_LINES = 2000;
const OUTPUT_MAX_CHARS = 50_000;
const LINE_MAX_CHARS = 300;
const GREP_MAX_MATCHES = 200;
const GLOB_MAX_PATHS = 500;
/** Files larger than this are not searched by grep. */
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Retries for a provider answer that may succeed on a second try. */
const RETRIES = 2;

/** One recorded request, as a replay harness writes it. */
export interface ReplayRequest {
    task: string;
    kind: string;
    batch: number;
    model: string;
    settings: { maxOutputTokens: number; maxSteps: number };
    messages: { role: string; content: string }[];
}

/** One HTTP answer from the provider. */
export interface ProviderAnswer {
    status: number;
    text: string;
}

/** Posts one chat-completions body; the real one calls the provider. */
export type Send = (body: unknown) => Promise<ProviderAnswer>;

export interface RunOptions {
    requestPath: string;
    checkout: string;
    key: string;
    send?: Send;
    model?: string;
    endpoint?: string;
    temperature?: number;
    now?: () => number;
}

interface ToolCall {
    id: string;
    type?: string;
    function: { name: string; arguments: string };
}

interface ToolRecord {
    id: string;
    name: string;
    arguments: string;
    input: unknown;
    output: string;
    refused: boolean;
}

interface StepRecord {
    step: number;
    request: unknown;
    attempts: { status: number | null; elapsedMs: number; error?: string }[];
    reply: unknown;
    finishReason: string | null;
    toolCalls: ToolRecord[];
}

export interface Trajectory {
    request: string;
    task: string;
    kind: string;
    batch: number;
    model: string;
    endpoint: string;
    temperature: number;
    maxSteps: number;
    checkout: string;
    startedAt: string;
    endedAt: string | null;
    stopReason: "final" | "step_bound" | "provider_error" | "running";
    error: string | null;
    steps: StepRecord[];
    final: { text: string; completeManifest: boolean } | null;
    usage: { promptTokens: number; completionTokens: number; reasoningTokens: number };
}

/** A tool call the checkout's bounds refuse; its message goes to the model. */
class Refusal extends Error {}

/** The tools the model is offered, in the chat-completions shape. */
export const TOOLS = [
    {
        type: "function",
        function: {
            name: "read",
            description:
                "Read a file of the checkout with line numbers, or list a folder. Paths are relative to the checkout. Use startLine and endLine (1-based, inclusive) to read part of a file.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    startLine: { type: "integer", minimum: 1 },
                    endLine: { type: "integer", minimum: 1 },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "grep",
            description:
                "Search the checkout's files for a regular expression (JavaScript syntax). Returns path:line: text for each matching line. Optional path limits the search to a folder or file; optional include is a glob the file path must match.",
            parameters: {
                type: "object",
                properties: {
                    pattern: { type: "string" },
                    path: { type: "string" },
                    include: { type: "string" },
                },
                required: ["pattern"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "glob",
            description:
                "List the checkout's files whose path matches a glob such as src/**/*.rs. Optional path limits the listing to a folder.",
            parameters: {
                type: "object",
                properties: { pattern: { type: "string" }, path: { type: "string" } },
                required: ["pattern"],
            },
        },
    },
];

function within(root: string, path: string): boolean {
    return path === root || path.startsWith(root + sep);
}

/** One checkout, read through its bounds: no path outside it, and no symlink out of it. */
export class Checkout {
    readonly root: string;
    private listed: string[] | null = null;

    constructor(root: string) {
        this.root = realpathSync(root);
        if (!statSync(this.root).isDirectory()) throw new Error(`${root} is not a folder`);
    }

    /** The real path of `path` inside the checkout, or a refusal. */
    resolve(path: string): string {
        const wanted = resolve(isAbsolute(path) ? path : join(this.root, path));
        if (!within(this.root, wanted)) throw new Refusal(`${path} is outside the checkout`);
        if (!existsSync(wanted)) {
            // A dangling link: refuse it rather than reveal where it points.
            try {
                lstatSync(wanted);
            } catch {
                throw new Refusal(`${path} does not exist`);
            }
            throw new Refusal(`${path} is a link to nothing inside the checkout`);
        }
        const real = realpathSync(wanted);
        if (!within(this.root, real)) throw new Refusal(`${path} is a symlink out of the checkout`);
        return real;
    }

    /**
     * Every file a search covers, relative to the root: git's tracked and
     * unignored files when git can list them, otherwise a walk that skips
     * `.git`. Links out of the checkout are left out.
     */
    files(): string[] {
        if (this.listed) return this.listed;
        let names: string[] | null = null;
        try {
            const listed = Bun.spawnSync(
                ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                {
                    cwd: this.root,
                    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
                    stdout: "pipe",
                    stderr: "ignore",
                    windowsHide: true,
                },
            );
            if (listed.exitCode === 0)
                names = listed.stdout.toString().split("\0").filter(Boolean);
        } catch {
            names = null;
        }
        names ??= this.walk(this.root);
        this.listed = [...new Set(names)]
            .filter((name) => {
                try {
                    const real = realpathSync(join(this.root, name));
                    return within(this.root, real) && statSync(real).isFile();
                } catch {
                    return false;
                }
            })
            .sort();
        return this.listed;
    }

    private walk(folder: string): string[] {
        return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
            if (entry.name === ".git") return [];
            const path = join(folder, entry.name);
            if (entry.isDirectory()) return this.walk(path);
            return [relative(this.root, path).split(sep).join("/")];
        });
    }

    /** The relative path of a real path inside the checkout, with `/`. */
    relative(real: string): string {
        return relative(this.root, real).split(sep).join("/") || ".";
    }
}

function clip(text: string, limit = OUTPUT_MAX_CHARS): string {
    return text.length <= limit ? text : `${text.slice(0, limit)}\n[cut at ${limit} characters]`;
}

function isBinary(bytes: Uint8Array): boolean {
    return bytes.subarray(0, 8000).includes(0);
}

function stringArgument(input: Record<string, unknown>, name: string, required: boolean): string | undefined {
    const value = input[name];
    if (value === undefined || value === null || value === "") {
        if (required) throw new Refusal(`${name} is required`);
        return undefined;
    }
    if (typeof value !== "string") throw new Refusal(`${name} must be a string`);
    return value;
}

function lineArgument(input: Record<string, unknown>, name: string): number | undefined {
    const value = input[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
        throw new Refusal(`${name} must be a whole number from 1`);
    return value;
}

/** The files under `path` (a folder or one file), or every file. */
function scope(checkout: Checkout, path: string | undefined): string[] {
    const files = checkout.files();
    if (!path) return files;
    const real = checkout.resolve(path);
    const prefix = checkout.relative(real);
    if (prefix === ".") return files;
    return files.filter((file) => file === prefix || file.startsWith(`${prefix}/`));
}

export function runTool(checkout: Checkout, name: string, input: Record<string, unknown>): string {
    if (name === "read") {
        const path = stringArgument(input, "path", true) as string;
        const real = checkout.resolve(path);
        if (statSync(real).isDirectory()) {
            const entries = readdirSync(real, { withFileTypes: true })
                .filter((entry) => entry.name !== ".git")
                .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
                .sort();
            return clip(entries.join("\n"));
        }
        const bytes = readFileSync(real);
        if (isBinary(bytes)) return `${checkout.relative(real)} is a binary file of ${bytes.length} bytes`;
        const lines = bytes.toString("utf8").split("\n");
        const start = lineArgument(input, "startLine") ?? 1;
        const end = Math.min(
            lineArgument(input, "endLine") ?? start + READ_MAX_LINES - 1,
            start + READ_MAX_LINES - 1,
            lines.length,
        );
        if (start > lines.length) return `${checkout.relative(real)} has ${lines.length} lines`;
        const shown = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`);
        return clip(shown.join("\n"));
    }
    if (name === "grep") {
        const pattern = stringArgument(input, "pattern", true) as string;
        let expression: RegExp;
        try {
            expression = new RegExp(pattern);
        } catch (error) {
            throw new Refusal(`pattern is not a valid regular expression: ${(error as Error).message}`);
        }
        const include = stringArgument(input, "include", false);
        const glob = include ? new Bun.Glob(include) : null;
        const matches: string[] = [];
        for (const file of scope(checkout, stringArgument(input, "path", false))) {
            if (glob && !glob.match(file)) continue;
            const full = join(checkout.root, file);
            if (statSync(full).size > GREP_MAX_FILE_BYTES) continue;
            const bytes = readFileSync(full);
            if (isBinary(bytes)) continue;
            const lines = bytes.toString("utf8").split("\n");
            for (let index = 0; index < lines.length; index++) {
                if (!expression.test(lines[index])) continue;
                matches.push(`${file}:${index + 1}: ${lines[index].slice(0, LINE_MAX_CHARS)}`);
                if (matches.length >= GREP_MAX_MATCHES)
                    return clip(`${matches.join("\n")}\n[stopped at ${GREP_MAX_MATCHES} matches]`);
            }
        }
        return matches.length ? clip(matches.join("\n")) : "no matches";
    }
    if (name === "glob") {
        const glob = new Bun.Glob(stringArgument(input, "pattern", true) as string);
        const found = scope(checkout, stringArgument(input, "path", false)).filter((file) => glob.match(file));
        if (!found.length) return "no files";
        const shown = found.slice(0, GLOB_MAX_PATHS).join("\n");
        return clip(found.length > GLOB_MAX_PATHS ? `${shown}\n[${found.length - GLOB_MAX_PATHS} more]` : shown);
    }
    throw new Refusal(`there is no tool ${name}; the tools are read, grep and glob`);
}

/** Replace every copy of `key` in a saved value. */
function redact<T>(value: T, key: string): T {
    if (!key) return value;
    return JSON.parse(JSON.stringify(value).split(key).join("[redacted]")) as T;
}

function save(path: string, trajectory: Trajectory, key: string): void {
    const temporary = `${path}.partial`;
    writeFileSync(temporary, `${JSON.stringify(redact(trajectory, key), null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
}

function postTo(endpoint: string, key: string): Send {
    return async (body) => {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
        });
        return { status: response.status, text: await response.text() };
    };
}

/** Send `body`, retrying an answer a second try may fix. */
async function sendWithRetries(
    send: Send,
    body: unknown,
    now: () => number,
    attempts: StepRecord["attempts"],
): Promise<ProviderAnswer | null> {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
        const started = now();
        try {
            const answer = await send(body);
            attempts.push({ status: answer.status, elapsedMs: now() - started });
            if (answer.status === 429 || answer.status >= 500) {
                if (attempt < RETRIES) await Bun.sleep(2000 * (attempt + 1));
                continue;
            }
            return answer;
        } catch (error) {
            attempts.push({ status: null, elapsedMs: now() - started, error: (error as Error).message });
            if (attempt < RETRIES) await Bun.sleep(2000 * (attempt + 1));
        }
    }
    return null;
}

/** Run one request's tool loop and write its trajectory beside it. */
export async function runRequest(options: RunOptions): Promise<Trajectory> {
    const now = options.now ?? Date.now;
    const requestPath = resolve(options.requestPath);
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as ReplayRequest;
    const kind = kindOf(request.kind);
    const output = join(dirname(requestPath), kind.trajectory);
    if (existsSync(output)) throw new Error(`${output} already exists; a replay is never overwritten`);
    if (!options.key.trim()) throw new Error("no provider key on standard input");
    const checkout = new Checkout(options.checkout);
    const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    const send = options.send ?? postTo(endpoint, options.key);
    const model = options.model ?? request.model;
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    const maxSteps = request.settings.maxSteps;
    const trajectory: Trajectory = {
        request: requestPath,
        task: request.task,
        kind: request.kind,
        batch: request.batch,
        model,
        endpoint,
        temperature,
        maxSteps,
        checkout: checkout.root,
        startedAt: new Date(now()).toISOString(),
        endedAt: null,
        stopReason: "running",
        error: null,
        steps: [],
        final: null,
        usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    };
    const messages: unknown[] = request.messages.map((message) => ({ ...message }));
    save(output, trajectory, options.key);
    for (let step = 1; step <= maxSteps; step++) {
        const body = {
            model,
            messages,
            tools: TOOLS,
            temperature,
            max_tokens: request.settings.maxOutputTokens,
        };
        const record: StepRecord = {
            step,
            request: structuredClone(body),
            attempts: [],
            reply: null,
            finishReason: null,
            toolCalls: [],
        };
        trajectory.steps.push(record);
        const answer = await sendWithRetries(send, body, now, record.attempts);
        if (!answer || answer.status !== 200) {
            record.reply = answer?.text ?? null;
            trajectory.stopReason = "provider_error";
            trajectory.error = answer ? `HTTP ${answer.status}` : "no answer from the provider";
            break;
        }
        let reply: {
            choices?: { message?: Record<string, unknown> & { tool_calls?: ToolCall[]; content?: string | null }; finish_reason?: string }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
        };
        try {
            reply = JSON.parse(answer.text);
        } catch {
            record.reply = answer.text;
            trajectory.stopReason = "provider_error";
            trajectory.error = "the provider's answer is not JSON";
            break;
        }
        record.reply = reply;
        trajectory.usage.promptTokens += reply.usage?.prompt_tokens ?? 0;
        trajectory.usage.completionTokens += reply.usage?.completion_tokens ?? 0;
        trajectory.usage.reasoningTokens += reply.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        const choice = reply.choices?.[0];
        const message = choice?.message;
        record.finishReason = choice?.finish_reason ?? null;
        if (!message) {
            trajectory.stopReason = "provider_error";
            trajectory.error = "the provider's answer holds no message";
            break;
        }
        // The whole assistant message goes back, reasoning included: DeepSeek
        // refuses a tool loop that drops `reasoning_content`.
        messages.push(message);
        const calls = message.tool_calls ?? [];
        if (!calls.length) {
            const text = message.content ?? "";
            trajectory.final = { text, completeManifest: completeManifest(text, kind.manifest) };
            trajectory.stopReason = "final";
            break;
        }
        for (const call of calls) {
            const toolRecord: ToolRecord = {
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
                input: null,
                output: "",
                refused: false,
            };
            try {
                const input = JSON.parse(call.function.arguments || "{}") as unknown;
                toolRecord.input = input;
                if (typeof input !== "object" || input === null || Array.isArray(input))
                    throw new Refusal("the arguments must be a JSON object");
                toolRecord.output = runTool(checkout, call.function.name, input as Record<string, unknown>);
            } catch (error) {
                toolRecord.refused = true;
                toolRecord.output =
                    error instanceof Refusal
                        ? `refused: ${error.message}`
                        : `error: ${(error as Error).message ?? String(error)}`;
            }
            record.toolCalls.push(toolRecord);
            messages.push({ role: "tool", tool_call_id: call.id, content: toolRecord.output });
        }
        save(output, trajectory, options.key);
    }
    if (trajectory.stopReason === "running") trajectory.stopReason = "step_bound";
    trajectory.endedAt = new Date(now()).toISOString();
    save(output, trajectory, options.key);
    return redact(trajectory, options.key);
}

function option(args: string[], name: string): string | undefined {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const requestPath = option(args, "--request");
    const checkout = option(args, "--checkout");
    if (!requestPath || !checkout) {
        console.error(
            "usage: bun verify-run.ts --request <verify.request.json|map.request.json> --checkout <path> [--model m] [--endpoint url] [--temperature t] < key",
        );
        process.exit(2);
    }
    const temperature = option(args, "--temperature");
    const key = (await Bun.stdin.text()).trim();
    try {
        const trajectory = await runRequest({
            requestPath,
            checkout,
            key,
            model: option(args, "--model"),
            endpoint: option(args, "--endpoint"),
            temperature: temperature === undefined ? undefined : Number(temperature),
        });
        console.log(
            JSON.stringify({
                trajectory: join(dirname(resolve(requestPath)), kindOf(trajectory.kind).trajectory),
                stopReason: trajectory.stopReason,
                steps: trajectory.steps.length,
                toolCalls: trajectory.steps.reduce((sum, step) => sum + step.toolCalls.length, 0),
                completeManifest: trajectory.final?.completeManifest ?? false,
                usage: trajectory.usage,
            }),
        );
    } catch (error) {
        console.error(redact((error as Error).message, key));
        process.exit(1);
    }
}

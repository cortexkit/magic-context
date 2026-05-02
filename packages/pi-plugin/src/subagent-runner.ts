import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";

/**
 * Resolve the path to the lean subagent extension entry that gets loaded
 * inside spawned Pi child processes. The bundle ships at
 * `dist/subagent-entry.js` next to `dist/index.js` (this module). We use
 * `import.meta.url` so the path resolves correctly regardless of where
 * the npm package is installed (or where it's symlinked from in dev).
 *
 * Falls back to undefined if the file isn't found at the expected
 * location — caller should treat that as a soft signal to skip the
 * `-x` flag (subagent will run without Magic Context tools, which is
 * what the original `--no-extensions` behavior gave us).
 */
function resolveSubagentEntryPath(): string | undefined {
	try {
		// Resolve from the current module's directory. In dev (running
		// .ts via Bun) and in prod (running .js from dist/), this lands
		// in the same directory as the runner itself.
		const here = dirname(fileURLToPath(import.meta.url));
		const candidate = resolvePath(here, "subagent-entry.js");
		if (existsSync(candidate)) return candidate;

		// Dev fallback: when running source from packages/pi-plugin/src/
		// the .js bundle doesn't exist yet; skip the -x flag so tests
		// running pre-build don't fail. Production builds always have
		// the bundle.
		return undefined;
	} catch {
		return undefined;
	}
}

const SUBAGENT_ENTRY_PATH = resolveSubagentEntryPath();

/**
 * Set of subagent agent ids that get the dreamer-only ctx_memory
 * action surface (update/merge/archive). Mirrors OpenCode's
 * `tool-registry.ts:114` allowedActions split: only the dreamer agent
 * gets the elevated surface; everyone else (historian, sidekick,
 * compressor, ad-hoc commands) gets write/delete/list only.
 *
 * Membership uses the SAME agent strings the Pi callers actually pass
 * (see e.g. `dreamer/index.ts` passing `"magic-context-dreamer"`). If
 * a new dreamer-equivalent caller is added, register its agent id
 * here too. Mismatched agent strings silently disable the elevated
 * action surface.
 */
const DREAMER_ACTION_AGENTS: ReadonlySet<string> = new Set([
	"dreamer",
	"magic-context-dreamer",
]);

/**
 * Pi-side implementation of `SubagentRunner`.
 *
 * Spawns `pi --print --mode json` as a child process and consumes its
 * NDJSON event stream over stdout until the `agent_end` event delivers
 * the full final message array. We extract the last assistant message's
 * concatenated text content and return it as the run result.
 *
 * Why subprocess instead of in-process?
 * - Pi's @mariozechner/pi-coding-agent has no in-process child-session
 *   API equivalent to OpenCode's `client.session.create() / .prompt()`.
 *   Sessions are tied to a SessionManager that runs the interactive UI
 *   loop, and the agent loop expects to own stdout/stderr.
 * - The print-mode subprocess path is the *only* officially supported
 *   single-shot invocation in Pi today, and it's stable: it emits a
 *   well-typed NDJSON event stream regardless of which provider/model
 *   is targeted. Spawning is more expensive (cold-start ~500ms) but
 *   subagent invocations already amortize that against many seconds of
 *   model latency, so the overhead is in the noise.
 *
 * Output protocol (each stdout line is one JSON object):
 *
 *   { type: "session", id, version, timestamp, cwd }
 *   { type: "agent_start" }
 *   { type: "turn_start" }
 *   { type: "message_start", message: { role, content, ... } }
 *   { type: "message_end",   message: { role, content, ... } }
 *   ... possibly more turn_start / message_start / message_end / turn_end on tool calls ...
 *   { type: "agent_end", messages: [ ... full final message array ... ] }
 *
 * The `agent_end` event is the authoritative final state. We ignore
 * intermediate `message_*` events for result extraction (we only need
 * the last assistant message's text).
 *
 * Failure modes we handle explicitly:
 * - `agent_end` arrives but the last assistant message has stopReason
 *   "error" or "aborted" → `model_failed` with the embedded errorMessage.
 * - Process exits non-zero before `agent_end` is observed → `non_zero_exit`.
 * - Process exits zero with no assistant result → `no_assistant`.
 * - Malformed JSON output before completion → `parse_failed`.
 * - Spawn itself fails (binary missing, permission denied) → `spawn_failed`.
 * - Caller's AbortSignal fires → kill the child + return `abort`.
 * - `timeoutMs` elapses before `agent_end` → kill + return `timeout`.
 *
 * What we deliberately don't expose:
 * - Tool call streaming. Subagents in Magic Context are configured with
 *   their own narrowed tool sets; if a model emits tool calls during a
 *   subagent run, those tools execute inside Pi's child process just
 *   fine — we just don't surface intermediate state to the caller.
 * - Per-turn token usage. Pi reports usage in each `message_end`, but
 *   the runner contract only returns the final assistant text. If the
 *   sidekick/historian/dreamer ever needs token accounting, we'll add
 *   a `usage` field to `SubagentRunResult.meta` rather than changing
 *   the core contract.
 */
export class PiSubagentRunner implements SubagentRunner {
	readonly harness = "pi";

	/** Path to the `pi` binary. Defaults to whatever's on $PATH. */
	private readonly piBinary: string;
	private readonly spawnImpl: typeof childProcess.spawn;

	constructor(
		options: {
			piBinary?: string;
			/** Test seam for subprocess lifecycle tests. Production uses child_process.spawn. */
			spawnImpl?: typeof childProcess.spawn;
		} = {},
	) {
		this.piBinary = options.piBinary ?? "pi";
		this.spawnImpl = options.spawnImpl ?? childProcess.spawn;
	}

	async run(options: SubagentRunOptions): Promise<SubagentRunResult> {
		const startTime = Date.now();
		const args = buildArgs(options);

		// The model spec is `provider/model` — Pi accepts that directly via
		// `--model provider/id` (no separate `--provider` flag needed). When a
		// fallback chain is configured, `buildArgs` emits Pi's `--models a,b,c`.

		return new Promise<SubagentRunResult>((resolve) => {
			// Track whether we've already resolved so timeout/abort/exit don't
			// double-resolve. JS promises tolerate double-resolve silently but
			// we want explicit control so we can distinguish "timeout fired
			// during normal completion race" from "timeout actually decided
			// the outcome."
			let settled = false;
			const settle = (result: SubagentRunResult) => {
				if (settled) return;
				settled = true;
				resolve(result);
			};

			let child: ReturnType<typeof childProcess.spawn>;
			try {
				child = this.spawnImpl(this.piBinary, args, {
					cwd: options.cwd,
					// Inherit env so OAuth tokens (~/.pi/agent/auth.json),
					// API key env vars, and PATH all flow through. The Pi
					// CLI reads its own auth state from disk on startup.
					env: process.env,
					// We talk to the child only via stdout (JSON events).
					// stdin is closed because print-mode reads piped stdin
					// as additional message content — we already pass the
					// user message via argv. stderr captured for error
					// diagnostics if spawn fails or the model bails out
					// before producing an `agent_end` event.
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				settle({
					ok: false,
					reason: "spawn_failed",
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - startTime,
				});
				return;
			}

			// Capture stderr so we can attach it to error reasons. Pi prints
			// unrecoverable errors (auth failures, network) here before the
			// process exits.
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
				// Cap to prevent unbounded growth on chatty failures.
				if (stderr.length > 16_000) {
					stderr = `${stderr.slice(0, 16_000)}…[truncated]`;
				}
			});

			// Track the final assistant text from `agent_end`. We don't
			// resolve eagerly on `agent_end` — we wait for child exit so
			// the OS has fully reaped the process before the caller's
			// next action (preserving the "no zombie processes" property
			// even if the caller immediately spawns another subagent).
			let finalAssistantText: string | null = null;
			let finalErrorMessage: string | null = null;
			let finalStopReason: string | null = null;
			let sawAgentEnd = false;
			let parseError: string | null = null;

			// child.stdout/stderr can be null only when the corresponding stdio
			// slot is "ignore"/"inherit"/<fd>. We always pass "pipe" for both
			// (above), so they're guaranteed Readable streams here. Still treat
			// a missing stream as a hard parse_failed rather than crashing — this
			// guards against future stdio-config changes that drop the pipe.
			if (!child.stdout) {
				settle({
					ok: false,
					reason: "parse_failed",
					error: "pi child process did not expose stdout (stdio misconfigured)",
					durationMs: Date.now() - startTime,
				});
				return;
			}
			const rl = createInterface({
				input: child.stdout,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			rl.on("line", (line) => {
				if (line.length === 0) return;
				const parsed = parsePiEventLine(line);
				if (!parsed.ok) {
					// Malformed event line — record but don't abort yet,
					// so we can still consume `agent_end` if it arrives
					// intact later. If we never see one, this becomes parse_failed.
					parseError = parsed.error;
					return;
				}
				const event = parsed.event;

				if (typeof event !== "object" || event === null) return;
				const e = event as { type?: string; messages?: unknown };

				if (e.type === "agent_end" && Array.isArray(e.messages)) {
					sawAgentEnd = true;
					const result = extractFinalAssistant(e.messages);
					finalAssistantText = result.text;
					finalStopReason = result.stopReason;
					finalErrorMessage = result.errorMessage;
				}
			});

			// Hard timeout. We use SIGTERM first so the child can flush
			// stdout cleanly, with SIGKILL as a backstop in case it hangs.
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
					if (settled) return;
					terminateChild(child);
					settle({
						ok: false,
						reason: "timeout",
						error: `pi subagent timed out after ${options.timeoutMs}ms`,
						durationMs: Date.now() - startTime,
					});
				}, options.timeoutMs);
			}

			// Caller-driven abort (e.g. dreamer lease loss).
			const onAbort = () => {
				if (settled) return;
				terminateChild(child);
				settle({
					ok: false,
					reason: "abort",
					error: "pi subagent aborted by caller",
					durationMs: Date.now() - startTime,
				});
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (error) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				options.signal?.removeEventListener("abort", onAbort);
				settle({
					ok: false,
					reason: "spawn_failed",
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - startTime,
				});
			});

			child.on("close", (code, signal) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				options.signal?.removeEventListener("abort", onAbort);
				if (settled) return;

				// Common case: agent_end was observed. Decide between
				// success and model_failed based on the embedded stopReason.
				if (sawAgentEnd) {
					if (finalAssistantText === null) {
						settle({
							ok: false,
							reason: "no_assistant",
							error: "pi agent_end did not include an assistant message",
							durationMs: Date.now() - startTime,
							meta: { stderr: stderr.length > 0 ? stderr : undefined },
						});
						return;
					}
					if (finalStopReason === "error" || finalStopReason === "aborted") {
						settle({
							ok: false,
							reason: "model_failed",
							error:
								finalErrorMessage ??
								`pi assistant stopped with reason "${finalStopReason}"`,
							durationMs: Date.now() - startTime,
							meta: { stderr: stderr.length > 0 ? stderr : undefined },
						});
						return;
					}
					settle({
						ok: true,
						assistantText: (finalAssistantText ?? "").trim(),
						durationMs: Date.now() - startTime,
						meta: { stderr: stderr.length > 0 ? stderr : undefined },
					});
					return;
				}

				// No agent_end. Either Pi crashed before completing the
				// turn, or stdout was malformed. Distinguish based on
				// exit code and parseError.
				if (parseError !== null) {
					settle({
						ok: false,
						reason: "parse_failed",
						error: parseError,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							exitCode: code,
							signal,
						},
					});
					return;
				}

				if (code !== 0 || signal !== null) {
					settle({
						ok: false,
						reason: "non_zero_exit",
						error: `pi exited (code=${code}, signal=${signal}) without emitting agent_end. stderr: ${stderr.slice(0, 500) || "(empty)"}`,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							exitCode: code,
							signal,
						},
					});
					return;
				}

				settle({
					ok: false,
					reason: "no_assistant",
					error: `pi exited successfully without emitting agent_end. stderr: ${stderr.slice(0, 500) || "(empty)"}`,
					durationMs: Date.now() - startTime,
					meta: {
						stderr: stderr.length > 0 ? stderr : undefined,
						exitCode: code,
						signal,
					},
				});
			});
		});
	}
}

/**
 * Build the argv for one `pi --print --mode json` invocation.
 *
 * Argument ordering matters: print mode treats positional args as
 * messages, so the user prompt must come last.
 */
export function buildArgs(options: SubagentRunOptions): string[] {
	const args: string[] = [
		"--print",
		"--mode",
		"json",
		// `--no-session` makes Pi use SessionManager.inMemory() — no
		// JSONL is written to ~/.pi/agent/sessions/<cwd>/, so historian /
		// sidekick / dreamer / recomp / compressor child sessions never
		// show up in `pi resume` or the session picker. We don't need
		// the persisted JSONL anyway: the result comes back through the
		// `agent_end` event on stdout (see extractFinalAssistant). Maps
		// directly to OpenCode's "hidden subagent" pattern, which lets
		// historian etc. stay invisible to the user even though they're
		// real LLM rounds the user pays for.
		"--no-session",
		// Disable extension/skill/template discovery in the spawned child
		// for two reasons:
		//   (1) Recursion: without this, every historian/sidekick/dreamer
		//       subagent process loads the magic-context plugin again,
		//       which itself can register its own historian trigger that
		//       fires on the child's brief turn — leading to nested spawn
		//       cycles that just waste API calls and tokens.
		//   (2) Performance: skill/template discovery scans the filesystem
		//       at startup. Subagents don't need any of that — they have
		//       a focused system prompt and one user message.
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		// --no-tools is intentionally NOT set: historian and dreamer use
		// Pi's built-in tools (Edit, Write, etc.) for some maintenance
		// tasks. Sidekick uses ctx_search via the lean subagent extension
		// loaded with `-x` below.
	];

	// Load Magic Context's lean subagent extension entry alongside
	// `--no-extensions`. Verified at pi-coding-agent
	// resource-loader.js:272-274: `--no-extensions` skips Pi's
	// discovered-extensions scan but still loads explicit `-x` paths,
	// so we get tools (ctx_search, ctx_memory, ctx_note, ctx_expand)
	// without recursion risk (the lean entry never registers historian,
	// dreamer, transform, or any other event handler that could spawn
	// further subagents). When the bundle isn't present (e.g. running
	// source from src/ without a build), skip the flag — the subagent
	// will run without Magic Context tools, matching the original
	// `--no-extensions` behavior.
	if (SUBAGENT_ENTRY_PATH) {
		args.push("-x", SUBAGENT_ENTRY_PATH);

		// Only the dreamer subagent gets the elevated ctx_memory action
		// surface (update/merge/archive). Mirrors OpenCode's
		// tool-registry.ts:114 allowedActions split. The flag is read
		// inside the subagent extension via `pi.getFlag(...)`.
		if (DREAMER_ACTION_AGENTS.has(options.agent)) {
			args.push("--magic-context-dreamer-actions");
		}
	}

	if (options.systemPrompt && options.systemPrompt.length > 0) {
		// We intentionally use --system-prompt (replace) rather than
		// --append-system-prompt (chain) because subagents are one-shot
		// and have their own focused system prompt. Mixing in Pi's
		// default coding-assistant prompt would dilute the historian
		// / dreamer / sidekick role guidance.
		args.push("--system-prompt", options.systemPrompt);
	}

	const models = [options.model, ...(options.fallbackModels ?? [])].filter(
		(model): model is string => typeof model === "string" && model.length > 0,
	);
	if (models.length > 1) {
		args.push("--models", models.join(","));
	} else if (models.length === 1) {
		// Pi accepts `provider/model` directly via --model. No need
		// to split into separate --provider / --model flags.
		args.push("--model", models[0]);
	}

	// Positional message argument MUST come last in print-mode argv.
	args.push(options.userMessage);

	return args;
}

/**
 * Extract the final assistant message's text + status from a Pi `agent_end`
 * messages array.
 *
 * Pi's AgentMessage shape (from @mariozechner/pi-ai):
 *   {
 *     role: "user" | "assistant" | "toolResult",
 *     content: Array<{ type: "text" | "toolCall" | "toolResult", ... }>,
 *     stopReason?: "stop" | "error" | "aborted" | ...,
 *     errorMessage?: string,
 *     ...
 *   }
 *
 * The "final assistant message" is the last element of the array with
 * role === "assistant". Its text content is the concatenation of every
 * `{ type: "text", text }` block in `content`.
 */
export function extractFinalAssistant(messages: unknown[]): {
	text: string | null;
	stopReason: string | null;
	errorMessage: string | null;
} {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (typeof msg !== "object" || msg === null) continue;
		const m = msg as {
			role?: string;
			content?: unknown;
			stopReason?: string;
			errorMessage?: string;
		};
		if (m.role !== "assistant") continue;

		const text = Array.isArray(m.content)
			? m.content
					.filter((c): c is { type: string; text: string } => {
						if (typeof c !== "object" || c === null) return false;
						const cc = c as { type?: unknown; text?: unknown };
						return cc.type === "text" && typeof cc.text === "string";
					})
					.map((c) => c.text)
					.join("")
			: "";

		return {
			text,
			stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
			errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
		};
	}
	return { text: null, stopReason: null, errorMessage: null };
}

export function parsePiEventLine(
	line: string,
): { ok: true; event: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, event: JSON.parse(line) };
	} catch (error) {
		return {
			ok: false,
			error: `failed to parse event: ${error instanceof Error ? error.message : String(error)} | line=${line.slice(0, 200)}`,
		};
	}
}

function terminateChild(child: ReturnType<typeof childProcess.spawn>) {
	child.kill("SIGTERM");
	const killHandle = setTimeout(() => {
		if (!child.killed) child.kill("SIGKILL");
	}, 2000);
	if (typeof killHandle.unref === "function") {
		killHandle.unref();
	}
}

export const __test = {
	buildArgs,
	extractFinalAssistant,
	parsePiEventLine,
};

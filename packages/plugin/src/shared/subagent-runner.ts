/**
 * Cross-harness subagent runner abstraction.
 *
 * Magic Context spawns three kinds of subagents — historian, dreamer, sidekick —
 * each as a child "session" with its own model/prompt/tools. OpenCode and Pi
 * have very different APIs for this:
 *
 *   - OpenCode: `client.session.create({parentID}) → client.session.prompt() →
 *     client.session.messages() → client.session.delete()`. The plugin runs
 *     in-process with the OpenCode server and uses its SDK client directly.
 *
 *   - Pi: no in-process child-session API. Instead `pi --print --mode=json`
 *     spawns a non-interactive subprocess that emits structured JSON events
 *     and exits when the agent loop finishes. Sessions are JSONL files on
 *     disk, optionally addressed via `--session <path>`.
 *
 * The runner interface below normalizes both into the same shape so the
 * actual subagent business logic (historian XML parsing, dreamer task loop,
 * sidekick augmentation) can stay harness-agnostic. Each harness ships its
 * own runner implementation; agents take a `SubagentRunner` as a dep instead
 * of reaching for `client.session.*` directly.
 *
 * Step 5a (this commit) defines the contract and ships `PiSubagentRunner`.
 * Step 5b will refactor the OpenCode-side spawn paths in
 * `compartment-runner-historian.ts`, `dreamer/runner.ts`, and
 * `sidekick/agent.ts` onto an `OpenCodeSubagentRunner` so both harnesses
 * share the agent business logic instead of duplicating it. Until 5b lands,
 * OpenCode keeps its existing direct `client.session.*` calls untouched —
 * the runner contract is purely additive on the OpenCode side.
 */

/**
 * Configuration for one subagent invocation.
 *
 * Mirrors the union of OpenCode's `session.create` + `session.prompt` body
 * fields and Pi's `--print` CLI flags, picking the shared subset that all
 * three subagent kinds (historian, dreamer, sidekick) actually use today.
 *
 * Fields:
 * - `agent`: harness-specific agent name. OpenCode looks this up in its
 *   agent registry (`HISTORIAN_AGENT`, `DREAMER_AGENT`, `SIDEKICK_AGENT`).
 *   Pi has no concept of "agent name" beyond config, so this is ignored
 *   on the Pi side and used only by `OpenCodeSubagentRunner`.
 * - `systemPrompt`: full system prompt for this child run. Replaces (not
 *   appends to) any harness-default system prompt.
 * - `userMessage`: the single user-turn prompt. Subagent runs are always
 *   one-shot — no multi-turn conversation in the child.
 * - `model`: provider/model identifier in the canonical "provider/model"
 *   shape (e.g. "anthropic/claude-sonnet-4-7"). Each runner is responsible
 *   for translating to its harness's native model selection.
 * - `fallbackModels`: ordered list of models to try if `model` fails. Both
 *   harnesses retry on transient model failures.
 * - `timeoutMs`: hard cap on the child run. The runner aborts the child on
 *   exceeding this and returns `{ ok: false, reason: "timeout" }`.
 * - `cwd`: working directory for the child. OpenCode uses this for
 *   `query.directory`; Pi uses it as the spawn cwd so that `--cwd`-aware
 *   tools see the right project root.
 * - `signal`: optional AbortSignal so callers can cancel an in-flight run
 *   (used by dreamer's lease-renewal-aborts-on-loss path).
 */
export interface SubagentRunOptions {
    agent: string;
    systemPrompt: string;
    userMessage: string;
    model?: string | undefined;
    fallbackModels?: readonly string[];
    timeoutMs?: number | undefined;
    cwd?: string | undefined;
    signal?: AbortSignal | undefined;
    /**
     * Pi only: explicit thinking level, passed as `--thinking <level>` to the
     * Pi subprocess. OpenCode ignores this field — thinking/reasoning is
     * controlled via `variant` in the OpenCode agent config instead.
     *
     * Required when the configured historian/dreamer model supports reasoning
     * (e.g. github-copilot/gpt-5.4) because Pi's own default resolution may
     * pick a value the provider rejects. Set to "off" to disable thinking for
     * speed (local models), or "medium"/"high" for better quality.
     */
    thinkingLevel?: string | undefined;

    /**
     * Optional progress callback. The runner invokes it for milestone events
     * during the run: spawn, first event received, terminal stop reason
     * detected, child exit. Used by historian/dreamer/sidekick to write
     * lifecycle entries to the magic-context.log without polluting the
     * normal stdout stream.
     *
     * Implementations must be non-throwing and fast — they're called on the
     * runner's hot path. Errors are swallowed.
     */
    onProgress?: (event: SubagentProgressEvent) => void;
}

/**
 * Progress events emitted by a runner during a run. Distinct from the final
 * `SubagentRunResult` — these are mid-run milestones plus (optionally) every
 * raw event the underlying harness emits, so callers can write a complete
 * trace to the log when diagnosing hangs.
 *
 * Categories:
 * - `spawned` / `child_exit` / `stderr` — process lifecycle.
 * - `first_event` — convenience: first event received from the child, useful
 *   for measuring auth/network warmup time.
 * - `terminal` — runner detected the final assistant turn (Pi: assistant
 *   message_end with terminal stopReason and no toolCall; OpenCode: SDK
 *   `agent_end` equivalent).
 * - `raw_event` — every parsed event from the harness's structured output
 *   stream (Pi NDJSON / OpenCode SDK events). Emitted unconditionally so
 *   debug logs can capture the full timeline. The `event` payload is
 *   harness-shaped — callers should treat it as `unknown` and log it raw.
 */
export type SubagentProgressEvent =
    | { type: "spawned"; argv: readonly string[]; pid: number | undefined }
    | { type: "first_event"; eventType: string; ms: number }
    | {
          type: "raw_event";
          eventType: string | undefined;
          event: unknown;
          ms: number;
      }
    | {
          type: "terminal";
          stopReason: string | undefined;
          textLength: number;
          hasToolCall: boolean;
          ms: number;
      }
    | { type: "stderr"; chunk: string }
    | { type: "child_exit"; code: number | null; signal: string | null; ms: number };

/**
 * Result of one subagent invocation.
 *
 * The runner contract is "fail soft": transient errors, timeouts, model
 * failures, and aborts all surface as `{ ok: false, reason }` with a
 * machine-readable reason and a human-readable message. Throwing is
 * reserved for programmer errors (bad arguments, missing dependencies)
 * that the agent code couldn't have caused.
 *
 * Fields:
 * - `ok`: true iff the child produced a final assistant message.
 * - `assistantText`: concatenated text content from the final assistant
 *   message, with leading/trailing whitespace trimmed. Empty string if the
 *   child finished but produced no text (rare — usually means the model
 *   only emitted tool calls and we didn't follow up).
 * - `reason`: failure category, one of:
 *     - `"timeout"`: hit `timeoutMs` before the child finished
 *     - `"abort"`: caller's `signal` was triggered
 *     - `"model_failed"`: every configured model + fallback returned an error
 *     - `"spawn_failed"`: subprocess couldn't start (Pi only — binary missing,
 *       permission denied, etc.)
 *     - `"non_zero_exit"`: child exited unsuccessfully before a final answer
 *     - `"no_assistant"`: child completed without a final assistant message
 *     - `"parse_failed"`: child emitted output we couldn't parse (Pi only —
 *       JSON malformed or unexpected event ordering)
 * - `error`: human-readable detail; safe to log, may include stack info.
 * - `durationMs`: wall-clock time from runner-call to runner-return.
 * - `meta`: optional harness-specific debug payload. Currently unused; left
 *   here so the OpenCode runner can surface the child session ID for log
 *   correlation when Step 5b lands.
 */
export type SubagentRunResult =
    | {
          ok: true;
          assistantText: string;
          durationMs: number;
          meta?: Record<string, unknown>;
      }
    | {
          ok: false;
          reason:
              | "timeout"
              | "abort"
              | "model_failed"
              | "spawn_failed"
              | "non_zero_exit"
              | "no_assistant"
              | "parse_failed";
          error: string;
          durationMs: number;
          meta?: Record<string, unknown>;
      };

/**
 * Abstract runner contract.
 *
 * Each harness ships a single instance — the OpenCode plugin wires
 * `OpenCodeSubagentRunner` and the Pi plugin wires `PiSubagentRunner` in
 * its `extension` boot path. Agent code (historian, dreamer, sidekick)
 * receives the runner as a dep and never reaches for harness-specific
 * client APIs directly.
 */
export interface SubagentRunner {
    /** Human-readable harness name, for logging (`"opencode"` or `"pi"`). */
    readonly harness: string;

    /**
     * Run one subagent invocation to completion.
     *
     * Always resolves with a `SubagentRunResult` — never throws for
     * runtime/transport/model failures. Throwing is reserved for caller
     * misuse (e.g. missing required option fields).
     */
    run(options: SubagentRunOptions): Promise<SubagentRunResult>;
}

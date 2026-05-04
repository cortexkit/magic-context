/**
 * Pi-side `/ctx-aug` slash command.
 *
 * Mirrors the OpenCode `/ctx-aug` flow (see
 * packages/plugin/src/hooks/magic-context/command-handler.ts#executeAugmentation):
 *   1. Validate sidekick is configured.
 *   2. Show a "preparing augmentation" notification (hidden from the LLM).
 *   3. Spawn the sidekick subagent with the user's prompt.
 *   4. If sidekick returned useful text, append it to the prompt as a
 *      `<sidekick-augmentation>` block.
 *   5. Inject the (possibly augmented) prompt as a real user message that
 *      triggers a turn.
 *
 * Implementation differences from OpenCode:
 * - OpenCode uses `client.session.create() + client.session.prompt()` to spawn
 *   sidekick as a child session with `parentID`. Pi has no such API; we
 *   instead spawn `pi --print --mode json` as a subprocess via
 *   `PiSubagentRunner` (see ../subagent-runner.ts).
 * - OpenCode commits the augmented prompt via a server-side `client.session
 *   .prompt()` call. Pi has a native `pi.sendUserMessage(content)` helper
 *   exposed on the `ExtensionAPI`, which is preferred over `ctx.sendUserMessage`
 *   in the command-handler signature because the slash command itself is
 *   already on the input pipeline; we want the augmented prompt to be queued
 *   as the next turn rather than steering an in-flight one.
 * - OpenCode displays the "preparing" message as an ignored notification.
 *   Pi has `ctx.ui.notify()` which only renders in interactive mode. In RPC
 *   or print mode `ctx.hasUI === false` and `ctx.ui.notify()` is a no-op,
 *   which is the correct behavior.
 *
 * Cache safety note: This is the same design we use in OpenCode — the
 * augmentation lands as a new user message rather than mutating any cached
 * prefix. There's no provider-cache concern because every `<sidekick-
 * augmentation>` invocation produces a one-shot user turn, not a
 * persisted prefix change.
 */

import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	isEmptySidekickResult,
	SIDEKICK_SYSTEM_PROMPT,
	stripThinkingBlocks,
} from "@magic-context/core/features/magic-context/sidekick/core";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PiSubagentRunner } from "../subagent-runner";

/**
 * Configuration for Pi's sidekick agent.
 *
 * Same shape as OpenCode's `SidekickConfig` minus the OpenCode-specific
 * agent-name/fallback wiring — Pi just needs a model identifier and an
 * optional override for system prompt and timeout.
 */
export interface PiSidekickConfig {
	/** Provider/model identifier in `provider/model` form, e.g. `anthropic/claude-haiku-4-5`. */
	model: string;
	/** Override for sidekick system prompt. Defaults to SIDEKICK_SYSTEM_PROMPT. */
	systemPrompt?: string;
	/** Hard timeout in ms. Defaults to 30s — sidekick is expected to be fast. */
	timeoutMs?: number;
	/** Pi only: explicit thinking level (--thinking <level>) for sidekick subagent. */
	thinking_level?: string;
}

/**
 * Register the `/ctx-aug` slash command on Pi.
 *
 * The command is a no-op when `config` is undefined (sidekick disabled in
 * config). Pi's command UI will still show the command but invoking it
 * will print a "not configured" message to the user, matching OpenCode's
 * behavior of surfacing the missing configuration via notification rather
 * than hiding the command entirely.
 */
export function registerCtxAugCommand(
	pi: ExtensionAPI,
	config: PiSidekickConfig | undefined,
): void {
	const runner = new PiSubagentRunner();

	pi.registerCommand("ctx-aug", {
		description: "Augment your prompt with relevant project context (sidekick)",
		handler: async (args, ctx) => {
			const prompt = args.trim();

			// Use Pi's session entry IDs for log correlation. The session
			// manager's branch always has at least the current entry.
			const branch = ctx.sessionManager.getBranch();
			const lastEntryId =
				branch.length > 0 ? branch[branch.length - 1]?.id : "unknown";
			const sessionLabel = `pi-session-${lastEntryId}`;

			if (!config) {
				ctx.ui.notify(
					"/ctx-aug: Sidekick is not configured. Add `sidekick.model` to your magic-context.jsonc to enable this command.",
					"warning",
				);
				return;
			}

			if (prompt.length === 0) {
				ctx.ui.notify(
					"/ctx-aug: Usage `/ctx-aug <your prompt>` — provide a prompt to augment with project memory context.",
					"info",
				);
				return;
			}

			// Inform the user. In print/rpc mode this is a no-op (hasUI=false),
			// which is correct: the user invoked /ctx-aug from a non-interactive
			// context and just wants the augmented turn to fire.
			if (ctx.hasUI) {
				ctx.ui.notify(
					"🔍 Preparing augmentation… 2-10s depending on your sidekick provider.",
					"info",
				);
			}

			sessionLog(sessionLabel, "/ctx-aug: spawning sidekick", {
				model: config.model,
			});

			// Spawn sidekick as a Pi subprocess. The subagent inherits the
			// current project's cwd so its tool calls (notably `ctx_search`)
			// resolve against the same project identity as the invoking
			// session. This is what makes cross-harness memory sharing work:
			// sidekick sees the same memories whether spawned from Pi or
			// OpenCode at the same cwd.
			const projectIdentity = resolveProjectIdentity(ctx.cwd);
			sessionLog(sessionLabel, "/ctx-aug: project identity", projectIdentity);

			const result = await runner.run({
				agent: "sidekick",
				systemPrompt: config.systemPrompt ?? SIDEKICK_SYSTEM_PROMPT,
				userMessage: prompt,
				model: config.model,
				timeoutMs: config.timeoutMs ?? 30_000,
				cwd: ctx.cwd,
				signal: ctx.signal,
				thinkingLevel: config.thinking_level,
			});

			if (!result.ok) {
				// Failure modes: timeout, model_failed, spawn_failed, aborted, etc.
				// In all cases we still want the user's prompt to reach the agent —
				// the worst sidekick can do is fail silently, so we send the prompt
				// unaugmented and tell the user via UI notification (interactive
				// only).
				log(
					`[magic-context][pi] /ctx-aug: sidekick failed (${result.reason}): ${result.error}`,
				);
				if (ctx.hasUI) {
					ctx.ui.notify(
						`/ctx-aug: sidekick failed (${result.reason}). Sending prompt without augmentation.`,
						"warning",
					);
				}
				pi.sendUserMessage(prompt);
				return;
			}

			const sidekickText = stripThinkingBlocks(result.assistantText);
			sessionLog(
				sessionLabel,
				`/ctx-aug: sidekick returned ${sidekickText.length} chars in ${result.durationMs}ms`,
			);

			// If sidekick returned the literal "no relevant memories" sentinel
			// (or near-empty text), skip the augmentation block entirely —
			// the agent gets a cleaner prompt. This matches OpenCode's
			// `isEmptySidekickResult` shortcut behavior.
			if (isEmptySidekickResult(sidekickText)) {
				pi.sendUserMessage(prompt);
				return;
			}

			const augmentedPrompt = `${prompt}\n\n<sidekick-augmentation>\n${sidekickText}\n</sidekick-augmentation>`;
			pi.sendUserMessage(augmentedPrompt);
		},
	});
}

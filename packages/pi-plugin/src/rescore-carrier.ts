import type { RescoreCarrier } from "../../plugin/src/hooks/magic-context/rescore-driver";
import type { SubagentRunner } from "../../plugin/src/shared/subagent-runner";

/** A Pi score run has no durable child to reattach; recovery retains its admitted spend. */
export function createPiRescoreCarrier(options: {
	runner: SubagentRunner;
	sessionId: string;
	directory: string;
	timeoutMs: number;
}): RescoreCarrier {
	const active = new Map<string, AbortController>();
	return {
		async complete(request, signal, opened) {
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			const id = request.attempt.id;
			active.set(id, controller);
			try {
				if (!request.profile.model)
					throw new Error("No historian model configured for rescore");
				if (!opened(id) || controller.signal.aborted)
					throw new Error("Rescore owner lost before spawn");
				const result = await options.runner.run({
					agent: "rescore",
					systemPrompt: request.system,
					userMessage: request.prompt,
					model: request.profile.model,
					thinkingLevel:
						request.profile.thinkingLevel ?? request.profile.variant,
					temperature: request.profile.temperature,
					maxOutputTokens: request.profile.maxOutputTokens,
					cwd: options.directory,
					timeoutMs: options.timeoutMs,
					signal: controller.signal,
					accountingSessionId: options.sessionId,
					accountingSubagent: "rescore",
					accountingTask: id,
				});
				if (!result.ok) throw new Error(result.error);
				return result.assistantText;
			} finally {
				signal.removeEventListener("abort", abort);
				active.delete(id);
			}
		},
		async recover() {
			return null;
		},
		async interrupt(id) {
			active.get(id)?.abort();
		},
	};
}

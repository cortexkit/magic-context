import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
	type RescoreCarrier,
	RescoreCarrierActiveError,
	RescorePayloadError,
	type RescoreRecovery,
} from "../../plugin/src/hooks/magic-context/rescore-driver";
import {
	isPidAlive,
	readProcessCommand,
	readProcessStartTime,
} from "../../plugin/src/shared/rpc-utils";
import type {
	SubagentRunner,
	SubagentRunResult,
} from "../../plugin/src/shared/subagent-runner";

interface PiRunIdentity {
	carrier: "pi-rescore";
	id: string;
	host: string;
	pid: number | null;
	startedAt: number | null;
}
interface ActiveRun {
	controller: AbortController;
	terminal: Promise<void>;
	finished: boolean;
}
const activeRuns = new Map<string, ActiveRun>();

function identityFrom(id: string): PiRunIdentity | null {
	try {
		const value = JSON.parse(id) as PiRunIdentity;
		return value.carrier === "pi-rescore" &&
			/^[a-f0-9-]{36}$/.test(value.id) &&
			typeof value.host === "string" &&
			(value.pid === null ||
				(Number.isSafeInteger(value.pid) && value.pid > 0)) &&
			(value.startedAt === null || Number.isFinite(value.startedAt))
			? value
			: null;
	} catch {
		return null;
	}
}
function processState(identity: PiRunIdentity): RescoreRecovery["state"] {
	if (identity.host !== hostname() || identity.pid === null) return "unknown";
	const alive = isPidAlive(identity.pid);
	if (alive === "dead") return "unavailable";
	if (alive !== "alive") return "unknown";
	const startedAt = readProcessStartTime(identity.pid);
	if (
		startedAt !== null &&
		identity.startedAt !== null &&
		Math.abs(startedAt - identity.startedAt) > 1000
	)
		return "unknown";
	// The random token in argv prevents a reused PID from receiving a score-run interrupt.
	const command = readProcessCommand(identity.pid);
	return command?.includes(`mc-pi-subagent-${identity.id}-`)
		? "active"
		: "unknown";
}

/** Pi has no saved answer to reattach. A replacement call waits for proof that the old subprocess ended. */
export function createPiRescoreCarrier(options: {
	runner: SubagentRunner;
	sessionId: string;
	directory: string;
	timeoutMs: number;
}): RescoreCarrier {
	return {
		async complete(request, signal, opened, stage) {
			if (!stage)
				throw new Error("Pi score completions require durable payload handoff");
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			const identity: PiRunIdentity = {
				carrier: "pi-rescore",
				id: randomUUID(),
				host: hostname(),
				pid: null,
				startedAt: null,
			};
			let carrierId = JSON.stringify(identity);
			let finish!: () => void;
			const active: ActiveRun = {
				controller,
				terminal: new Promise((resolve) => {
					finish = resolve;
				}),
				finished: false,
			};
			activeRuns.set(identity.id, active);
			let handedOff = false;
			let handoffError: Error | undefined;
			const handoff = (result: SubagentRunResult) => {
				if (!result.ok || handedOff || handoffError) return;
				try {
					if (!stage(result.assistantText))
						throw new RescoreCarrierActiveError(
							"Score owner lost before payload staging",
						);
					handedOff = true;
				} catch (error) {
					handoffError =
						error instanceof RescoreCarrierActiveError
							? error
							: new RescorePayloadError("Score payload could not be staged");
					throw handoffError;
				}
			};
			try {
				if (!request.profile.model)
					throw new Error("No historian model configured for rescore");
				if (!opened(carrierId) || controller.signal.aborted)
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
					accountingTask: request.attempt.id,
					waitForExit: true,
					runIdentity: identity.id,
					onResult: handoff,
					onProgress(event) {
						if (event.type !== "spawned" || event.pid === undefined) return;
						identity.pid = event.pid;
						identity.startedAt = readProcessStartTime(event.pid);
						const updated = JSON.stringify(identity);
						if (!opened(updated, carrierId)) controller.abort();
						else carrierId = updated;
					},
				});
				if (handoffError) throw handoffError;
				if (!result.ok) throw new Error(result.error);
				handoff(result);
				return result.assistantText;
			} finally {
				signal.removeEventListener("abort", abort);
				active.finished = true;
				finish();
			}
		},
		async recover(id) {
			const identity = identityFrom(id);
			if (!identity) return { state: "unknown" };
			const active = activeRuns.get(identity.id);
			if (active) return { state: active.finished ? "unavailable" : "active" };
			return {
				state: processState(identity) as "active" | "unavailable" | "unknown",
			};
		},
		async interrupt(id) {
			const identity = identityFrom(id);
			if (!identity) return false;
			const active = activeRuns.get(identity.id);
			if (active) {
				active.controller.abort();
				await active.terminal;
				return true;
			}
			if (processState(identity) === "unavailable") return true;
			if (processState(identity) !== "active" || identity.pid === null)
				return false;
			process.kill(identity.pid, "SIGTERM");
			const start = Date.now();
			let killed = false;
			while (Date.now() - start < 10_000) {
				const state = processState(identity);
				if (state === "unavailable") return true;
				if (!killed && Date.now() - start >= 2000 && state === "active") {
					process.kill(identity.pid, "SIGKILL");
					killed = true;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return false;
		},
		async release(id, preserveRecovery) {
			const identity = identityFrom(id);
			if (
				identity &&
				!preserveRecovery &&
				activeRuns.get(identity.id)?.finished
			)
				activeRuns.delete(identity.id);
		},
	};
}

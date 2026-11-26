import type { DecisionCalibration } from "@magic-context/core/hooks/magic-context/decision-calibration";
import { sessionLog } from "@magic-context/core/shared/logger";
import {
	formatSmallWindowCondition,
	smallWindowCondition,
} from "@magic-context/core/shared/small-window";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";

/** Sessions and models already told in this process. */
const notified = new Set<string>();
/** Sessions and models already decided, with the inputs they were decided for. */
const decided = new Map<string, string>();
/** A number per object, so a key can name an object without serializing it. */
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function objectId(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	let id = objectIds.get(value);
	if (id === undefined) {
		id = nextObjectId++;
		objectIds.set(value, id);
	}
	return id;
}

/**
 * Tell the user once per session and model in this process that the system
 * prompt and active tool definitions take more than half of the reduction
 * point. Only Pi's notification line (`ctx.ui.notify`) and the log show it:
 * it adds no session entry, sends no message and changes nothing in the
 * request. `/ctx-status` shows the same condition from its own numbers while it
 * holds, so a restart only repeats the notification.
 *
 * It measures the system prompt and the active tools the way the replay fit
 * check does (`readPiLkgFitEnvelope`), so it says nothing when Pi cannot tell
 * which tools are active.
 */
export function reportPiSmallWindow(args: {
	ctx: {
		getSystemPrompt?: () => unknown;
		model?: unknown;
		hasUI?: boolean;
		ui?: {
			notify?: (
				message: string,
				type?: "info" | "warning" | "error",
			) => unknown;
		};
	};
	pi: { getAllTools?: () => unknown; getActiveTools?: () => unknown };
	sessionId: string;
	modelKey: string | null | undefined;
	/** The request size at which reduction starts for this session. */
	reductionPointTokens: number | undefined;
	/** Read only when a decision is due (see below). */
	calibration: () => DecisionCalibration;
}): boolean {
	if (!args.modelKey) return false;
	const key = `${args.sessionId}\0${args.modelKey}`;
	if (notified.has(key)) return false;
	// Decide again only when one of these changed: each active tool's name,
	// the length of its description and which parameter-schema object it has
	// (Pi lists its tools as new wrappers on every call, but a tool's schema
	// object is the one it was registered with, so a tool registered again
	// under the same name gets a new one); the system prompt's length; and the
	// reduction point. A decided pass does not read the calibration or
	// tokenize the tool envelope. The key does not see a description edited
	// to the same length with the same schema object, a schema changed in
	// place, a system prompt changed to the same length, or a change in the
	// model's calibration; those are seen at the next decision.
	const active = args.pi.getActiveTools?.();
	const activeNames = Array.isArray(active) ? new Set(active) : undefined;
	const all = args.pi.getAllTools?.();
	const tools = Array.isArray(all)
		? all
				.filter(
					(tool) =>
						!activeNames ||
						activeNames.has((tool as { name?: unknown } | null)?.name),
				)
				.map((tool) => {
					const { name, description, parameters } = (tool ?? {}) as {
						name?: unknown;
						description?: unknown;
						parameters?: unknown;
					};
					return `${String(name)}:${typeof description === "string" ? description.length : "?"}:${objectId(parameters)}`;
				})
				.join("\0")
		: "?";
	const prompt = args.ctx.getSystemPrompt?.();
	const decisionKey = `${tools}\0${typeof prompt === "string" ? prompt.length : "?"}\0${args.reductionPointTokens ?? ""}`;
	if (decided.get(key) === decisionKey) return false;
	decided.set(key, decisionKey);
	const calibration = args.calibration();
	const envelope = readPiLkgFitEnvelope(
		args.ctx,
		args.pi,
		args.modelKey,
		calibration,
	);
	if (!envelope || envelope.refusalToolDefinitionTokens === undefined)
		return false;
	const ratios = envelope.calibration ?? calibration;
	const condition = smallWindowCondition({
		systemPromptTokens: envelope.systemTokens * ratios.systemRatio,
		toolDefinitionTokens:
			envelope.refusalToolDefinitionTokens * ratios.toolsRatio,
		reductionPointTokens: args.reductionPointTokens,
	});
	if (!condition) return false;
	notified.add(key);
	const text = formatSmallWindowCondition(condition, args.modelKey);
	sessionLog(args.sessionId, `small window: ${text}`);
	if (args.ctx.hasUI && typeof args.ctx.ui?.notify === "function") {
		try {
			const result = args.ctx.ui.notify(text, "warning");
			if (result && typeof (result as PromiseLike<unknown>).then === "function")
				void Promise.resolve(result).catch(() => {});
		} catch {
			// The log line above already carries it.
		}
	}
	return true;
}

/** Test helper: forget which sessions were told. */
export function resetPiSmallWindowReportsForTest(): void {
	notified.clear();
	decided.clear();
}

import { afterEach, describe, expect, mock, test } from "bun:test";
import { resolveDecisionCalibration } from "@magic-context/core/hooks/magic-context/decision-calibration";
import {
	reportPiSmallWindow,
	resetPiSmallWindowReportsForTest,
} from "./small-window-pi";

afterEach(() => resetPiSmallWindowReportsForTest());

const sentence = "Runs a command in the workspace and returns its output. ";

function host(toolWords: number) {
	const notify = mock(() => {});
	const tools = [
		{
			name: "bash",
			description: sentence.repeat(toolWords),
			parameters: { type: "object" },
		},
		{
			name: "read",
			description: "Read a file.",
			parameters: { type: "object" },
		},
	];
	return {
		notify,
		ctx: {
			hasUI: true,
			ui: { notify },
			getSystemPrompt: () => `You are a coding agent. ${sentence.repeat(500)}`,
		},
		pi: { getAllTools: () => tools, getActiveTools: () => ["bash", "read"] },
	};
}

describe("Pi: telling the user the window is too small", () => {
	test("notifies once per session and model through Pi's notification line", () => {
		const { ctx, pi, notify } = host(1_500);
		const args = {
			ctx,
			pi,
			sessionId: "pi-small",
			modelKey: "litellm/proxy-model",
			reductionPointTokens: 20_000,
			calibration: () => resolveDecisionCalibration(undefined, undefined),
		};
		expect(reportPiSmallWindow(args)).toBe(true);
		expect(reportPiSmallWindow(args)).toBe(false);
		expect(notify).toHaveBeenCalledTimes(1);
		const [message, type] = notify.mock.calls[0] as unknown as [string, string];
		expect(type).toBe("warning");
		expect(message).toMatch(
			/^Context window too small for litellm\/proxy-model: the system prompt \([\d,]+ tokens\) and tool definitions \([\d,]+ tokens\) take \d+% of the 20,000 tokens at which reduction starts, leaving about [\d,]+ tokens for the conversation\. Raise the model's context setting or remove tools\.$/,
		);
		// Another model of the same session is told again.
		expect(
			reportPiSmallWindow({ ...args, modelKey: "litellm/other-model" }),
		).toBe(true);
	});

	test("says nothing when the window is large enough or the active tools are unknown", () => {
		const { ctx, pi, notify } = host(1_500);
		const base = {
			ctx,
			sessionId: "pi-quiet",
			modelKey: "litellm/proxy-model",
			calibration: () => resolveDecisionCalibration(undefined, undefined),
		};
		expect(
			reportPiSmallWindow({ ...base, pi, reductionPointTokens: 1_000_000 }),
		).toBe(false);
		expect(
			reportPiSmallWindow({
				...base,
				pi: { getAllTools: pi.getAllTools },
				reductionPointTokens: 20_000,
			}),
		).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	test("a decided pass reads no calibration and serializes no tools until an input changes", () => {
		const { ctx, notify } = host(1_500);
		// Pi lists its tools as new wrappers on every call around the
		// definitions it registered, whose schema objects stay the same.
		const registered = [
			{ name: "bash", description: "Run.", parameters: { type: "object" } },
			{ name: "read", description: "Read.", parameters: { type: "object" } },
		];
		const allTools = mock(() => registered.map((tool) => ({ ...tool })));
		let active = ["bash"];
		const pi = { getAllTools: allTools, getActiveTools: () => active };
		const calibration = mock(() =>
			resolveDecisionCalibration(undefined, undefined),
		);
		const args = {
			ctx,
			pi,
			sessionId: "pi-decided",
			modelKey: "litellm/proxy-model",
			// Large enough that nothing is said: the quiet case is the one that
			// would otherwise repeat its work on every pass.
			reductionPointTokens: 1_000_000,
			calibration,
		};
		for (let pass = 0; pass < 8; pass++)
			expect(reportPiSmallWindow(args)).toBe(false);
		expect(calibration).toHaveBeenCalledTimes(1);
		// A changed tool set is decided again, once.
		active = ["bash", "read"];
		for (let pass = 0; pass < 3; pass++)
			expect(reportPiSmallWindow(args)).toBe(false);
		expect(calibration).toHaveBeenCalledTimes(2);
		expect(notify).not.toHaveBeenCalled();
	});

	test("a tool registered again under the same name with a larger definition is decided again and warns", () => {
		const { ctx, notify } = host(1_500);
		const registered = [
			{ name: "bash", description: "Run.", parameters: { type: "object" } },
		];
		const pi = {
			getAllTools: () => registered.map((tool) => ({ ...tool })),
			getActiveTools: () => ["bash"],
		};
		const args = {
			ctx,
			pi,
			sessionId: "pi-redefined",
			modelKey: "litellm/proxy-model",
			reductionPointTokens: 20_000,
			calibration: () => resolveDecisionCalibration(undefined, undefined),
		};
		expect(reportPiSmallWindow(args)).toBe(false);
		expect(reportPiSmallWindow(args)).toBe(false);
		// Same name, same active list: only the definition changed.
		registered[0] = {
			name: "bash",
			description: sentence.repeat(1_500),
			parameters: { type: "object" },
		};
		expect(reportPiSmallWindow(args)).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
	});
});

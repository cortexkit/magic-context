import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiSubagentHostTools } from "./subagent-host-tools";
import * as runner from "./subagent-runner";

function host() {
	const handlers = new Map<string, () => void>();
	let names: string[] | undefined;
	const getAllTools = mock(() => {
		if (!names) throw new Error("Extension runtime not initialized");
		return names.map((name) => ({ name }));
	});
	const pi = {
		on: (event: string, handler: () => void) => handlers.set(event, handler),
		getAllTools,
	} as unknown as ExtensionAPI;
	return {
		pi,
		getAllTools,
		handlers,
		bind: (tools: string[]) => {
			names = tools;
		},
	};
}

afterEach(() => {
	mock.restore();
	runner.__test.resetHostToolState();
});

describe("subagent host registry lifecycle", () => {
	it("plain Pi registers no registry supplier or action callback", () => {
		const configure = spyOn(runner, "configurePiSubagentHostTools");
		const h = host();
		registerPiSubagentHostTools(h.pi, "pi");
		expect(configure).not.toHaveBeenCalled();
		expect(h.handlers.size).toBe(0);
		expect(h.getAllTools).not.toHaveBeenCalled();
	});

	it("OMP publishes only a started API and an unbound load cannot replace it", () => {
		const configure = spyOn(runner, "configurePiSubagentHostTools");
		const serving = host();
		registerPiSubagentHostTools(serving.pi, "omp");
		expect(configure).not.toHaveBeenCalled();
		expect(serving.getAllTools).not.toHaveBeenCalled();
		// The host binds actions on the shared runtime of this same API object.
		serving.bind(["read", "glob"]);
		serving.handlers.get("session_start")?.();
		const supplier = configure.mock.calls[0]?.[0];
		expect(supplier?.()).toEqual(["read", "glob"]);
		serving.bind(["read"]);
		expect(supplier?.()).toEqual(["read"]);
		const unbound = host();
		registerPiSubagentHostTools(unbound.pi, "omp");
		expect(configure).toHaveBeenCalledTimes(1);
		expect(unbound.getAllTools).not.toHaveBeenCalled();
		expect(supplier?.()).toEqual(["read"]);
		serving.handlers.get("session_shutdown")?.();
		expect(supplier?.()).toBeUndefined();
	});
});

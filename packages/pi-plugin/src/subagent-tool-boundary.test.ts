import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	OMP_CHILD_TOOL_CONFIG,
	registerSubagentToolBoundary,
	SUBAGENT_TOOL_ALLOWLIST_FLAG,
} from "./subagent-tool-boundary";

let exit: ReturnType<typeof spyOn>;
let diagnostic = "";
let stderr: ReturnType<typeof spyOn>;
beforeEach(() => {
	diagnostic = "";
	exit = spyOn(process, "exit").mockImplementation(() => {
		throw new Error("child exited");
	});
	stderr = spyOn(process.stderr, "write").mockImplementation((text) => {
		diagnostic += String(text);
		return true;
	});
});
afterEach(() => {
	exit.mockRestore();
	stderr.mockRestore();
});

it("disables OMP write transports without changing provider extension settings", () => {
	expect(OMP_CHILD_TOOL_CONFIG).toBe(
		"tools:\n  xdev: false\nplan:\n  enabled: false\n  defaultOnStartup: false\n",
	);
});

function fixture(
	value: unknown,
	initial = ["unrelated"],
	extra: string[] = [],
) {
	let start: () => Promise<void>;
	let active = initial;
	const setActiveTools = mock(async (names: string[]) => {
		active = [...names, ...extra];
	});
	const registerFlag = mock();
	registerSubagentToolBoundary({
		registerFlag,
		getFlag: () => value,
		getActiveTools: () => active,
		setActiveTools,
		on: (_event: string, handler: () => Promise<void>) => {
			start = handler;
		},
	} as unknown as ExtensionAPI);
	return {
		start: () => start(),
		setActiveTools,
		registerFlag,
		active: () => active,
	};
}

it("replaces discovered tools with the explicit empty active set", async () => {
	const f = fixture("[]");
	await f.start();
	expect(f.active()).toEqual([]);
	expect(f.setActiveTools).toHaveBeenCalledWith([]);
	expect(f.registerFlag).toHaveBeenCalledWith(
		SUBAGENT_TOOL_ALLOWLIST_FLAG,
		expect.objectContaining({ type: "string" }),
	);
});

it("preserves an exact nonempty active allowlist", async () => {
	const f = fixture('["read","ctx_search"]');
	await f.start();
	expect(f.active()).toEqual(["read", "ctx_search"]);
});

it("does not alter standalone calibration sessions without the child flag", async () => {
	const f = fixture(undefined);
	await f.start();
	expect(f.setActiveTools).not.toHaveBeenCalled();
});

it("rejects malformed child selections before setting tools", async () => {
	for (const value of ["null", "{}", '["read",1]', true, "broken"]) {
		const f = fixture(value);
		await expect(f.start()).rejects.toThrow();
		expect(f.setActiveTools).not.toHaveBeenCalled();
		expect(exit).toHaveBeenCalledWith(1);
	}
});

it.each([
	"write",
	"report_issue",
])("refuses a host that adds %s outside the child selection", async (name) => {
	const f = fixture("[]", [], [name]);
	await expect(f.start()).rejects.toThrow("child exited");
	expect(exit).toHaveBeenCalledWith(1);
	expect(diagnostic).toContain("outside the Magic Context child allowlist");
});

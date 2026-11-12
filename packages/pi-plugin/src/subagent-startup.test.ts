import { expect, it } from "bun:test";
import { readSubagentStartupError } from "./subagent-startup";

it("reads only a nonempty private startup failure diagnostic", () => {
	expect(
		readSubagentStartupError({
			type: "magic_context_startup_error",
			error: "storage unavailable",
		}),
	).toBe("storage unavailable");
	for (const event of [
		null,
		"failure",
		{},
		{ type: "extension_error", error: "unrelated" },
		{ type: "magic_context_startup_error", error: "" },
		{ type: "magic_context_startup_error", error: 1 },
	]) {
		expect(readSubagentStartupError(event)).toBeUndefined();
	}
});

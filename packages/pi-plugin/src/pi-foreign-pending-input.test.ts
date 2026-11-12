import { expect, test } from "bun:test";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	piForeignEvidence,
	piProtectPreparedRows,
} from "./pi-dispatch-foreign";
import { piPreparedStructure } from "./pi-dispatch-structure";

test("a first prompt not yet persisted is protected in the handler's committed form", () => {
	const input = [{ role: "user", content: "raw pending prompt" }];
	const source = {
		getEntries: () => [
			{ type: "model_change", id: "model", model: "test" },
			{ type: "thinking_level_change", id: "thinking" },
			{ type: "custom", id: "extension-state", customType: "setup", data: {} },
		],
	};
	const evidence = piForeignEvidence(source, input);
	// Context publication commits processed rows back into the referenced array.
	// The SessionManager can still have only setup metadata in this first-turn window.
	input[0] = { role: "user", content: "§1§ processed pending prompt" };
	const prepared = piPreparedStructure(
		input,
		{ api: "anthropic-messages", provider: "test", id: "test" },
		"omp",
	);
	piProtectPreparedRows(evidence, input, prepared);
	const payload = (text: string) => ({
		messages: [{ role: "user", content: text }, ...input],
	});
	expect(
		piCheckPreparedDispatch(
			payload("processed pending prompt"),
			prepared,
			evidence,
		).mismatch,
	).toContain("foreign rule=3 reason=session-content");
	expect(
		piCheckPreparedDispatch(
			payload("a foreign extension bootstrap"),
			prepared,
			evidence,
		).mismatch,
	).toBeUndefined();
});

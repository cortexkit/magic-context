import { expect, mock, spyOn, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { describeOpenCode1Host, withOpenCode1PromptDiagnostics } from "./opencode1-prompt-diagnostics";

const baseUrl = "http://127.0.0.1:4096";
const sessionPrompt = {
	path: { id: "ses_fixture" },
	body: { parts: [{ type: "text" as const, text: "test turn" }] },
};

test("reports the current OpenCode 1 host on a rejected prompt without replaying it", async () => {
	const reset = Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" });
	const fetch = mock(async () => {
		throw reset;
	});
	const client = createOpencodeClient({ baseUrl, fetch });
	const output = spyOn(console, "error").mockImplementation(() => {});
	try {
		const run = withOpenCode1PromptDiagnostics(
			() => client.session.prompt(sessionPrompt),
			() => describeOpenCode1Host(
				`v1-forward ${baseUrl}`,
				{ pid: process.pid, exitCode: null, signalCode: null },
				"listen output",
				"host error output",
			),
		);
		await expect(run).rejects.toBe(reset);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledTimes(1);
		expect(output.mock.calls[0]![0]).toContain(
			`v1-forward ${baseUrl}: pid=${process.pid} alive=true exitCode=null signal=null`,
		);
		expect(output.mock.calls[0]![0]).toContain("stdout:\nlisten output\nstderr:\nhost error output");
	} finally {
		output.mockRestore();
	}
});

test("includes the signal for an OpenCode 1 host that already exited", () => {
	expect(describeOpenCode1Host("v1-back", { pid: 42, exitCode: null, signalCode: "SIGKILL" }, "", "")).toContain(
		"v1-back: pid=42 alive=false exitCode=null signal=SIGKILL",
	);
});

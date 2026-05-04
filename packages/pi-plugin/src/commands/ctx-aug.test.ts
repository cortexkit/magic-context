import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as subagentModule from "../subagent-runner";
import { createFakePi, fakeContext } from "../test-utils.test";
import { registerCtxAugCommand } from "./ctx-aug";

function installRunner(result: unknown) {
	const run = mock(async () => result);
	const runnerConstructor = spyOn(
		subagentModule,
		"PiSubagentRunner",
	).mockImplementation(() => ({ harness: "pi", run }) as never);
	return { run, constructor: runnerConstructor };
}

describe("registerCtxAugCommand", () => {
	afterEach(() => {
		mock.restore();
	});

	it('registers the "ctx-aug" command with Pi', () => {
		const fake = createFakePi();

		registerCtxAugCommand(fake.pi as never, { model: "test/model" });

		expect(fake.commands.has("ctx-aug")).toBe(true);
	});

	it("sends the prompt with sidekick augmentation when sidekick returns context", async () => {
		const runner = installRunner({
			ok: true,
			assistantText: "Relevant memory context.",
			durationMs: 5,
		});
		try {
			const fake = createFakePi();
			registerCtxAugCommand(fake.pi as never, {
				model: "test/model",
				timeoutMs: 123,
			});
			const command = fake.commands.get("ctx-aug") as {
				handler: (args: string, ctx: never) => Promise<void>;
			};

			await command.handler(
				" implement feature ",
				fakeContext("ses-aug") as never,
			);

			expect(runner.run).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "test/model",
					userMessage: "implement feature",
					timeoutMs: 123,
				}),
			);
			expect(fake.sentMessages).toEqual([
				"implement feature\n\n<sidekick-augmentation>\nRelevant memory context.\n</sidekick-augmentation>",
			]);
		} finally {
			runner.constructor.mockRestore();
		}
	});

	it("surfaces not configured when sidekick config is absent", async () => {
		const fake = createFakePi();
		const notify = mock(() => undefined);
		registerCtxAugCommand(fake.pi as never, undefined);
		const command = fake.commands.get("ctx-aug") as {
			handler: (args: string, ctx: never) => Promise<void>;
		};
		const ctx = { ...fakeContext("ses-aug"), ui: { notify } };

		await command.handler("implement feature", ctx as never);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Sidekick is not configured"),
			"warning",
		);
		expect(fake.sentMessages).toEqual([]);
	});

	it("sends the original prompt unchanged for an empty sidekick result", async () => {
		const runner = installRunner({
			ok: true,
			assistantText: "No relevant memories found.",
			durationMs: 5,
		});
		try {
			const fake = createFakePi();
			registerCtxAugCommand(fake.pi as never, { model: "test/model" });
			const command = fake.commands.get("ctx-aug") as {
				handler: (args: string, ctx: never) => Promise<void>;
			};

			await command.handler(
				"implement feature",
				fakeContext("ses-aug") as never,
			);

			expect(fake.sentMessages).toEqual(["implement feature"]);
		} finally {
			runner.constructor.mockRestore();
		}
	});
});

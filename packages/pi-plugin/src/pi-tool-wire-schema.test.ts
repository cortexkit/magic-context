import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrationForModelKey } from "@magic-context/core/hooks/magic-context/decision-calibration";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";
import { loadPiToolWireSchema } from "./pi-tool-wire-schema";

if (process.env.MC640_HOST) {
	test("callable OMP schemas price exactly the real host wire-schema representation", async () => {
		const root = `${process.env.MC640_HOST}/node_modules/@oh-my-pi`;
		const { type } = await import(`${root}/omptype/src/index.ts`);
		const { toolWireSchema } = await import(
			`${root}/pi-ai/src/utils/schema/wire.ts`
		);
		const tool = {
			name: "read",
			description: "read",
			parameters: type({
				path: "string",
				"limit?": "number",
				"nested?": { enabled: "boolean" },
			}),
		};
		expect(typeof tool.parameters).toBe("function");
		const system = { getSystemPrompt: () => "system" };
		const freeze = calibrationForModelKey(null);
		const resolved = readPiLkgFitEnvelope(
			system,
			{ getAllTools: () => [tool] },
			"test/model",
			freeze,
			toolWireSchema,
		);
		const wire = readPiLkgFitEnvelope(
			system,
			{ getAllTools: () => [{ ...tool, parameters: toolWireSchema(tool) }] },
			"test/model",
			freeze,
		);
		expect(resolved).toBeDefined();
		expect(resolved).toEqual(wire);
	});
}

test("Pi resolves the serving CLI's import-only host wire-schema export", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-wire-schema-"));
	const pkg = join(dir, "node_modules/@oh-my-pi/pi-ai");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({
			type: "module",
			exports: { "./utils/schema/wire": { import: "./wire.js" } },
		}),
	);
	writeFileSync(
		join(pkg, "wire.js"),
		"export function toolWireSchema(tool) { return { type: 'object', title: tool.name }; }\n",
	);
	const previous = process.argv[1];
	process.argv[1] = join(dir, "cli.js");
	try {
		const resolve = await loadPiToolWireSchema();
		expect(resolve).toBeDefined();
		expect(
			resolve?.({ name: "read", description: "read", parameters: () => {} }),
		).toEqual({ type: "object", title: "read" });
	} finally {
		process.argv[1] = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

let directory: string;
let sourcePath: string;

beforeAll(async () => {
	directory = createTestTempDirFromPath(join(tmpdir(), "pi-context-liveness-"));
	sourcePath = join(directory, "guards.js");
	const transpiler = new Bun.Transpiler({ loader: "ts", target: "node" });
	const sources = await Promise.all(
		[
			"pi-context-budget.ts",
			"omp-request-kind.ts",
			"pi-dispatch-chain.ts",
			"pi-context-refusal.ts",
		].map((file) => readFile(new URL(file, import.meta.url), "utf8")),
	);
	// Exercise the real reference-only evidence and session-cache factories in
	// a private scope, without colliding with the other concatenated modules.
	const foreignSource = (
		await readFile(
			new URL("pi-foreign-session-index.ts", import.meta.url),
			"utf8",
		)
	)
		.replace(/^import\b[\s\S]*?;\n/gm, "")
		.replace(/^export /gm, "");
	sources.unshift(`const { createPiForeignSessionIndex, piForeignEvidence, piProtectPreparedRows } = (() => {
${foreignSource}
return { createPiForeignSessionIndex, piForeignEvidence, piProtectPreparedRows };
})();`);
	const handlerSource = await readFile(
		new URL("context-handler.ts", import.meta.url),
		"utf8",
	);
	const sqliteSource = await readFile(
		new URL("../../plugin/src/shared/sqlite.ts", import.meta.url),
		"utf8",
	);
	const sqlite = ts.createSourceFile(
		"sqlite.ts",
		sqliteSource,
		ts.ScriptTarget.Latest,
		true,
	);
	const leaseNames = new Set([
		"NativeWaitLease",
		"nativeWaitScope",
		"releaseNativeWaitLease",
		"withSqliteTurnDeadline",
	]);
	const leaseDeclarations = sqlite.statements.filter((node) =>
		(ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
		node.name
			? leaseNames.has(node.name.text)
			: ts.isVariableStatement(node) &&
				node.declarationList.declarations.some(
					(declaration) =>
						ts.isIdentifier(declaration.name) &&
						leaseNames.has(declaration.name.text),
				),
	);
	expect(leaseDeclarations).toHaveLength(leaseNames.size);
	// The host/storage stubs skip SQL, but the real native-budget lease still
	// participates in request retention. Exercise its actual lifetime helpers.
	sources.unshift(...leaseDeclarations.map((node) => node.getText(sqlite)));
	sources.push(
		await readFile(
			new URL(
				"../../plugin/src/hooks/magic-context/transform-stage-logger.ts",
				import.meta.url,
			),
			"utf8",
		),
	);
	const handler = ts.createSourceFile(
		"context-handler.ts",
		handlerSource,
		ts.ScriptTarget.Latest,
		true,
	);
	const names = new Set([
		"createPiContextGenerationGuard",
		"registerPiContextHandler",
	]);
	const functions = handler.statements.filter(
		(node) =>
			ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
	);
	expect(functions).toHaveLength(names.size);
	// Execute the entire real handler, not a copy of its guard. Host/storage
	// stubs take its no-session exit after it has installed the generation guard.
	sources.push(
		"const contextPassGeneration = new Map<string, symbol>();",
		...functions.map((node) => node.getText(handler)),
	);
	await writeFile(
		sourcePath,
		transpiler
			.transformSync(
				sources
					.join("\n")
					.replace(/^import\b[\s\S]*?;\n/gm, "")
					// Joined modules already contain the declarations behind re-exports.
					.replace(/^export \{[^}]*\} from [^\n]+;\n/gm, ""),
			)
			.replace(/^export /gm, ""),
	);
});

afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

interface Checkpoint {
	requests: number;
	retained_events: number;
	retained_historical_events: number;
	retained_budgets: number;
	retained_snapshots: number;
}

interface LivenessResult {
	runtime: string;
	checkpoints: Checkpoint[];
	retained_after_cleanup: number;
}

async function run(
	runtime: "Node" | "Bun",
	mode: "native" | "omp" | "side" | "retained-guards",
): Promise<LivenessResult> {
	const runner = new URL(
		"__tests__/issue-681-liveness-runner.mjs",
		import.meta.url,
	).pathname;
	const subprocess = Bun.spawn(
		[
			...(runtime === "Node" ? ["node", "--expose-gc"] : [process.execPath]),
			runner,
			sourcePath,
			mode,
		],
		{ stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	expect(stderr).toBe("");
	expect(exit).toBe(0);
	const result = JSON.parse(stdout) as LivenessResult;
	console.log(`${runtime} ${mode}: ${stdout.trim()}`);
	expect(result.checkpoints.map((point) => point.requests)).toEqual([
		32, 64, 96,
	]);
	expect(result.retained_after_cleanup).toBe(0);
	return result;
}

for (const runtime of ["Node", "Bun"] as const) {
	for (const mode of ["native", "omp", "side"] as const) {
		test(`${mode} completed events are collectable (${runtime})`, async () => {
			const result = await run(runtime, mode);
			for (const point of result.checkpoints) {
				expect(point.retained_events).toBeLessThanOrEqual(1);
				expect(point.retained_historical_events).toBe(0);
			}
		});
	}
	test(`native completed budgets are collectable (${runtime})`, async () => {
		const result = await run(runtime, "native");
		for (const point of result.checkpoints)
			expect(point.retained_budgets).toBeLessThanOrEqual(1);
	});
	test(`retained completed guards do not retain request events (${runtime})`, async () => {
		const result = await run(runtime, "retained-guards");
		for (const point of result.checkpoints)
			expect(point.retained_events).toBe(0);
	});
	test(`ended OMP operations release conversation snapshots (${runtime})`, async () => {
		const result = await run(runtime, "omp");
		for (const point of result.checkpoints)
			expect(point.retained_snapshots).toBe(0);
	});
}

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { plugin } from "bun";

export type StageSample = { stage: string; elapsedMs: number };
let observe: ((sample: StageSample) => void) | undefined;
export const instrumentedFiles = new Set<string>();

export function setStageObserver(next: typeof observe): void {
	observe = next;
}

export function timeSync<T>(stage: string, run: () => T): T {
	const start = performance.now();
	try {
		return run();
	} finally {
		observe?.({ stage, elapsedMs: performance.now() - start });
	}
}

export async function timeAsync<T>(stage: string, run: () => T): Promise<T> {
	const start = performance.now();
	try {
		return await run();
	} finally {
		observe?.({ stage, elapsedMs: performance.now() - start });
	}
}

function replaceOnce(
	source: string,
	anchor: string,
	replacement: string,
): string {
	if (source.split(anchor).length !== 2)
		throw new Error(`Timing instrumentation anchor changed: ${anchor}`);
	return source.replace(anchor, replacement);
}

/** Instrument private boundaries in memory; never rewrite the product checkout. */
export function installStageInstrumentation(): void {
	plugin({
		name: "issue-910-stage-timing",
		setup(build) {
			build.onLoad(
				{ filter: /\/(pi-context-refusal|pi-lkg|context-handler)\.ts$/ },
				(args) => {
					let source = readFileSync(args.path, "utf8");
					const helpers = `import { timeSync as __timeSync, timeAsync as __timeAsync } from ${JSON.stringify(import.meta.path)};\n`;
					if (args.path.endsWith("/pi-context-refusal.ts")) {
						for (const name of ["messageSnapshots", "inputBranch"]) {
							source = replaceOnce(
								source,
								`function ${name}(`,
								`function __original_${name}(`,
							);
							source += `\nfunction ${name}(...args) { return __timeSync(${JSON.stringify(name)}, () => __original_${name}(...args)); }\n`;
						}
						source = replaceOnce(
							source,
							"\tpiForeignEvidence,",
							"\tpiForeignEvidence as __original_piForeignEvidence,",
						);
						source +=
							'\nfunction piForeignEvidence(...args) { return __timeSync("foreignEvidence", () => __original_piForeignEvidence(...args)); }\n';
						source = replaceOnce(
							source,
							"handler(event, ctx, budget)",
							'__timeAsync("handler", () => handler(event, ctx, budget))',
						);
						source = replaceOnce(
							source,
							"const prepared = preparePiDispatch(",
							"const __dispatchStart = performance.now();\n\t\t\t\tconst prepared = preparePiDispatch(",
						);
						source = replaceOnce(
							source,
							"budget.completed = true;",
							'__record({ stage: "dispatchPreparation", elapsedMs: performance.now() - __dispatchStart });\n\t\t\t\tbudget.completed = true;',
						);
					} else if (args.path.endsWith("/context-handler.ts")) {
						for (const name of [
							"refreshPiTailHygieneBaseline",
							"getOldestActiveUnprotectedToolTags",
							"toolReclaimDistanceEntries",
							"estimatePiOutgoingInputTokens",
						]) {
							source = replaceOnce(
								source,
								`\t${name},`,
								`\t${name} as __original_${name},`,
							);
							source += `\nfunction ${name}(...args) { return __timeSync(${JSON.stringify(name)}, () => __original_${name}(...args)); }\n`;
						}
						source = replaceOnce(
							source,
							"runPiDebugAssertion(assertTailHygieneLastWriter);",
							'__timeSync("debugTailHygiene", () => runPiDebugAssertion(assertTailHygieneLastWriter));',
						);
					} else {
						source = replaceOnce(
							source,
							"export function createPiLkgCoordinator(",
							"function __original_createPiLkgCoordinator(",
						);
						source += `
export function createPiLkgCoordinator(...args) {
	const coordinator = __original_createPiLkgCoordinator(...args);
	for (const name of ["beginPass", "captureAppliedPass"]) {
		const original = coordinator[name];
		if (typeof original !== "function") throw new Error("Missing LKG timing boundary: " + name);
		coordinator[name] = (...values) => __timeSync("lkg." + name, () => original(...values));
	}
	return coordinator;
}
`;
					}
					instrumentedFiles.add(basename(args.path));
					return {
						contents: `${helpers}import { recordStage as __record } from ${JSON.stringify(import.meta.path)};\n${source}`,
						loader: "ts",
					};
				},
			);
		},
	});
}

export function recordStage(sample: StageSample): void {
	observe?.(sample);
}

import { expect, test } from "bun:test";
import { piCheckPreparedDispatch } from "./pi-dispatch-acceptance";
import {
	createPiForeignSessionIndex,
	piForeignEvidence,
	piProtectPreparedRows,
} from "./pi-dispatch-foreign";
import { piPreparedStructure } from "./pi-dispatch-structure";

function fixture(count: number, arrayContent = false) {
	const input: Record<string, any>[] = Array.from(
		{ length: count },
		(_, index) =>
			arrayContent
				? index % 2
					? {
							role: "toolResult",
							toolCallId: `call-${index - 1}`,
							toolName: "read",
							timestamp: index,
							content: [
								{ type: "text", text: `${index}: ${"result ".repeat(1100)}` },
							],
						}
					: {
							role: "assistant",
							timestamp: index,
							content: [
								{
									type: "thinking",
									thinking: `${index}: ${"thought ".repeat(100)}`,
									thinkingSignature: `signature-${index}`,
								},
								{ type: "text", text: `${index}: answer text` },
								{
									type: "toolCall",
									id: `call-${index}`,
									name: "read",
									arguments: {
										nested: [
											{ value: `${index}: ${"long argument ".repeat(20)}` },
										],
										short: "short",
									},
								},
							],
						}
				: {
						role: "user",
						content: `${index}: ${"body ".repeat(700)}`,
						timestamp: index,
					},
	);
	const served = arrayContent
		? [{ role: "user", content: "active prompt", timestamp: count }]
		: input;
	const output = served.map((message, index) => ({
		...message,
		content: `§${index + 1}§ ${message.content}`,
	}));
	const entries = input.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		message,
	}));
	let entryReads = 0;
	const source = {
		getEntries: () => {
			entryReads++;
			return [...entries];
		},
	};
	const index = createPiForeignSessionIndex();
	const prepared = piPreparedStructure(output, {
		api: "anthropic-messages",
		provider: "test",
		id: "test",
	});
	const own = { system: "system", messages: output };
	const added = {
		system: "system",
		messages: [
			{ role: "user", content: "foreign bootstrap ".repeat(250) },
			...output,
		],
	};
	const dispatch = (foreign: boolean) => {
		const before = { ...index.stats };
		const readsBefore = entryReads;
		const evidence = piForeignEvidence(source, served, index);
		piProtectPreparedRows(evidence, output, prepared);
		expect(
			piCheckPreparedDispatch(foreign ? added : own, prepared, evidence)
				.mismatch,
		).toBeUndefined();
		expect(index.stats.reads - before.reads).toBe(entryReads - readsBefore);
		return {
			hashes: index.stats.hashes - before.hashes,
			renders: index.stats.renders - before.renders,
			comparisons: index.stats.comparisons - before.comparisons,
			wireHashes: index.stats.wireHashes - before.wireHashes,
			reads: entryReads - readsBefore,
			entries: index.stats.entries - before.entries,
		};
	};
	return { input, index, dispatch };
}

test("warm session evidence scales only in constant field comparisons, not hashes or renders", () => {
	// Counters test the actual work even when parallel files/host subprocesses
	// compete for CPU. Wall-time assertions live only in the standalone probe.
	const samples = [900, 9000].map((count) => {
		const f = fixture(count);
		expect(f.dispatch(false)).toEqual({
			hashes: 0,
			renders: 0,
			comparisons: 0,
			wireHashes: 0,
			reads: 0,
			entries: 0,
		});
		const cold = f.dispatch(true);
		expect(cold.hashes).toBe(count);
		expect(cold.renders).toBe(count);
		const warm = f.dispatch(true);
		expect(warm.hashes).toBe(0);
		expect(warm.renders).toBe(0);
		expect(warm.wireHashes).toBe(1);
		expect(warm.reads).toBe(1);
		expect(warm.entries).toBe(0);
		expect(warm.comparisons).toBeGreaterThan(0);
		expect(warm.comparisons).toBeLessThanOrEqual(6 * count);
		let candidateHashes = warm.wireHashes;
		for (let pass = 0; pass < 5; pass++) {
			const next = f.dispatch(true);
			expect(next).toEqual(warm);
			candidateHashes += next.wireHashes;
		}
		expect(candidateHashes).toBe(6);
		expect(f.dispatch(false)).toEqual({
			hashes: 0,
			renders: 0,
			comparisons: 0,
			wireHashes: 0,
			reads: 0,
			entries: 0,
		});
		f.input[Math.floor(count / 2)].content =
			"edited content of exactly one existing entry";
		const edited = f.dispatch(true);
		expect(edited.hashes).toBe(1);
		expect(edited.renders).toBe(1);
		expect(edited.entries).toBe(1);
		expect(edited.wireHashes).toBe(1);
		expect(edited.comparisons).toBeLessThanOrEqual(6 * count);
		return { count, warm };
	});
	const [small, large] = samples;
	expect(large.warm.comparisons).toBe(10 * small.warm.comparisons);
	expect({ ...large.warm, comparisons: 0 }).toEqual({
		...small.warm,
		comparisons: 0,
	});
});

test("array-content revision walks scale only in comparisons and re-render one edited nested argument", () => {
	const baseline = fixture(0, true);
	baseline.dispatch(true);
	const fixed = baseline.dispatch(true).comparisons;
	const samples = [900, 9000].map((count) => {
		const f = fixture(count, true);
		expect(f.dispatch(false)).toEqual({
			hashes: 0,
			renders: 0,
			comparisons: 0,
			wireHashes: 0,
			reads: 0,
			entries: 0,
		});
		expect(f.dispatch(true).renders).toBe(count);
		const warm = f.dispatch(true);
		expect(warm.hashes).toBe(0);
		expect(warm.renders).toBe(0);
		expect(warm.entries).toBe(0);
		expect(warm.wireHashes).toBe(1);
		expect(warm.reads).toBe(1);
		expect(warm.comparisons).toBeGreaterThan(6 * count);
		expect(warm.comparisons).toBeLessThanOrEqual(48 * count + fixed);
		expect(f.dispatch(true)).toEqual(warm);
		f.input[0].content[2].arguments.nested[0].value =
			"replacement nested argument ".repeat(8);
		const changed = f.dispatch(true);
		expect(changed.renders).toBe(1);
		expect(changed.entries).toBe(1);
		expect(changed.hashes).toBeGreaterThan(0);
		expect(f.dispatch(true).renders).toBe(0);
		return warm;
	});
	expect(samples[1].comparisons - fixed).toBe(
		10 * (samples[0].comparisons - fixed),
	);
	expect({ ...samples[0], comparisons: 0 }).toEqual({
		...samples[1],
		comparisons: 0,
	});
});

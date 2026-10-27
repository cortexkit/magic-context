import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

// Randomized proof for issue 789: histories with injected adjacency, encoded
// with OMP's real Anthropic converter, must be admitted; mutated tool ids
// must still refuse. Uses the installed pinned hosts, not a reimplementation.

const require = createRequire(import.meta.url);

type Converter = (
	messages: unknown[],
	model: unknown,
	isOAuthToken: boolean,
	opts?: Record<string, unknown>,
) => { role: string; content: unknown }[];

async function loadConverter(
	alias: string,
): Promise<{ version: string; convert: Converter }> {
	const root = require.resolve(`${alias}/package.json`).slice(0, -12);
	const manifest = require(`${root}package.json`) as { version: string };
	const module = (await import(`${root}src/providers/anthropic.ts`)) as {
		convertAnthropicMessages: Converter;
	};
	return {
		version: manifest.version,
		convert: module.convertAnthropicMessages,
	};
}

const converters = [
	await loadConverter("omp-pi-ai-1889"),
	await loadConverter("omp-pi-ai-1811"),
	await loadConverter("omp-pi-ai-1812"),
	await loadConverter("omp-pi-ai-18126"),
];

const model = {
	api: "anthropic-messages",
	id: "mock",
	provider: "test",
	input: ["text"],
	compat: {},
};

function random(seed: number) {
	let state = seed >>> 0;
	return {
		int: (bound: number) => {
			state = (state + 0x6d2b79f5) >>> 0;
			let v = state;
			v = Math.imul(v ^ (v >>> 15), v | 1);
			v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
			return (((v ^ (v >>> 14)) >>> 0) % bound) >>> 0;
		},
		chance: (p: number) => {
			state = (state + 0x6d2b79f5) >>> 0;
			let v = state;
			v = Math.imul(v ^ (v >>> 15), v | 1);
			v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
			return (((v ^ (v >>> 14)) >>> 0) % 1000) / 1000 < p;
		},
	};
}

type Msg = Record<string, unknown>;

// Simple history: user text, assistants with text and 0-2 tool calls, results
// for those calls. No thinking, images, developer, compaction or controls, so
// the only host repair is the Continue pad.
function history(seed: number, injectAdjacency: boolean): Msg[] {
	const r = random(seed * 7919 + (injectAdjacency ? 101 : 7));
	let clock = 0;
	const messages: Msg[] = [
		{ role: "user", content: "start", timestamp: ++clock },
	];
	const pending: string[] = [];
	let n = 0;
	const length = 4 + r.int(8);
	for (let i = 0; i < length; i++) {
		const kind = r.int(100);
		if (kind < 45) {
			const count = r.int(3);
			const content: unknown[] = [{ type: "text", text: `answer ${i}` }];
			for (let k = 0; k < count; k++) {
				const id = `call_${r.int(4)}`;
				content.push({ type: "toolCall", id, name: "read", arguments: {} });
				pending.push(id);
			}
			messages.push({
				role: "assistant",
				content,
				timestamp: ++clock,
			});
			n++;
			// Inject adjacency: an extra text-only assistant right after one.
			if (injectAdjacency && n % 3 === 0) {
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: `follow-up ${i}` }],
					timestamp: ++clock,
				});
			}
		} else if (kind < 75 && pending.length) {
			const id = pending.shift() as string;
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: `output ${i}` }],
				timestamp: ++clock,
			});
		} else {
			messages.push({
				role: "user",
				content: `user ${i}`,
				timestamp: ++clock,
			});
		}
	}
	messages.push({
		role: "user",
		content: "current request",
		timestamp: ++clock,
	});
	return messages;
}

function wirePayload(converted: { role: string; content: unknown }[]): {
	messages: unknown;
} {
	return { messages: converted };
}

for (const { version, convert } of converters) {
	test(`issue 789 randomized: OMP ${version} wire with adjacency is admitted`, () => {
		let padded = 0;
		for (let seed = 1; seed <= 200; seed++) {
			for (const inject of [false, true]) {
				const messages = history(seed, inject);
				const prepared = piPreparedStructure(structuredClone(messages), model);
				expect(prepared).toBeDefined();
				const converted = convert(structuredClone(messages), model, false, {});
				const payload = wirePayload(converted);
				const mismatch = piPreparedStructureMismatch(payload, prepared);
				if (mismatch) {
					console.log(
						`seed=${seed} inject=${inject} mismatch=${mismatch} prepared=${JSON.stringify(prepared?.messages.map((r) => r.role))} wire=${JSON.stringify(converted.map((m) => m.role))}`,
					);
				}
				expect(mismatch).toBeUndefined();
				if (
					converted.some((m) => m.role === "user" && m.content === "Continue.")
				)
					padded++;
			}
		}
		// The generator must actually reach the repair, or the test is vacuous.
		expect(padded).toBeGreaterThan(20);
	});

	test(`issue 789 randomized: OMP ${version} tool mismatches still refuse`, () => {
		let refused = 0;
		for (let seed = 1; seed <= 100; seed++) {
			const messages = history(seed, true);
			const prepared = piPreparedStructure(structuredClone(messages), model);
			const converted = convert(structuredClone(messages), model, false, {});
			// Mutate the first tool_use id on the wire.
			const mutated = structuredClone(converted);
			const target = (mutated as Msg[]).find(
				(m) =>
					m.role === "assistant" &&
					Array.isArray(m.content) &&
					(m.content as Msg[]).some((b) => b.type === "tool_use"),
			) as Msg | undefined;
			if (!target) continue;
			for (const block of target.content as Msg[]) {
				if ((block as Msg).type === "tool_use") {
					(block as Msg).id = `${(block as Msg).id}-tampered`;
					break;
				}
			}
			const mismatch = piPreparedStructureMismatch(
				wirePayload(mutated as { role: string; content: unknown }[]),
				prepared,
			);
			expect(mismatch).toContain("comparison=");
			refused++;
		}
		expect(refused).toBeGreaterThan(20);
	});
}

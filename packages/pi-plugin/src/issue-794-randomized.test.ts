import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
	piAnthropicAssistantReplay,
	piOmitsTruncatedAssistant,
} from "./pi-dispatch-assistant-history";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

// Randomized proof for issue 794: generated histories with blank, thinking-only
// and aborted assistants are encoded by each pinned Oh My Pi version's real
// Anthropic converter, with its request-time thinking options varied. The
// dispatch check admits those wires except omitted foreign native reasoning:
// preparation cannot see per-attempt replay overrides, so it refuses that
// omission rather than guess the reasoning was not demoted to required text.
// It also refuses an always-required assistant removed or an extra one added.

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
	await loadConverter("omp-pi-ai-1812"),
	await loadConverter("omp-pi-ai-18126"),
	await loadConverter("omp-pi-ai-1813"),
];

const SEED = 794;
const CASES = 600;

function random(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let v = state;
		v = Math.imul(v ^ (v >>> 15), v | 1);
		v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
		return (v ^ (v >>> 14)) >>> 0;
	};
	return {
		int: (bound: number) => next() % bound,
		chance: (p: number) => (next() % 1000) / 1000 < p,
		pick: <T>(items: readonly T[]) => items[next() % items.length] as T,
	};
}

type Msg = Record<string, unknown>;

interface Case {
	messages: Msg[];
	model: Msg;
	opts: Record<string, unknown>;
}

const TARGET = { api: "anthropic-messages", provider: "anthropic" };

// One history with its target model and request options.
function generate(seed: number): Case {
	const r = random(SEED * 100_003 + seed);
	const model = {
		...TARGET,
		id: "claude-sonnet-4-5",
		input: ["text"],
		compat: {
			supportsMidConversationSystem: r.chance(0.4),
			replayUnsignedThinking: r.chance(0.3),
			requiresThinkingPresence: r.chance(0.3),
		},
	};
	// Assistant sources: this model, another Anthropic model, another API.
	const sources = [
		{ ...TARGET, model: model.id },
		{ ...TARGET, model: "claude-opus-4-1" },
		{ api: "openai-responses", provider: "openai", model: "gpt-5" },
	];
	let clock = 0;
	let serial = 0;
	const signatures: string[] = [];
	const redacted: string[] = [];
	const messages: Msg[] = [
		{ role: "user", content: "start", timestamp: ++clock },
	];
	const pending: string[] = [];
	const thinkingBlock = (): Msg => {
		const id = ++serial;
		const text = r.pick(["", " ", `reasoning <${seed}.${id}>`]);
		const signature = r.pick(["", "  ", undefined, `sig-${seed}-${id}`]);
		if (signature?.trim()) signatures.push(signature);
		return {
			type: "thinking",
			thinking: text,
			...(signature === undefined ? {} : { thinkingSignature: signature }),
		};
	};
	const length = 4 + r.int(10);
	for (let step = 0; step < length; step++) {
		const kind = r.int(100);
		if (kind < 55) {
			const content: Msg[] = [];
			const blocks = 1 + r.int(3);
			let calls = 0;
			for (let b = 0; b < blocks; b++) {
				const shape = r.int(100);
				if (shape < 25)
					content.push({ type: "text", text: r.pick(["", " \n", "\t"]) });
				else if (shape < 40)
					content.push({ type: "text", text: `answer <${seed}.${++serial}>` });
				else if (shape < 70) content.push(thinkingBlock());
				else if (shape < 80) {
					const data = r.pick(["", ` `, `opaque-${seed}-${++serial}`]);
					if (data.trim()) redacted.push(data);
					content.push({ type: "redactedThinking", data });
				} else if (shape < 85)
					content.push({ type: "image", data: "AAAA", mimeType: "image/png" });
				else {
					const id = `call_${seed}_${++serial}`;
					content.push({ type: "toolCall", id, name: "read", arguments: {} });
					pending.push(id);
					calls++;
				}
			}
			const stopReason = calls
				? r.pick(["toolUse", "toolUse", "aborted", "stop"])
				: r.pick(["stop", "stop", "aborted", "aborted", "error", "length"]);
			messages.push({
				role: "assistant",
				content,
				...r.pick(sources),
				stopReason,
				timestamp: ++clock,
			});
			// The issue's shape: a refused turn's aborted empty-text assistant.
			if (r.chance(0.25))
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "" }],
					...sources[0],
					stopReason: "aborted",
					timestamp: ++clock,
				});
		} else if (kind < 75 && pending.length) {
			const id = pending.shift() as string;
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: `output ${step}` }],
				timestamp: ++clock,
			});
		} else if (kind < 85) {
			messages.push({
				role: "developer",
				content: `notice ${step}`,
				...(r.chance(0.3) ? { attribution: "user" } : {}),
				timestamp: ++clock,
			});
		} else {
			messages.push({
				role: "user",
				content: r.chance(0.1) ? " " : `user ${step}`,
				timestamp: ++clock,
			});
		}
	}
	// Most requests end with a new user turn; the rest end with the history,
	// which can leave assistants after the last user prompt (where 18.13.0
	// adds its thinking placeholder) or a trailing assistant.
	if (r.chance(0.65))
		messages.push({
			role: "user",
			content: "current request",
			timestamp: ++clock,
		});
	const opts: Record<string, unknown> = {};
	if (r.chance(0.3)) opts.dropAllThinking = true;
	if (r.chance(0.4)) {
		const dropped = new Set<string>();
		for (const signature of signatures)
			if (r.chance(0.5)) dropped.add(`thinking:${signature}`);
		for (const data of redacted)
			if (r.chance(0.5)) dropped.add(`redacted:${data}`);
		opts.droppedThinkingBlocks = dropped;
	}
	if (r.chance(0.5)) opts.thinkingEnabled = true;
	return { messages, model, opts };
}

function alwaysSent(message: Msg, model: Msg): boolean {
	return (
		message.role === "assistant" &&
		!piOmitsTruncatedAssistant(message) &&
		(message.content as Msg[]).some(
			(block) =>
				block.type === "toolCall" ||
				(block.type === "text" && String(block.text).trim().length > 0) ||
				(message.api !== model.api &&
					block.type === "thinking" &&
					String(block.thinking).trim().length > 0),
		)
	);
}

function omitsForeignNativeThinking({ messages, model, opts }: Case): boolean {
	return (
		(model.compat as Msg).replayUnsignedThinking === true &&
		opts.dropAllThinking === true &&
		messages.some(
			(message) =>
				message.role === "assistant" &&
				message.api !== model.api &&
				!piOmitsTruncatedAssistant(message) &&
				(message.content as Msg[]).some(
					(block) =>
						block.type === "thinking" &&
						String(block.thinking).trim().length > 0,
				) &&
				!(message.content as Msg[]).some(
					(block) =>
						block.type === "toolCall" ||
						(block.type === "text" && String(block.text).trim().length > 0),
				),
		)
	);
}

for (const { version, convert } of converters) {
	test(`issue 794 randomized: OMP ${version} converter output is admitted`, () => {
		const totals = {
			cases: 0,
			dropped: 0,
			optional: 0,
			optionalAbsent: 0,
			placeholder: 0,
			padded: 0,
			negatives: 0,
			foreignNegatives: 0,
			refusedForeignNative: 0,
		};
		for (let seed = 1; seed <= CASES; seed++) {
			const { messages, model, opts } = generate(seed);
			const prepared = piPreparedStructure(structuredClone(messages), model);
			expect(prepared).toBeDefined();
			const wire = convert(structuredClone(messages), model, false, opts);
			const mismatch = piPreparedStructureMismatch(
				{ messages: wire },
				prepared,
			);
			totals.cases++;
			if (omitsForeignNativeThinking({ messages, model, opts })) {
				expect(mismatch).toContain("comparison=");
				totals.refusedForeignNative++;
				continue;
			}
			if (mismatch)
				console.log(
					`seed=${SEED} case=${seed} ${version} mismatch=${mismatch} opts=${JSON.stringify({ ...opts, droppedThinkingBlocks: opts.droppedThinkingBlocks ? [...(opts.droppedThinkingBlocks as Set<string>)] : undefined })} prepared=${JSON.stringify(prepared?.messages.map((row) => row.role))} wire=${JSON.stringify(wire)} history=${JSON.stringify(messages)}`,
				);
			expect(mismatch).toBeUndefined();
			for (const message of messages)
				if (
					message.role === "assistant" &&
					!piOmitsTruncatedAssistant(message)
				) {
					const replay = piAnthropicAssistantReplay(message, model, "omp");
					if (replay === "dropped") totals.dropped++;
					if (replay === "optional") totals.optional++;
				}
			const optionalRows =
				prepared?.messages.filter((row) => row.optionalThinking).length ?? 0;
			const allPresent = prepared?.messages.length ?? 0;
			if (optionalRows && wire.length < allPresent) totals.optionalAbsent++;
			if (JSON.stringify(wire).includes("(no reasoning was returned"))
				totals.placeholder++;
			if (
				wire.some((row) => row.role === "user" && row.content === "Continue.")
			)
				totals.padded++;
			// Negative: remove one always-sent assistant from the wire.
			const target = messages.find((message) => alwaysSent(message, model));
			if (target) {
				const content = target.content as Msg[];
				const call = content.find((block) => block.type === "toolCall");
				const text = content.find(
					(block) =>
						block.type === "text" && String(block.text).trim().length > 0,
				);
				const thinking = content.find(
					(block) =>
						block.type === "thinking" &&
						String(block.thinking).trim().length > 0,
				);
				const index = wire.findIndex(
					(row) =>
						row.role === "assistant" &&
						Array.isArray(row.content) &&
						(row.content as Msg[]).some((block) =>
							call
								? block.type === "tool_use" && block.id === call.id
								: text
									? block.type === "text" && block.text === text.text
									: (block.type === "text" || block.type === "thinking") &&
										String(block.text ?? block.thinking).includes(
											String(thinking?.thinking).trim(),
										),
						),
				);
				if (index >= 0) {
					const missing = wire.filter((_, at) => at !== index);
					expect(
						piPreparedStructureMismatch({ messages: missing }, prepared),
					).toContain("comparison=");
					totals.negatives++;
					if (target.api !== model.api && !text && !call)
						totals.foreignNegatives++;
				}
			}
			// Negative: add an extra assistant before the final wire row.
			const extra = [
				...wire.slice(0, -1),
				{ role: "assistant", content: [{ type: "text", text: "extra" }] },
				...wire.slice(-1),
			];
			expect(
				piPreparedStructureMismatch({ messages: extra }, prepared),
			).toContain("comparison=");
		}
		console.log(
			`issue 794 randomized: OMP ${version} seed=${SEED} ${JSON.stringify(totals)}`,
		);
		expect(totals.foreignNegatives).toBeGreaterThan(0);
		expect(totals.refusedForeignNative).toBeGreaterThan(0);
		// The corpus must reach every case the fix is about.
		expect(totals.dropped).toBeGreaterThan(100);
		expect(totals.optional).toBeGreaterThan(50);
		expect(totals.optionalAbsent).toBeGreaterThan(20);
		expect(totals.padded).toBeGreaterThan(20);
		expect(totals.negatives).toBeGreaterThan(100);
		if (version === "18.13.0") expect(totals.placeholder).toBeGreaterThan(5);
	});
}

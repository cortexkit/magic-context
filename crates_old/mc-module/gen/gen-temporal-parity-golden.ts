#!/usr/bin/env bun
import "./quiet-live-log";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeOpenCodeMessagesToCk } from "../../../packages/plugin/src/hooks/magic-context/module-wire";
import { injectTemporalMarkers } from "../../../packages/plugin/src/hooks/magic-context/temporal-awareness";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../testdata/temporal-parity-golden.json");

type RawMessage = {
	info: {
		id: string;
		role: string;
		time: { created: number; completed?: number };
	};
	parts: Array<Record<string, unknown>>;
};

const textMessage = (
	id: string,
	role: string,
	created: number,
	text: string,
	completed?: number,
): RawMessage => ({
	info: {
		id,
		role,
		time: { created, ...(completed === undefined ? {} : { completed }) },
	},
	parts: [{ type: "text", text }],
});

const rawMessages: RawMessage[] = [
	textMessage("temporal-user-1", "user", 1_000, "Earlier question"),
	textMessage("temporal-assistant-1", "assistant", 10_000, "Earlier answer", 70_000),
	textMessage(
		"temporal-user-2",
		"user",
		48_610_000,
		"We'll do a opencode restart soon, do you need to rebuild dists?",
	),
	textMessage("temporal-assistant-2", "assistant", 48_611_000, "No rebuild needed", 48_629_000),
	textMessage(
		"temporal-transport",
		"user",
		48_709_000,
		"<system-reminder>Background work finished.</system-reminder>",
	),
	textMessage("temporal-user-3", "user", 50_569_000, "Continue after the reminder"),
];

const markedMessages = structuredClone(rawMessages);
injectTemporalMarkers(markedMessages);
const expectedTextByMid = Object.fromEntries(
	markedMessages.map((message) => [
		message.info.id,
		message.parts.find((part) => part.type === "text")?.text ?? "",
	]),
);

const golden = {
	schema: 1,
	generator_version: 1,
	provenance: {
		generator: "crates/mc-module/gen/gen-temporal-parity-golden.ts",
		audit_script: "scripts/audit-transform-wire-parity.py",
		sources: [
			{
				lane: "ts",
				file: "2026-08-24T08-33-57-109Z-003521-ses_331acff95fferWZOYF1pG0cjOn-direct-sticky-ufuk2.body.json",
				observed_markers: ["+13h 29m", "+31m"],
			},
			{
				lane: "rust",
				file: "2026-08-24T15-02-25-580Z-004729-ses_0ad83017cffexe0g5N8UG0y3LZ-direct-sticky-main.body.json",
				observed_temporal_carriers: 2,
			},
		],
		note: "Message text is minimized from the audited wire excerpts; timestamps retain the observed marker durations.",
	},
	cases: [
		{
			name: "historical-completed-and-transport-created-bases",
			raw_messages: rawMessages,
			encoded_input: encodeOpenCodeMessagesToCk(rawMessages),
			expected_text_by_mid: expectedTextByMid,
		},
	],
};

writeFileSync(output, `${JSON.stringify(golden, null, 2)}\n`);
console.log(`wrote ${output} (${golden.cases.length} temporal parity case)`);

#!/usr/bin/env bun
/**
 * Local historian prompt harness for prompt-engineering iteration.
 *
 * Reads raw messages from opencode.db for a given session and ordinal range,
 * formats them through the same chunk pipeline production historian uses,
 * sends to a configurable model with the historian system prompt (or an
 * override file), and prints the pseudo-output without writing to magic-context
 * storage.
 *
 * Use this to iterate on COMPARTMENT_AGENT_SYSTEM_PROMPT against real session
 * data without running the plugin or affecting any DB.
 *
 * Usage:
 *   bun packages/plugin/scripts/test-historian-prompt.ts \
 *     --session=ses_331acff95fferWZOYF1pG0cjOn \
 *     --start=1 --end=2000 \
 *     [--prompt-file=path/to/custom.md] \
 *     [--editor-prompt-file=path/to/editor.md]  # for --two-pass
 *     [--existing-state-file=path/to/prev-output.xml] \
 *     [--thinking-budget=8000]  # extended thinking budget, 0 disables
 *     [--two-pass]              # draft-then-edit mode (mutually excl. with thinking)
 *     [--model=claude-sonnet-4-6] \
 *     [--out=path/to/output.xml] \
 *     [--budget=200000]         # input token budget for the raw chunk
 *     [--api-key]               # force API key instead of OAuth
 *
 * Auth: prefers Claude Max OAuth (macOS Keychain via opencode-claude-auth
 * recipe). Falls back to ANTHROPIC_API_KEY env var if no OAuth credentials
 * are available. Pass --api-key to force API-key mode.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT, buildCompartmentAgentPrompt } from "../src/hooks/magic-context/compartment-prompt";
import { readSessionChunk } from "../src/hooks/magic-context/read-session-chunk";
import { estimateTokens } from "../src/hooks/magic-context/read-session-formatting";
import { type ClaudeResponse, type CallOptions, callClaudeOAuth, getClaudeOAuthToken } from "./claude-oauth";

// ─── CLI parsing ─────────────────────────────────────────

interface CliArgs {
	session: string;
	start: number;
	end: number;
	promptFile?: string;
	editorPromptFile?: string;
	existingStateFile?: string;
	model: string;
	out?: string;
	budget: number;
	apiKey: boolean;
	thinkingBudget: number;
	twoPass: boolean;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const out: Partial<CliArgs> = {
		model: "claude-sonnet-4-6",
		budget: 200000,
		apiKey: false,
		thinkingBudget: 0,
		twoPass: false,
	};
	for (const arg of args) {
		if (arg === "--api-key") {
			out.apiKey = true;
			continue;
		}
		if (arg === "--two-pass") {
			out.twoPass = true;
			continue;
		}
		const eq = arg.indexOf("=");
		if (eq === -1 || !arg.startsWith("--")) continue;
		const key = arg.slice(2, eq);
		const value = arg.slice(eq + 1);
		switch (key) {
			case "session": out.session = value; break;
			case "start": out.start = Number.parseInt(value, 10); break;
			case "end": out.end = Number.parseInt(value, 10); break;
			case "prompt-file": out.promptFile = value; break;
			case "editor-prompt-file": out.editorPromptFile = value; break;
			case "existing-state-file": out.existingStateFile = value; break;
			case "model": out.model = value; break;
			case "out": out.out = value; break;
			case "budget": out.budget = Number.parseInt(value, 10); break;
			case "thinking-budget": out.thinkingBudget = Number.parseInt(value, 10); break;
		}
	}
	if (!out.session || !out.start || !out.end) {
		console.error(
			"Usage: bun packages/plugin/scripts/test-historian-prompt.ts --session=ID --start=N --end=M [flags]",
		);
		console.error("  --prompt-file=PATH           override historian system prompt");
		console.error("  --editor-prompt-file=PATH    override editor system prompt (two-pass only)");
		console.error("  --existing-state-file=PATH   load prior compartments/facts as existing state");
		console.error("  --thinking-budget=N          enable extended thinking (N tokens, 0=off)");
		console.error("  --two-pass                   draft-then-edit mode (incompatible with thinking)");
		console.error("  --model=MODEL                model id (default claude-sonnet-4-6)");
		console.error("  --out=PATH                   write final output to file");
		console.error("  --budget=TOKENS              input chunk token budget (default 200000)");
		console.error("  --api-key                    force API-key auth over OAuth");
		process.exit(1);
	}
	if (out.twoPass && out.thinkingBudget && out.thinkingBudget > 0) {
		console.error("✗ --two-pass and --thinking-budget are mutually exclusive");
		process.exit(1);
	}
	return out as CliArgs;
}

// ─── Anthropic call ──────────────────────────────────────

async function callApiKey(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	opts: CallOptions,
): Promise<ClaudeResponse> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error("ANTHROPIC_API_KEY not set and no Claude OAuth credentials available");
	}
	const maxTokens = opts.maxTokens ?? 16000;
	const thinkingBudget = opts.thinkingBudget ?? 0;
	const body: Record<string, unknown> = {
		model,
		max_tokens: thinkingBudget > 0 ? maxTokens + thinkingBudget : maxTokens,
		system: systemPrompt,
		messages: [{ role: "user", content: userPrompt }],
	};
	if (thinkingBudget > 0) {
		body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
		body.temperature = 1;
	}
	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`Anthropic API ${response.status}: ${errText}`);
	}
	return (await response.json()) as ClaudeResponse;
}

async function callClaude(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	forceApiKey: boolean,
	opts: CallOptions,
): Promise<{ response: ClaudeResponse; authMode: "oauth" | "api-key" }> {
	if (!forceApiKey && getClaudeOAuthToken()) {
		const response = await callClaudeOAuth(model, systemPrompt, userPrompt, opts);
		return { response, authMode: "oauth" };
	}
	const response = await callApiKey(model, systemPrompt, userPrompt, opts);
	return { response, authMode: "api-key" };
}

// ─── Output helpers ──────────────────────────────────────

function extractText(response: ClaudeResponse): string {
	return response.content
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");
}

function printStats(label: string, outputText: string): void {
	const compartmentCount = (outputText.match(/<compartment\s/g) ?? []).length;
	const uLineCount = (outputText.match(/^U:\s/gm) ?? []).length;
	const factCount = (outputText.match(/^\*\s/gm) ?? []).length;
	console.error(`\n══ STATS [${label}] ══`);
	console.error(`Compartments: ${compartmentCount}`);
	console.error(`U: lines:     ${uLineCount}`);
	console.error(`Fact bullets: ${factCount}`);
	if (compartmentCount > 0) {
		console.error(`Avg U: per compartment: ${(uLineCount / compartmentCount).toFixed(1)}`);
	}
}

// ─── Default editor prompt for two-pass mode ─────────────

const DEFAULT_EDITOR_SYSTEM_PROMPT = `You are an editor refining a historian draft. The draft was produced by a first-pass historian and may contain noise — low-signal U: lines, redundant quotes across compartments, and weak preservation decisions.

Your job is to clean the draft:

1. DROP low-signal U: lines:
   - Questions (anything with ?) — resolved decision goes in narrative only
   - Pacing/agreement: "let's go", "yes", "okay", "sounds good", "I agree"
   - Pasted error output, debugging status, mid-process observations
   - Tactical micro-direction: "now look at X", "first check Y"

2. DROP cross-compartment duplicates:
   - Scan U: lines across ALL compartments in the draft
   - If two U: lines express the same intent/decision, keep only ONE — in the compartment where the outcome is actually described

3. STRIP agreement prefixes:
   - "Yes we should X" → keep only the directive content, or drop entirely if nothing substantive remains after "Yes"

4. FOLD into narrative when possible:
   - If a U: line's signal is already captured in the surrounding narrative, drop the U: line
   - Narrative should not need the U: line to be understood

5. KEEP as U: lines ONLY:
   - Hard constraints with concrete values (thresholds, byte sizes, timeouts)
   - Explicit rejections ("X is wrong because Y", "NOT Z")
   - Implementation pivots in future-tense ("instead of A, do B")
   - Source-of-truth corrections

Do NOT change:
- Compartment titles, ranges, or ordering
- Narrative summary text unless it directly references a U: line you dropped (in which case integrate the signal into the narrative)
- Facts — leave the facts section untouched

Output the cleaned version as valid XML matching the original structure. Preserve all XML tags, compartment ranges, and meta.`;

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs();

	const modeLabel = args.twoPass ? "two-pass" : args.thinkingBudget > 0 ? `thinking=${args.thinkingBudget}` : "single-pass";

	console.error(`\n══ Historian Prompt Harness ══`);
	console.error(`Session:  ${args.session}`);
	console.error(`Range:    messages ${args.start}-${args.end}`);
	console.error(`Model:    ${args.model}`);
	console.error(`Mode:     ${modeLabel}`);
	console.error(`Prompt:   ${args.promptFile ?? "(default COMPARTMENT_AGENT_SYSTEM_PROMPT)"}`);
	if (args.twoPass) {
		console.error(`Editor:   ${args.editorPromptFile ?? "(default DEFAULT_EDITOR_SYSTEM_PROMPT)"}`);
	}
	console.error(`Existing: ${args.existingStateFile ?? "(none — empty state)"}`);
	console.error(`Budget:   ${args.budget} tokens input`);
	console.error("");

	// Load system prompt — file override or default
	let systemPrompt = COMPARTMENT_AGENT_SYSTEM_PROMPT;
	if (args.promptFile) {
		systemPrompt = await Bun.file(args.promptFile).text();
		console.error(`✓ Historian prompt: ${estimateTokens(systemPrompt)} tokens`);
	}

	let editorSystemPrompt = DEFAULT_EDITOR_SYSTEM_PROMPT;
	if (args.editorPromptFile) {
		editorSystemPrompt = await Bun.file(args.editorPromptFile).text();
		console.error(`✓ Editor prompt:    ${estimateTokens(editorSystemPrompt)} tokens`);
	}

	// Load existing state
	let existingStateText = "This is your first run. No existing state.";
	if (args.existingStateFile) {
		existingStateText = readFileSync(args.existingStateFile, "utf-8");
		console.error(`✓ Existing state:   ${estimateTokens(existingStateText)} tokens`);
	}

	// Read raw messages via the same chunk pipeline production uses.
	// eligibleEndOrdinal is exclusive — pass end+1 to include `end`.
	console.error("\n→ Reading raw messages from opencode.db...");
	const chunk = readSessionChunk(args.session, args.budget, args.start, args.end + 1);

	if (!chunk.text || chunk.messageCount === 0) {
		console.error(`✗ No messages found in range ${args.start}-${args.end}.`);
		process.exit(1);
	}

	console.error(
		`✓ Chunk: ${chunk.messageCount} messages (raw ${chunk.startIndex}-${chunk.endIndex}), ~${chunk.tokenEstimate} tokens, ${chunk.commitClusterCount} commit clusters`,
	);
	if (chunk.endIndex < args.end) {
		console.error(
			`  ⚠ Chunk truncated by token budget. Got ${chunk.startIndex}-${chunk.endIndex}, requested ${args.start}-${args.end}.`,
		);
		console.error(`  → Increase --budget=${Math.ceil(args.budget * 1.5)} to capture more, or run multi-pass mode.`);
	}

	// Build the historian user prompt
	const userPrompt = buildCompartmentAgentPrompt(
		existingStateText,
		`Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
	);

	const totalInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
	console.error(`\n→ Pass 1: calling ${args.model} (~${totalInputTokens} input tokens)...`);
	const p1Start = Date.now();
	const { response: p1Response, authMode } = await callClaude(
		args.model,
		systemPrompt,
		userPrompt,
		args.apiKey,
		{ thinkingBudget: args.thinkingBudget },
	);
	const p1Elapsed = Date.now() - p1Start;
	const p1Output = extractText(p1Response);

	console.error(
		`✓ Pass 1 in ${(p1Elapsed / 1000).toFixed(1)}s [auth=${authMode}] — input=${p1Response.usage?.input_tokens ?? "?"} output=${p1Response.usage?.output_tokens ?? "?"} tokens, stop=${p1Response.stop_reason ?? "?"}`,
	);
	if (args.thinkingBudget > 0) {
		const thinkingBlocks = p1Response.content.filter((p) => p.type === "thinking");
		const thinkingChars = thinkingBlocks.map((p) => p.thinking ?? "").join("").length;
		console.error(`  extended thinking: ${thinkingBlocks.length} block(s), ~${Math.ceil(thinkingChars / 4)} tokens`);
	}
	printStats("PASS 1", p1Output);

	let finalOutput = p1Output;

	// Two-pass mode: feed pass 1 draft through editor
	if (args.twoPass) {
		const editorUserPrompt = `<draft>\n${p1Output}\n</draft>\n\nReturn the cleaned draft as valid XML.`;
		const editorInputTokens = estimateTokens(editorSystemPrompt) + estimateTokens(editorUserPrompt);
		console.error(`\n→ Pass 2 (editor): calling ${args.model} (~${editorInputTokens} input tokens)...`);
		const p2Start = Date.now();
		const { response: p2Response } = await callClaude(
			args.model,
			editorSystemPrompt,
			editorUserPrompt,
			args.apiKey,
			{},
		);
		const p2Elapsed = Date.now() - p2Start;
		const p2Output = extractText(p2Response);

		console.error(
			`✓ Pass 2 in ${(p2Elapsed / 1000).toFixed(1)}s — input=${p2Response.usage?.input_tokens ?? "?"} output=${p2Response.usage?.output_tokens ?? "?"} tokens, stop=${p2Response.stop_reason ?? "?"}`,
		);
		printStats("PASS 2 (final)", p2Output);

		finalOutput = p2Output;
	}

	console.error(`\n══ FINAL HISTORIAN OUTPUT ══\n`);
	console.log(finalOutput);

	if (args.out) {
		writeFileSync(args.out, finalOutput);
		console.error(`\n✓ Output written to ${args.out}`);
	}
}

main().catch((err) => {
	console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});

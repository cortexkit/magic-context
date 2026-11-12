import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import {
	createPiForeignSessionIndex,
	piForeignEvidence,
	piMaterializeForeignEvidence,
} from "./pi-dispatch-foreign";
import {
	PI_FOREIGN_NON_TEXT_CONTENT_KINDS,
	PI_FOREIGN_NON_TEXT_ENTRY_TYPES,
	PI_FOREIGN_RENDERED_CONTENT_KINDS,
	PI_FOREIGN_RENDERED_ENTRY_TYPES,
	PI_FOREIGN_SERVER_TOOL_KINDS,
} from "./pi-foreign-omp-kinds";
import { piForeignSessionContent } from "./pi-foreign-session-index";

const require = createRequire(import.meta.url);
function pinned(alias: string, file: string) {
	const pkg = require.resolve(`${alias}/package.json`);
	expect(JSON.parse(readFileSync(pkg, "utf8")).version).toBe("18.18.6");
	return join(pkg, "..", "src", file);
}

// Read the installed union, not another handwritten copy of its discriminators.
// A pin bump that adds any kind makes this ordinary suite test fail until both
// both the native reader and the change detector handle its model-visible fields.
function unionKinds(path: string, name: string, property?: string): string[] {
	const source = ts.createSourceFile(
		path,
		readFileSync(path, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const declarations = new Map<string, ts.Node>();
	for (const node of source.statements) {
		if (
			(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
			node.name
		)
			declarations.set(node.name.text, node);
		if (ts.isVariableStatement(node))
			for (const item of node.declarationList.declarations)
				if (ts.isIdentifier(item.name) && item.initializer)
					declarations.set(item.name.text, item.initializer);
	}
	function member(
		node: ts.InterfaceDeclaration | ts.TypeLiteralNode,
		key: string,
	) {
		return node.members.find(
			(item): item is ts.PropertySignature =>
				ts.isPropertySignature(item) &&
				!!item.name &&
				item.name.getText(source) === key,
		)?.type;
	}
	function walk(node: ts.Node | undefined): string[] {
		if (!node) throw new Error("missing pinned type node");
		if (ts.isStringLiteral(node)) return [node.text];
		if (ts.isLiteralTypeNode(node)) return walk(node.literal);
		if (ts.isUnionTypeNode(node)) return node.types.flatMap(walk);
		if (ts.isArrayTypeNode(node)) return walk(node.elementType);
		if (ts.isParenthesizedTypeNode(node)) return walk(node.type);
		if (ts.isTypeAliasDeclaration(node)) return walk(node.type);
		if (ts.isTypeReferenceNode(node))
			return walk(declarations.get(node.typeName.getText(source)));
		if (ts.isTypeQueryNode(node))
			return walk(declarations.get(node.exprName.getText(source)));
		if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node))
			return walk(member(node, "type") ?? member(node, "content"));
		if (node.kind === ts.SyntaxKind.StringKeyword) return [];
		throw new Error(
			`unmodeled pinned type syntax: ${ts.SyntaxKind[node.kind]}`,
		);
	}
	const root = declarations.get(name);
	if (property) {
		if (!root || !ts.isInterfaceDeclaration(root))
			throw new Error("missing pinned interface");
		return [...new Set(walk(member(root, property)))].sort();
	}
	return [...new Set(walk(root))].sort();
}

test("content-kind lists exactly cover the pinned OMP18.18.6 message unions and retained server-tool union", () => {
	const path = pinned("omp-pi-ai-18186", "types.ts");
	const kinds = [
		...PI_FOREIGN_RENDERED_CONTENT_KINDS,
		...PI_FOREIGN_NON_TEXT_CONTENT_KINDS,
	];
	expect(new Set(kinds).size).toBe(kinds.length);
	expect(kinds.toSorted()).toEqual(unionKinds(path, "Message"));
	expect([...PI_FOREIGN_SERVER_TOOL_KINDS].sort()).toEqual(
		unionKinds(path, "AnthropicServerToolContent", "block"),
	);
});

test("entry-type lists exactly cover the pinned OMP18.18.6 SessionEntry union", () => {
	const kinds = [
		...PI_FOREIGN_RENDERED_ENTRY_TYPES,
		...PI_FOREIGN_NON_TEXT_ENTRY_TYPES,
	];
	expect(new Set(kinds).size).toBe(kinds.length);
	expect(kinds.toSorted()).toEqual(
		unionKinds(
			pinned("omp-coding-agent-18186", "session/session-entries.ts"),
			"SessionEntry",
		),
	);
});

function evidenceFor(message: unknown) {
	const entry = { type: "message", id: "e1", message };
	const evidence = piForeignEvidence(
		{ getEntries: () => [entry] },
		[],
		createPiForeignSessionIndex(),
	);
	return { evidence, entry };
}

test("retained server-tool query and result strings are session content, including in-place changes", () => {
	const block = {
		type: "anthropicServerTool",
		block: {
			type: "server_tool_use",
			id: "server1",
			name: "web_search",
			input: { query: "release notes" },
		},
	};
	const result = {
		type: "anthropicServerTool",
		block: {
			type: "web_search_tool_result",
			tool_use_id: "server1",
			content: [{ text: "short result text", title: "result title" }],
		},
	};
	const { evidence } = evidenceFor({
		role: "assistant",
		content: [block, result],
	});
	expect(piMaterializeForeignEvidence(evidence)).toBe(true);
	for (const text of ["release notes", "short result text", "result title"])
		expect(piForeignSessionContent(evidence, text, {})).toBe(true);
	block.block.input.query = "updated query";
	result.block.content[0].text = "updated result";
	expect(piMaterializeForeignEvidence(evidence)).toBe(true);
	for (const text of [
		"release notes",
		"short result text",
		"updated query",
		"updated result",
	])
		expect(piForeignSessionContent(evidence, text, {})).toBe(true);
});

test("fallback is explicitly non-text while unknown content and entry kinds fail closed", () => {
	const { evidence, entry } = evidenceFor({
		role: "assistant",
		content: [
			{
				type: "fallback",
				from: { model: "old-model" },
				to: { model: "new-model" },
			},
		],
	});
	expect(piMaterializeForeignEvidence(evidence)).toBe(true);
	expect(piForeignSessionContent(evidence, "old-model", {})).toBe(false);
	entry.message = {
		role: "assistant",
		content: [{ type: "future-content-kind", text: "not an ignored block" }],
	};
	expect(piMaterializeForeignEvidence(evidence)).toBe(false);
	entry.type = "future-entry-kind";
	expect(piMaterializeForeignEvidence(evidence)).toBe(false);
	entry.type = "session_info";
	expect(piMaterializeForeignEvidence(evidence)).toBe(false);
});

test("only named non-text entry types may be ignored", () => {
	for (const type of PI_FOREIGN_NON_TEXT_ENTRY_TYPES) {
		const evidence = piForeignEvidence(
			{ getEntries: () => [{ type, id: type }] },
			[],
		);
		expect(piMaterializeForeignEvidence(evidence)).toBe(true);
	}
});

test("every rendered entry type and known native content kind has a readable fixture", () => {
	const blocks = {
		text: { type: "text", text: "fixture text" },
		thinking: { type: "thinking", thinking: "fixture reasoning" },
		redactedThinking: { type: "redactedThinking", data: "redacted payload" },
		image: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		toolCall: {
			type: "toolCall",
			id: "call1",
			name: "read",
			arguments: { value: "long argument ".repeat(8) },
		},
		anthropicServerTool: {
			type: "anthropicServerTool",
			block: {
				type: "tool_search_tool_result",
				tool_use_id: "call1",
				content: [{ text: "server tool result" }],
			},
		},
		fallback: {
			type: "fallback",
			from: { model: "old" },
			to: { model: "new" },
		},
	};
	expect(Object.keys(blocks).sort()).toEqual(
		[
			...PI_FOREIGN_RENDERED_CONTENT_KINDS,
			...PI_FOREIGN_NON_TEXT_CONTENT_KINDS,
		].sort(),
	);
	for (const block of Object.values(blocks))
		expect(
			piMaterializeForeignEvidence(
				evidenceFor({ role: "assistant", content: [block] }).evidence,
			),
		).toBe(true);
	const fixtures = {
		message: { message: { role: "user", content: "fixture prompt" } },
		custom_message: {
			customType: "fixture",
			content: "fixture custom",
			display: false,
		},
		branch_summary: { fromId: "prior", summary: "fixture branch summary" },
		compaction: {
			summary: "fixture compaction",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
		},
	};
	expect(Object.keys(fixtures).sort()).toEqual(
		[...PI_FOREIGN_RENDERED_ENTRY_TYPES].sort(),
	);
	for (const [type, entry] of Object.entries(fixtures))
		expect(
			piMaterializeForeignEvidence(
				piForeignEvidence(
					{ getEntries: () => [{ ...entry, type, id: type }] },
					[],
				),
			),
		).toBe(true);
});

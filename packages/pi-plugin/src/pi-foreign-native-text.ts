import {
	piForeignKnownContentKind,
	piForeignServerToolBlock,
	piForeignServerToolStrings,
} from "./pi-foreign-omp-kinds";
import { piOmpOutputNotice } from "./pi-foreign-output-notice";

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const string = (value: unknown): string => {
	if (typeof value !== "string") throw new Error("unreadable native text");
	return value;
};

/** Oh My Pi 18.18.6 pi-utils prompt.format, with its default post-render options. */
function summaryFormat(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let code = false;
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trimEnd();
		let indent = 0;
		while (line.charCodeAt(indent) === 32 || line.charCodeAt(indent) === 9)
			indent++;
		if (line.charCodeAt(indent) >= 128)
			indent = line.length - line.trimStart().length;
		const trimmed = line.slice(indent);
		if (/^(?:```|~~~)/u.test(trimmed)) {
			code = !code;
			out.push(line);
			continue;
		}
		if (code) {
			out.push(line);
			continue;
		}
		if (/^\|[-:\s|]+\|$/u.test(trimmed)) {
			line =
				line.slice(0, line.length - trimmed.length) +
				"|" +
				trimmed
					.split("|")
					.filter((cell) => cell.trim())
					.map(
						(cell) =>
							`${cell.trim().startsWith(":") ? ":" : ""}---${cell.trim().endsWith(":") ? ":" : ""}`,
					)
					.join("|") +
				"|";
		} else if (/^\|.*\|$/u.test(trimmed))
			line =
				line.slice(0, line.length - trimmed.length) +
				trimmed
					.split("|")
					.map((cell) => cell.trim())
					.join("|");
		if (!line.trim()) {
			if (i + 1 === lines.length || !lines[i + 1].trim()) {
				while (out.at(-1) === "") out.pop();
				while (i + 1 < lines.length && !lines[i + 1].trim()) i++;
				continue;
			}
			if (!out.length || out.at(-1) === "") continue;
		}
		if (/^<\/[a-z_-]+>$/u.test(trimmed)) while (out.at(-1) === "") out.pop();
		out.push(line);
	}
	while (out.at(-1) === "") out.pop();
	return out.join("\n");
}

function argumentsText(
	value: unknown,
	out: string[],
	ancestors = new Set<object>(),
): void {
	if (typeof value === "string") {
		if (value.length >= 64) out.push(value);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (ancestors.has(value) || ancestors.size > 100)
		throw new Error("unreadable arguments");
	ancestors.add(value);
	for (const child of Object.values(value))
		argumentsText(child, out, ancestors);
	ancestors.delete(value);
}

function contentText(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) throw new Error("unreadable native content");
	const texts: string[] = [];
	const blocks: string[] = [];
	for (const value of content) {
		const part = record(value);
		if (!part) throw new Error("unreadable native block");
		if (!piForeignKnownContentKind(part.type))
			throw new Error("unreadable native block kind");
		if (part.type === "fallback") continue;
		if (part.type === "anthropicServerTool")
			piForeignServerToolStrings(piForeignServerToolBlock(part.block), texts);
		if (typeof part.text === "string") {
			texts.push(part.text);
			blocks.push(part.text);
		}
		if (typeof part.thinking === "string") texts.push(part.thinking);
		if (typeof part.thinkingSignature === "string")
			texts.push(part.thinkingSignature);
		if (part.type === "redactedThinking" && typeof part.data === "string")
			texts.push(part.data);
		if (part.type === "toolCall" || part.type === "tool_use") {
			if (typeof part.name === "string") texts.push(part.name);
			argumentsText(part.arguments ?? part.input, texts);
		}
		if (part.type === "tool_result") texts.push(...contentText(part.content));
	}
	if (blocks.length) texts.push(blocks.join(""), blocks.join("\n"));
	for (const kept of [
		blocks.filter((text) => text.length > 0),
		blocks.filter((text) => text.trim()),
	])
		if (kept.length) texts.push(kept.join(""), kept.join("\n"));
	if (content.some((value) => record(value)?.type === "image")) {
		for (const placeholder of [
			"Image reading is disabled.",
			"[image omitted: the active model does not support image input]",
		]) {
			const replaced = content.flatMap((value) => {
				const part = record(value);
				return part?.type === "image"
					? [placeholder]
					: typeof part?.text === "string"
						? [part.text]
						: [];
			});
			texts.push(
				placeholder,
				replaced.join(""),
				replaced.join("\n"),
				replaced.filter((text) => text.trim()).join("\n"),
			);
		}
	}
	return texts;
}

function executionText(message: Record<string, unknown>): string {
	const python = message.role === "pythonExecution";
	const command = string(python ? message.code : message.command);
	const output = string(message.output);
	let text = python
		? `Ran Python:\n\`\`\`python\n${command}\n\`\`\`\n`
		: `Ran \`${command}\`\n`;
	text += output
		? `${python ? "Output:\n" : ""}\`\`\`\n${output}\n\`\`\``
		: "(no output)";
	if (message.cancelled)
		text += python ? "\n\n(execution cancelled)" : "\n\n(command cancelled)";
	else if (
		message.exitCode !== null &&
		message.exitCode !== undefined &&
		message.exitCode !== 0
	)
		text += python
			? `\n\nExecution failed with code ${message.exitCode}`
			: `\n\nCommand exited with code ${message.exitCode}`;
	return text + piOmpOutputNotice(message.meta);
}

function summaryText(message: Record<string, unknown>): string {
	const summary = string(message.summary);
	const template =
		message.role === "branchSummary"
			? `Branch-return summary:\n\n<summary>\n${summary}\n</summary>\n`
			: message.method === "handoff"
				? `Context replaced. The <handoff> below is a handoff document a prior instance of you wrote from the full conversation. It is your own working memory, not user input.\n- First person inside it refers to you (the prior instance).\n- "Next Steps" is your own resumed plan; re-check it against the latest user message before acting.\n- The handoff already exists and is complete: NEVER write another handoff document unless the user explicitly asks.\nMUST build on prior work; NEVER duplicate prior work.\n\n<handoff>\n${summary}\n</handoff>\n`
				: `Prior model work/tool state available.\nMUST build on prior work; NEVER duplicate prior work.\n\n<summary>\n${summary}\n</summary>\n`;
	return summaryFormat(template);
}

/** Full native row content, rather than individual strings protected as session identities. */
export function piOmpRenderedContent(value: unknown): unknown {
	const message = record(value);
	if (!message) throw new Error("unreadable native message");
	const images = Array.isArray(message.images) ? message.images : [];
	switch (message.role) {
		case "bashExecution":
		case "pythonExecution":
			return [{ type: "text", text: executionText(message) }, ...images];
		case "compactionSummary":
			return message.blocks !== undefined
				? [
						{ type: "text", text: string(message.summary) },
						...(Array.isArray(message.blocks) ? message.blocks : []),
					]
				: [{ type: "text", text: summaryText(message) }, ...images];
		case "branchSummary":
			return [{ type: "text", text: summaryText(message) }, ...images];
		case "fileMention": {
			if (!Array.isArray(message.files))
				throw new Error("unreadable file mention");
			const files = message.files.map((value) => {
				const file = record(value);
				if (!file) throw new Error("unreadable mentioned file");
				return file;
			});
			const text = files
				.map((file) => {
					const path = string(file.path);
					const body = file.content === undefined ? "" : string(file.content);
					return `<file path="${path}">${body ? `\n${body}\n` : "\n"}</file>`;
				})
				.join("\n");
			return [
				{ type: "text", text },
				...files.flatMap((file) => (file.image ? [file.image] : [])),
			];
		}
		case "custom":
			if (
				message.attribution === "user" &&
				message.customType === "collab-prompt"
			) {
				const content =
					typeof message.content === "string"
						? [{ type: "text", text: message.content }]
						: message.content;
				if (!Array.isArray(content))
					throw new Error("unreadable collaboration prompt");
				const text = content
					.flatMap((value) =>
						typeof record(value)?.text === "string"
							? [record(value)!.text]
							: [],
					)
					.join("\n");
				return [
					{
						type: "text",
						text: text
							? `<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n</system-notice>\n${text}\n`
							: "",
					},
					...content.filter((value) => record(value)?.type === "image"),
				];
			}
	}
	return message.content;
}

/** Complete text variants emitted by supported serializers; never individual fragments. */
export function piOmpRenderedTexts(value: unknown): readonly string[] {
	const content = piOmpRenderedContent(value);
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) throw new Error("unreadable native content");
	const originals = content.flatMap((value) =>
		typeof record(value)?.text === "string"
			? [record(value)!.text as string]
			: [],
	);
	const variants = [originals];
	if (content.some((value) => record(value)?.type === "image")) {
		for (const replacement of [
			"Image reading is disabled.",
			"[image omitted: the active model does not support image input]",
		])
			variants.push(
				content.flatMap((value) =>
					record(value)?.type === "image"
						? [replacement]
						: typeof record(value)?.text === "string"
							? [record(value)!.text as string]
							: [],
				),
			);
	}
	return [
		...new Set(
			variants.flatMap((blocks) =>
				[
					blocks,
					blocks.filter((text) => text.length),
					blocks.filter((text) => text.trim()),
				].flatMap((kept) =>
					kept.length ? [kept.join(""), kept.join("\n")] : [],
				),
			),
		),
	];
}

/**
 * Text projections from OMP 18.18.6 session/messages.ts and agent-core/compaction/messages.ts.
 * Include both individual model-visible strings and the complete native envelopes.
 * Identity is exact, not substring or paraphrase detection; argument values shorter
 * than 64 characters are deliberately outside the tool-argument identity fence.
 */
export function piOmpSessionTexts(value: unknown): string[] {
	const message = record(value);
	if (!message) throw new Error("unreadable native message");
	switch (message.role) {
		case "toolResult": {
			const text = contentText(message.content);
			if (
				message.prunedAt !== undefined &&
				(!Array.isArray(message.content) ||
					!message.content.some(
						(value) => record(value)?.type === "text" && record(value)?.text,
					))
			)
				text.push("[Output truncated]");
			return text;
		}
		case "user":
		case "assistant":
		case "developer":
		case "custom":
		case "hookMessage": {
			const texts = [
				...contentText(message.content),
				...contentText(piOmpRenderedContent(message)),
			];
			// Ordinary image-bearing custom/hook messages split into a developer
			// text row and a captioned user image row. Protect that generated caption
			// too, including its text-only-model placeholder, when the entry is cut.
			const isUserPrompt =
				message.role === "custom" &&
				message.attribution === "user" &&
				["collab-prompt", "skill-prompt"].includes(String(message.customType));
			if (
				!isUserPrompt &&
				["custom", "hookMessage"].includes(String(message.role)) &&
				Array.isArray(message.content)
			) {
				const images = message.content.filter(
					(value) => record(value)?.type === "image",
				);
				if (images.length)
					texts.push(
						...contentText([
							{
								type: "text",
								text: `Images attached to ${message.customType}.`,
							},
							...images,
						]),
					);
			}
			return texts;
		}
		case "bashExecution":
		case "pythonExecution": {
			const python = message.role === "pythonExecution";
			const command = string(python ? message.code : message.command);
			const output = string(message.output);
			const text = executionText(message);
			return [
				command,
				output,
				text,
				...contentText([
					{ type: "text", text },
					...(Array.isArray(message.images) ? message.images : []),
				]),
			];
		}
		case "fileMention": {
			if (!Array.isArray(message.files))
				throw new Error("unreadable file mention");
			const texts: string[] = [];
			const groups: string[][] = [[], []];
			for (const value of message.files) {
				const file = record(value);
				if (!file) throw new Error("unreadable mentioned file");
				const path = string(file.path);
				const content = file.content === undefined ? "" : string(file.content);
				const wrapped = `<file path="${path}">${content ? `\n${content}\n` : "\n"}</file>`;
				texts.push(path, content, wrapped);
				groups[file.image ? 1 : 0].push(wrapped);
			}
			for (const [index, group] of groups.entries())
				if (group.length) {
					const text = group.join("\n");
					texts.push(text);
					if (index === 1)
						texts.push(
							...contentText([
								{ type: "text", text },
								...message.files.flatMap((value) =>
									record(value)?.image ? [record(value)!.image] : [],
								),
							]),
						);
				}
			return texts;
		}
		case "compactionSummary":
		case "branchSummary": {
			const summary = string(message.summary);
			if (message.role === "compactionSummary" && message.blocks !== undefined)
				return [
					summary,
					...contentText(message.blocks),
					...contentText([
						{ type: "text", text: summary },
						...(message.blocks as unknown[]),
					]),
				];
			const text = summaryText(message);
			return [
				summary,
				text,
				...contentText([
					{ type: "text", text },
					...(Array.isArray(message.images) ? message.images : []),
				]),
			];
		}
		default:
			throw new Error("unreadable native role");
	}
}

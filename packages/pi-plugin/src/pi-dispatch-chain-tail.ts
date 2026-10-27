import {
	piAgentHistory,
	piIsDeveloperHistory,
} from "./pi-dispatch-agent-history";
import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";
import { piOmpUserHistory } from "./pi-dispatch-omp-user";
import { piToolCallWireId } from "./pi-dispatch-tool-ids";

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const OMITTED_IMAGE = "[image omitted: model does not support vision]";

/**
 * Encode only the appended user/developer messages and paired tool results.
 * Unlike the full-request structural fence, a stored-response continuation must
 * prove the complete delta content. If a host rewrite cannot be represented,
 * refuse the continuation rather than passing the rewritten content through.
 * OMP 18.12.3: openai-codex-responses.ts:4989-5024,5091-5102;
 * openai-shared.ts:1843-1892,2671-2784; utils/harmony-leak.ts:23-57.
 */
export function piEncodeChainTail(
	messages: readonly unknown[],
	assistant: Record<string, unknown>,
	responseItems: readonly unknown[],
	model: PiChatHistoryModel & { identity?: unknown },
): unknown[] | undefined {
	const harmony = object(model.identity)?.class === "gpt-oss";
	const text = (value: string) => {
		const wellFormed = value.replace(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
			"\uFFFD",
		);
		return harmony
			? wellFormed.replace(
					/<\|(start|end|message|channel|constrain|return|call)\|>/g,
					"<\\|$1\\|>",
				)
			: wellFormed;
	};
	const supportsImages = model.input?.includes("image") === true;
	const image = (block: Record<string, unknown>) => {
		const detail =
			block.detail === "original" &&
			object(model.compat)?.supportsImageDetailOriginal !== true
				? "auto"
				: (block.detail ?? "auto");
		const file = object(block.providerFile);
		if (file?.provider === "openai" && typeof file.id === "string" && file.id)
			return { type: "input_image", detail, file_id: file.id };
		if (
			typeof block.url !== "string" &&
			(typeof block.mimeType !== "string" || typeof block.data !== "string")
		)
			return undefined;
		return {
			type: "input_image",
			detail,
			image_url: block.url ?? `data:${block.mimeType};base64,${block.data}`,
		};
	};
	const items: unknown[] = [];
	for (const value of messages) {
		let message = object(value);
		if (!message || message.providerPayload !== undefined) return undefined;
		message = piOmpUserHistory(message);
		if (message.role === "custom" || message.role === "hookMessage") {
			// The context hook sees the persisted custom message, before OMP turns
			// its text into a developer row. Do not guess rows for user-attributed
			// messages, which may wrap the text differently, or for
			// image-bearing messages that expand to more than one provider item.
			if (
				typeof message.customType !== "string" ||
				message.attribution === "user"
			)
				return undefined;
			const converted = piAgentHistory([message], model.api);
			const developer = object(converted[0]);
			if (
				converted.length !== 1 ||
				!developer ||
				!piIsDeveloperHistory(developer)
			)
				return undefined;
			message = {
				...developer,
				role: model.api === "openai-codex-responses" ? "developer" : "user",
			};
		}
		const user = message.role === "user" || message.role === "developer";
		if (!user && message.role !== "toolResult") return undefined;
		const content =
			typeof message.content === "string" && user
				? [{ type: "text", text: message.content }]
				: message.content;
		if (!Array.isArray(content)) return undefined;
		const texts: string[] = [];
		const images: unknown[] = [];
		const ordered: unknown[] = [];
		for (const value of content) {
			const block = object(value);
			if (block?.type === "text" && typeof block.text === "string") {
				texts.push(block.text);
				if (!user || block.text.trim())
					ordered.push({ type: "input_text", text: text(block.text) });
			} else if (block?.type === "image") {
				const encoded = image(block);
				if (!encoded) return undefined;
				images.push(encoded);
				if (supportsImages) ordered.push(encoded);
			} else return undefined;
		}
		if (user) {
			// User input groups text before images; tool output retains block order.
			const input: unknown[] = texts
				.filter((value) => value.trim())
				.map((value) => ({ type: "input_text", text: text(value) }));
			if (supportsImages) input.push(...images);
			else if (images.length)
				input.push({ type: "input_text", text: OMITTED_IMAGE });
			if (input.length) items.push({ role: message.role, content: input });
			continue;
		}
		if (
			typeof message.toolCallId !== "string" ||
			message.providerMetadata !== undefined
		)
			return undefined;
		const id = piToolCallWireId(message.toolCallId, model, assistant);
		const call = responseItems.map(object).find((item) => item?.call_id === id);
		if (
			!id ||
			(call?.type !== "function_call" && call?.type !== "custom_tool_call")
		)
			return undefined;
		const joined = texts.join("\n");
		const output =
			images.length && supportsImages
				? ordered
				: text(
						images.length && !supportsImages
							? joined
								? `${joined}\n${OMITTED_IMAGE}`
								: OMITTED_IMAGE
							: joined,
					);
		items.push({
			type:
				call.type === "custom_tool_call"
					? "custom_tool_call_output"
					: "function_call_output",
			call_id: id,
			output,
		});
	}
	return items;
}

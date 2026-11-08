import { createHash } from "node:crypto";
import {
	LKG_SNAPSHOT_ARRAY,
	LKG_SNAPSHOT_BOOLEAN,
	LKG_SNAPSHOT_KEY,
	LKG_SNAPSHOT_NULL,
	LKG_SNAPSHOT_NUMBER,
	LKG_SNAPSHOT_OBJECT,
	LKG_SNAPSHOT_STRING,
	LKG_SNAPSHOT_UNDEFINED,
	type LkgContentField,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { piGoogleConversation } from "./pi-dispatch-google";

// Limit structure and retained string volume, not just the number of messages.
// Requests above these limits are refused rather than compared incompletely.
const MAX_NODES = 100_000;
const MAX_STRING_UNITS = 32 * 1024 * 1024;
const MAX_DEPTH = 128;
type Position =
	| "root"
	| "messages"
	| "message"
	| "content"
	| "system"
	| "block"
	| "other";

type PiCursorPayload = Record<string, unknown> & {
	conversationState: { rootPromptMessagesJson: readonly unknown[] };
};

function piObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Cursor's provider request carries history as serialized root prompt blobs. */
function piCursorPayload(payload: unknown): PiCursorPayload | undefined {
	const body = piObject(payload);
	const conversationState = piObject(body?.conversationState);
	if (
		!conversationState ||
		!Array.isArray(conversationState.rootPromptMessagesJson)
	)
		return undefined;
	return body as PiCursorPayload;
}

function piCursorBlobId(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array)
		return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
	if (value instanceof ArrayBuffer)
		return piCursorBlobId(new Uint8Array(value));
	return undefined;
}

function piCursorJsonText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	try {
		if (value instanceof Uint8Array) return new TextDecoder().decode(value);
		if (value instanceof ArrayBuffer)
			return new TextDecoder().decode(new Uint8Array(value));
	} catch {
		return undefined;
	}
	return undefined;
}

type PiCursorRootContentPart =
	| { type: "text"; text: string }
	| { type: "image"; image: string; mediaType: string };

function piCursorRootContent(content: unknown): PiCursorRootContentPart[] {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? [{ type: "text", text }] : [];
	}
	if (!Array.isArray(content)) return [];
	const parts: PiCursorRootContentPart[] = [];
	for (const value of content) {
		const item = piObject(value);
		if (item?.type === "text" && typeof item.text === "string") {
			const text = item.text.trim();
			if (text) parts.push({ type: "text", text });
		} else if (
			item?.type === "image" &&
			typeof item.mimeType === "string" &&
			typeof item.data === "string"
		) {
			parts.push({
				type: "image",
				image: `data:${item.mimeType};base64,${item.data}`,
				mediaType: item.mimeType,
			});
		}
	}
	return parts;
}

/** Content-addressed receipts for the managed m[0]/m[1] Cursor root blobs. */
export function piCursorManagedReceipt(
	messages: readonly unknown[],
): string[] | undefined {
	const hashes: string[] = [];
	for (const value of messages.slice(0, 8)) {
		const message = piObject(value);
		if (message?.role !== "user" && message?.role !== "developer") continue;
		const content = piCursorRootContent(message.content);
		const text = content.find((part) => part.type === "text")?.text;
		if (
			!text ||
			!/^(<project-docs>|<user-profile>|<covered-system-messages>|<session-history>|<project-memory>|<memory-mural>|<session-history-since>|<knowledge-updates>|<memory>|§\d+§)/.test(
				text,
			)
		)
			continue;
		hashes.push(
			createHash("sha256")
				.update(JSON.stringify({ role: "user", content }), "utf8")
				.digest("hex"),
		);
	}
	return hashes.length ? hashes : undefined;
}

function piCursorImageId(value: unknown): string | undefined {
	const data =
		value instanceof Uint8Array
			? value
			: value instanceof ArrayBuffer
				? new Uint8Array(value)
				: typeof value === "string"
					? value
					: undefined;
	if (data === undefined) return undefined;
	return createHash("sha256").update(data).digest("hex");
}

function piCursorActionFields(
	payload: PiCursorPayload,
): Record<string, unknown> | undefined {
	const wrapper = piObject(payload.action);
	const action = piObject(wrapper?.action) ?? wrapper;
	if (!action) return undefined;
	if (action.case !== "userMessageAction")
		return {
			case: typeof action.case === "string" ? action.case : undefined,
		};
	const user = piObject(piObject(action.value)?.userMessage);
	if (!user) return { case: "userMessageAction" };
	const images: Array<{ mimeType?: string; data?: string }> = [];
	const selected = piObject(user.selectedContext)?.selectedImages;
	if (Array.isArray(selected)) {
		for (const value of selected) {
			const image = piObject(value);
			if (!image) continue;
			const blob = piObject(image.dataOrBlobId);
			const data =
				blob?.case === "data" || blob?.case === "blobId"
					? blob.value
					: image.dataOrBlobId;
			const id = piCursorImageId(data);
			const mimeType =
				typeof image.mimeType === "string" ? image.mimeType : undefined;
			if (mimeType || id)
				images.push({
					...(mimeType ? { mimeType } : {}),
					...(id ? { data: id } : {}),
				});
		}
	}
	return {
		case: "userMessageAction",
		text: typeof user.text === "string" ? user.text : "",
		...(images.length ? { images } : {}),
	};
}

function piCursorConversation(
	payload: PiCursorPayload,
): Record<string, unknown> | undefined {
	const ids =
		payload.conversationState.rootPromptMessagesJson.map(piCursorBlobId);
	if (ids.some((id) => id === undefined)) return undefined;
	return {
		rootPromptMessagesJson: ids,
		action: piCursorActionFields(payload),
	};
}

/** Compare typed conversation fields, allowing only Anthropic cache-only representations. */
export function piConversationFields(
	payload: unknown,
): readonly LkgContentField[] | undefined {
	try {
		if (!payload || typeof payload !== "object") return undefined;
		const body = payload as Record<string, unknown>;
		const cursor = piCursorPayload(payload);
		let conversation: Record<string, unknown>;
		let anthropic = false;
		if (Array.isArray(body.messages) && body.input === undefined) {
			conversation = { messages: body.messages, system: body.system };
			anthropic = typeof body.system === "string" || Array.isArray(body.system);
		} else if (
			(Array.isArray(body.input) || typeof body.input === "string") &&
			body.messages === undefined
		) {
			conversation = {
				input: body.input,
				instructions: body.instructions,
				previous_response_id: body.previous_response_id,
				conversation: body.conversation,
				prompt: body.prompt,
			};
		} else if (cursor) {
			const cursorConversation = piCursorConversation(cursor);
			if (!cursorConversation) return undefined;
			conversation = cursorConversation;
		} else {
			const google = piGoogleConversation(payload);
			if (!google) return undefined;
			// Google/Vertex plans put instructions in config; Cloud Code Assist
			// puts them beside contents inside request. Retain both locations so
			// changing instructions on a retry cannot borrow the first receipt.
			conversation = {
				contents: google.contents,
				systemInstruction: google.systemInstruction,
				configSystemInstruction: (
					google.config as { systemInstruction?: unknown } | undefined
				)?.systemInstruction,
			};
		}

		const fields: LkgContentField[] = [];
		const seen = new WeakSet<object>();
		let nodes = 0;
		let strings = 0;
		const visit = (value: unknown, position: Position, depth: number): void => {
			if (++nodes > MAX_NODES || depth > MAX_DEPTH)
				throw new Error("conversation structure limit");
			if (typeof value === "string") {
				strings += value.length;
				if (strings > MAX_STRING_UNITS)
					throw new Error("conversation string limit");
				fields.push(LKG_SNAPSHOT_STRING, value);
			} else if (value === null) fields.push(LKG_SNAPSHOT_NULL);
			else if (typeof value === "number")
				fields.push(LKG_SNAPSHOT_NUMBER, value);
			else if (typeof value === "boolean")
				fields.push(LKG_SNAPSHOT_BOOLEAN, value);
			else if (!value || typeof value !== "object")
				fields.push(LKG_SNAPSHOT_UNDEFINED);
			else {
				if (seen.has(value)) throw new Error("cyclic conversation");
				seen.add(value);
				if (Array.isArray(value)) {
					// Only a transport text block with no other meaningful fields is
					// equivalent to string content. Reasoning and metadata stay distinct.
					if (
						anthropic &&
						(position === "content" || position === "system") &&
						value.length === 1
					) {
						const block = value[0];
						if (
							block &&
							typeof block === "object" &&
							block.type === "text" &&
							typeof block.text === "string" &&
							Object.keys(block).every(
								(key) =>
									key === "type" || key === "text" || key === "cache_control",
							)
						) {
							visit(block.text, "other", depth + 1);
							seen.delete(value);
							return;
						}
					}
					fields.push(LKG_SNAPSHOT_ARRAY, value.length);
					for (const item of value)
						visit(
							item,
							position === "messages"
								? "message"
								: anthropic && (position === "content" || position === "system")
									? "block"
									: "other",
							depth + 1,
						);
				} else {
					const entries = Object.entries(value).filter(
						([key, child]) =>
							child !== undefined &&
							typeof child !== "function" &&
							typeof child !== "symbol" &&
							!(anthropic && position === "block" && key === "cache_control"),
					);
					for (const [key] of entries) strings += key.length;
					if (strings > MAX_STRING_UNITS)
						throw new Error("conversation key limit");
					entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
					fields.push(LKG_SNAPSHOT_OBJECT, entries.length);
					for (const [key, child] of entries) {
						fields.push(LKG_SNAPSHOT_KEY, key);
						visit(
							child,
							position === "root" && key === "messages"
								? "messages"
								: position === "root" && key === "system"
									? "system"
									: position === "message" && key === "content"
										? "content"
										: "other",
							depth + 1,
						);
					}
				}
				seen.delete(value);
			}
		};
		visit(conversation, "root", 0);
		return fields;
	} catch {
		return undefined;
	}
}

/** A bounded, transform-stable prefix taken from the actual managed output. */
export function piManagedSignature(
	messages: readonly unknown[],
): string | undefined {
	for (const message of messages.slice(0, 8)) {
		if (!message || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.find(
							(part) => part?.type === "text" && typeof part.text === "string",
						)?.text
					: undefined;
		if (!text) continue;
		// Magic Context's injected section openers and §N§ message-number prefixes
		// contain no secrets. Matching only the opener survives Oh My Pi redacting
		// docs, profile, or memory text. Host wrappers such as <system-reminder>
		// also occur on raw requests, so they cannot identify prepared context.
		const marker =
			/^(<project-docs>|<user-profile>|<covered-system-messages>|<session-history>|<project-memory>|<memory-mural>|<session-history-since>|<knowledge-updates>|<memory>|§\d+§)/.exec(
				text,
			)?.[0];
		return marker ?? text.slice(0, 128);
	}
	return undefined;
}

/** Inspect bounded message text fields; never stringify or scan a whole body. */
export function piHasManagedSignature(
	payload: unknown,
	signature: string | undefined,
	cursorReceipt?: readonly string[],
): boolean {
	if (!signature || !payload || typeof payload !== "object") return false;
	const cursor = piCursorPayload(payload);
	if (cursor) {
		for (const entry of cursor.conversationState.rootPromptMessagesJson.slice(
			0,
			8,
		)) {
			const text = piCursorJsonText(entry);
			if (text?.slice(0, 4096).includes(signature)) return true;
		}
		if (!Array.isArray(cursorReceipt) || cursorReceipt.length === 0)
			return false;
		const ids = new Set(
			cursor.conversationState.rootPromptMessagesJson.map(piCursorBlobId),
		);
		return cursorReceipt.some((id) => ids.has(id));
	}
	const body = payload as {
		messages?: unknown;
		input?: unknown;
		inferenceConfig?: unknown;
	};
	const google = piGoogleConversation(payload);
	const nativeText = !!google || body.inferenceConfig !== undefined;
	if (typeof body.input === "string" && body.messages === undefined)
		return body.input.slice(0, 4096).includes(signature);
	const messages = Array.isArray(body.messages)
		? body.messages
		: Array.isArray(body.input)
			? body.input
			: (google?.contents as unknown[] | undefined);
	if (!messages) return false;
	for (const message of messages.slice(0, 8)) {
		if (!message || typeof message !== "object") continue;
		const content = google
			? (message as { parts?: unknown }).parts
			: (message as { content?: unknown }).content;
		if (
			typeof content === "string" &&
			content.slice(0, 4096).includes(signature)
		)
			return true;
		if (!Array.isArray(content)) continue;
		// Oh My Pi's PNG prompt compactor can prepend six frames and notes, followed by the
		// date/cwd reminder, ahead of the original managed text block.
		for (const block of content.slice(0, 32)) {
			if (
				block &&
				(["text", "input_text", "output_text"].includes(block.type) ||
					(nativeText && block.type === undefined)) &&
				typeof block.text === "string" &&
				block.text.slice(0, 4096).includes(signature)
			)
				return true;
		}
	}
	return false;
}

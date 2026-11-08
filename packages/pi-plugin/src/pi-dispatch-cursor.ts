import { createHash } from "node:crypto";
import { piOmpUserHistory } from "./pi-dispatch-omp-user";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Cursor's request hook receives blob IDs, not the private blob store. */
export function piCursorConversation(payload: unknown):
	| {
			conversation: Record<string, unknown>;
			messages: unknown[];
			rootIds: string[];
			activeText?: string;
	  }
	| undefined {
	const body = object(payload);
	if (
		body?.messages !== undefined ||
		body?.input !== undefined ||
		body?.contents !== undefined ||
		body?.request !== undefined
	)
		return undefined;
	const state = object(body?.conversationState);
	if (
		!state ||
		!Array.isArray(state.rootPromptMessagesJson) ||
		!Array.isArray(state.turns)
	)
		return undefined;
	let bytes = 0;
	let nodes = 0;
	const messages: unknown[] = [];
	const rootIds: string[] = [];
	const decode = (value: unknown, depth = 0): unknown => {
		if (++nodes > MAX_ENTRIES || depth > 128)
			throw new Error("Cursor structure limit");
		if (value instanceof Uint8Array) {
			bytes += value.byteLength;
			if (bytes > MAX_BYTES) throw new Error("Cursor bytes limit");
			// Current OMP stores SHA-256 IDs. Inline JSON bytes can be decoded
			// without pretending an opaque ID is UTF-8 history.
			if (value.byteLength === 32)
				return { blobId: Buffer.from(value).toString("hex") };
			return JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(value),
			);
		}
		if (Array.isArray(value))
			return value.map((entry) => decode(entry, depth + 1));
		const record = object(value);
		if (record)
			return Object.fromEntries(
				Object.entries(record).map(([key, child]) => [
					key,
					decode(child, depth + 1),
				]),
			);
		return value;
	};
	try {
		const decoded = decode(state) as Record<string, unknown>;
		for (const root of decoded.rootPromptMessagesJson as unknown[]) {
			const record = object(root);
			if (typeof record?.blobId === "string") rootIds.push(record.blobId);
			else if (record && typeof record.role === "string") messages.push(record);
			else return undefined;
		}
		for (const value of (decoded.turns as unknown[]).slice(0, 8)) {
			const turn = object(value);
			const agent = object(object(turn?.turn)?.value) ?? turn;
			const user = object(agent?.userMessage);
			if (typeof user?.text === "string")
				messages.push({ role: "user", content: user.text });
		}
		const action = object(object(body?.action)?.action);
		if (
			!action ||
			!["userMessageAction", "resumeAction"].includes(String(action.case))
		)
			return undefined;
		let active = decode(body?.action);
		let activeText: string | undefined;
		if (action.case === "userMessageAction") {
			const user = object(object(action.value)?.userMessage);
			if (!user || typeof user.text !== "string") return undefined;
			messages.push({ role: "user", content: user.text });
			activeText = user.text;
			// OMP creates a new UUID on each build, even for a transport retry.
			const { messageId: _messageId, ...content } = user;
			active = decode({
				action: {
					case: action.case,
					value: { ...object(action.value), userMessage: content },
				},
			});
		}
		return {
			conversation: {
				conversationState: decoded,
				action: active,
				customSystemPrompt: body?.customSystemPrompt,
			},
			messages,
			rootIds,
			activeText,
		};
	} catch {
		return undefined;
	}
}

/** Hash only prepared managed roots, off the synchronous dispatch stack. */
export function piCursorManagedRoots(
	messages: readonly unknown[],
	signature: string | undefined,
	cwd?: string,
): readonly string[] {
	if (!signature) return [];
	const roots = new Set<string>();
	const date = new Date();
	const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	const reminder =
		cwd &&
		`<system-reminder>\nToday: ${day}; current working directory: '${cwd.replace(/\\/gu, "/")}'. Do not repeat this information in your reply.\n</system-reminder>`;
	for (const value of messages.slice(0, 8)) {
		const source = object(value);
		if (!source || !["user", "developer"].includes(String(source.role)))
			continue;
		const message = piOmpUserHistory(source);
		const raw =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
		if (!Array.isArray(raw)) continue;
		const parts: unknown[] = [];
		let managed = false;
		for (const part of raw) {
			if (part?.type === "text" && typeof part.text === "string") {
				const text = part.text.trim();
				managed ||= text.slice(0, 4096).includes(signature);
				if (text) parts.push({ type: "text", text });
			} else if (part?.type === "image" && typeof part.data === "string") {
				parts.push({
					type: "image",
					image: `data:${part.mimeType};base64,${part.data}`,
					mediaType: part.mimeType,
				});
			}
		}
		if (!managed) continue;
		const hash = (content: unknown[]) => {
			const json = JSON.stringify({ role: "user", content });
			if (json.length <= MAX_BYTES)
				roots.add(createHash("sha256").update(json).digest("hex"));
		};
		hash(parts);
		if (reminder) {
			if (typeof message.content === "string")
				hash([
					{ type: "text", text: `${reminder}\n\n${message.content}`.trim() },
				]);
			else hash([{ type: "text", text: reminder }, ...parts]);
		}
	}
	return [...roots];
}

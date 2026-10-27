import { piOmpUserHistory } from "./pi-dispatch-omp-user";

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const DEVELOPER_ORIGIN = Symbol("custom developer history");

/** Preserve custom messages' developer origin even when their wire role is user. */
export function piIsDeveloperHistory(
	message: Record<string, unknown>,
): boolean {
	return (
		message.role === "developer" ||
		Reflect.get(message, DEVELOPER_ORIGIN) === true
	);
}

/** Map Oh My Pi custom messages and compaction summaries to their outgoing row shapes. */
export function piAgentHistory(
	messages: readonly unknown[],
	api?: string,
): unknown[] {
	return messages.flatMap((value): unknown[] => {
		const message = object(value);
		if (!message) return [value];
		if (message.role === "user") return [piOmpUserHistory(message)];
		if (message.role === "compactionSummary") {
			// With blocks, OMP sends the summary literally; without blocks it renders a
			// nonempty context envelope even for an empty summary. Only row shape is
			// needed here, not the envelope's text. preparePiDispatch removes the cached
			// Responses payload from the outgoing summary so it cannot replace readable
			// history with provider-owned compaction items.
			return [
				{
					...message,
					role: "user",
					content:
						message.blocks !== undefined
							? [
									{ type: "text", text: message.summary },
									...(Array.isArray(message.blocks) ? message.blocks : []),
								]
							: [
									{ type: "text", text: "Compaction context envelope" },
									...(Array.isArray(message.images) ? message.images : []),
								],
				},
			];
		}
		if (message.role !== "custom" && message.role !== "hookMessage")
			return [value];
		// display is a UI flag, not a context filter. OMP drops only invalid content
		// here; empty content can still be omitted later by a provider serializer.
		if (typeof message.content !== "string" && !Array.isArray(message.content))
			return [];
		const content =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
		const userInvoked =
			message.role === "custom" && message.attribution === "user";
		if (userInvoked && message.customType === "collab-prompt") {
			const text = content
				.filter((part) => object(part)?.type === "text")
				.map((part) => object(part)?.text)
				.join("\n");
			return [
				{
					...message,
					role: "user",
					content: [
						{
							type: "text",
							text: text.length ? "User interjection envelope" : "",
						},
						...content.filter((part) => object(part)?.type === "image"),
					],
				},
			];
		}
		if (userInvoked && message.customType === "skill-prompt")
			return [{ ...message, role: "user", content }];
		const images = content.filter((part) => object(part)?.type === "image");
		// Most provider serializers encode developer arrays as user conversation
		// rows. Ollama instead sends developer content not attributed to the user
		// as system instructions.
		const developerRole =
			api === "ollama-chat" && message.attribution !== "user"
				? "developer"
				: "user";
		if (!images.length)
			return [
				{ ...message, role: developerRole, content, [DEVELOPER_ORIGIN]: true },
			];
		const texts = content.filter((part) => object(part)?.type === "text");
		return [
			...(texts.length
				? [
						{
							...message,
							role: developerRole,
							content: texts,
							[DEVELOPER_ORIGIN]: true,
						},
					]
				: []),
			{
				...message,
				role: "user",
				content: [
					{ type: "text", text: `Images attached to ${message.customType}.` },
					...images,
				],
			},
		];
	});
}

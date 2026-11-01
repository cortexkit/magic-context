import type { RecoveryAttachments } from "@magic-context/core/tools/ctx-expand/render";

/** Recover image metadata without changing the text-only parts produced by synthesizeUserParts. */
export function piRecoveryAttachments(
	entries: readonly unknown[],
): RecoveryAttachments {
	return (_sessionId, messageId) => {
		const entry = entries.find(
			(entry) =>
				entry !== null &&
				typeof entry === "object" &&
				(entry as { id?: unknown }).id === messageId,
		) as { message?: { role?: string; content?: unknown } } | undefined;
		if (
			entry?.message?.role !== "user" ||
			!Array.isArray(entry.message.content)
		)
			return [];
		return entry.message.content.flatMap((part, partIndex) => {
			if (!part || (part.type !== "image" && part.type !== "file")) return [];
			return [
				{
					type: part.type,
					filename: part.filename ?? part.name,
					mime: part.mimeType ?? part.mime,
					url: [
						part.url,
						part.source?.uri,
						part.source?.url,
						part.providerFile?.uri,
					].find(
						(value) =>
							typeof value === "string" &&
							value.trim() &&
							!/^(data|blob):/i.test(value.trim()),
					),
					path: part.path ?? part.source?.path,
					partIndex,
				},
			];
		});
	};
}

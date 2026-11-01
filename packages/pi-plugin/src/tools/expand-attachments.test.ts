import { expect, test } from "bun:test";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { convertEntriesToRawMessages } from "../read-session-pi";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxExpandTool } from "./ctx-expand";
import { piRecoveryAttachments } from "./expand-attachments";

test("OMP provider URI is retained without reading inline image data", () => {
	const attachment = {
		type: "image",
		mimeType: "image/png",
		url: "data:image/png;base64,inline-bytes",
		providerFile: { provider: "google", uri: "gs://attachments/capture.png" },
		get data(): string {
			throw new Error("Recovery metadata must not read image bytes");
		},
	};
	expect(
		piRecoveryAttachments([
			{
				id: "image",
				message: { role: "user", content: [attachment] },
			},
		])("session", "image"),
	).toEqual([
		{
			type: "image",
			filename: undefined,
			mime: "image/png",
			url: "gs://attachments/capture.png",
			path: undefined,
			partIndex: 0,
		},
	]);
});

for (const storedLocation of [false, true]) {
	for (const mode of ["tag", "message", "range"] as const) {
		test(`${mode}: Pi/OMP ${storedLocation ? "located" : "inline"} image reports unrecovered content`, async () => {
			const sessionId = "pi-expand-image";
			const db = createTestDb();
			const image = {
				type: "image",
				data: "secret-inline-bytes",
				mimeType: "image/png",
				...(storedLocation
					? { filename: "capture.png", url: "file:///work/capture.png" }
					: {}),
			};
			const entry = {
				type: "message",
				id: "image-entry",
				message: {
					role: "user",
					content: [image, { type: "text", text: "Inspect it." }],
					timestamp: 1,
				},
			};
			const entries = [entry];
			const textOnly = [
				{
					...entry,
					message: {
						...entry.message,
						content: [{ type: "text", text: "Inspect it." }],
					},
				},
			];
			const sharedBefore = JSON.stringify(convertEntriesToRawMessages(entries));
			expect(sharedBefore).toBe(
				JSON.stringify(convertEntriesToRawMessages(textOnly)),
			);
			const ctx = fakeContext(sessionId);
			ctx.sessionManager.getBranch = () => entries as never;
			try {
				insertTag(db, sessionId, "image-entry:file0", "file", 10, 1);
				const args =
					mode === "tag"
						? { tag: 1 }
						: mode === "message"
							? { message: 1 }
							: { start: 1, end: 1, verbose: true };
				const output = await createCtxExpandTool({ db }).execute(
					"expand",
					args,
					undefined,
					undefined,
					ctx as never,
				);
				const text = (output.content[0] as { text: string }).text;
				expect(text).toContain(
					storedLocation
						? "[file] capture.png (image/png) — stored location: file:///work/capture.png; content not recovered. If needed, ask the user to attach it again."
						: "[file] (image/png); content not recovered. If needed, ask the user to attach it again.",
				);
				expect(text).not.toContain("secret-inline-bytes");
				expect(
					JSON.stringify(
						piRecoveryAttachments(entries)(sessionId, "image-entry"),
					),
				).not.toContain("secret-inline-bytes");
				expect(JSON.stringify(convertEntriesToRawMessages(entries))).toBe(
					sharedBefore,
				);
			} finally {
				db.close();
			}
		});
	}
}

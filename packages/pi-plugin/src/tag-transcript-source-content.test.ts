/**
 * Regression test for source_contents persistence in tagTranscript.
 *
 * Caveman text compression and other "compress from original" heuristics
 * read pristine source text from the source_contents table. Before this
 * fix, the harness-agnostic tagTranscript only persisted tag metadata
 * (in the tags table) but not the actual original text content. As a
 * result, applyCavemanCleanup would find zero compressible content and
 * leave caveman_depth=0 for every tag forever.
 *
 * This test locks in that tagTranscript writes original (pre-§N§-prefix)
 * text to source_contents for text parts. It does NOT assert behavior
 * for tool parts because tool result text has provider-specific format
 * (truncation markers, line counts) that wouldn't compose cleanly with
 * caveman compression — caveman is text-only.
 */
import { describe, expect, it } from "bun:test";
import { getSourceContents } from "@magic-context/core/features/magic-context/storage-source";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { assistantMessage, createTestDb, userMessage } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

describe("tagTranscript source_contents persistence", () => {
	it("persists original text content for text parts so caveman has source to compress from", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-source-contents";
			const messages = [
				userMessage("Original user prompt about distributed systems", 1),
				assistantMessage(
					"Here is a long assistant explanation that should be persisted as source content.",
					2,
				),
				userMessage("Follow up question with specific details", 3),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			// Each text part should have produced a tag — we expect 3 tags
			// (1 per text message: user, assistant, user).
			expect(targets.size).toBe(3);

			// Read source_contents for all assigned tag numbers.
			const tagNumbers = Array.from(targets.keys());
			const persisted = getSourceContents(db, sessionId, tagNumbers);

			// All three tags should have source_contents persisted.
			expect(persisted.size).toBe(3);

			// The persisted content should be the ORIGINAL text — not the
			// §N§-prefixed version that the agent sees. Caveman compresses
			// from this pristine source on age-tier passes.
			const allContent = Array.from(persisted.values());
			expect(allContent).toContain(
				"Original user prompt about distributed systems",
			);
			expect(allContent).toContain(
				"Here is a long assistant explanation that should be persisted as source content.",
			);
			expect(allContent).toContain("Follow up question with specific details");

			// Verify no §N§ prefix leaked into source_contents.
			for (const content of allContent) {
				expect((content as string).startsWith("\u00a7")).toBe(false);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("strips any pre-existing §N§ prefix before persisting source content", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-prefix-strip";
			// Simulate a message whose text already starts with a tag prefix
			// (e.g., it was previously tagged but persistent state was lost
			// and the in-memory text got re-tagged from the prefixed form).
			// The persisted source MUST be the stripped form so caveman
			// compression operates on real content, not the marker.
			const messages = [
				userMessage("\u00a742\u00a7 stale prefix from earlier tagging", 1),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			expect(targets.size).toBe(1);
			const tagNumbers = Array.from(targets.keys());
			const persisted = getSourceContents(db, sessionId, tagNumbers);

			// Source content stored should have the prefix stripped.
			const contentValues = Array.from(persisted.values());
			expect(contentValues.length).toBe(1);
			expect(contentValues[0]).toBe("stale prefix from earlier tagging");
		} finally {
			closeQuietly(db);
		}
	});

	it("uses INSERT OR IGNORE — first-write-wins on repeated tag passes", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-idempotent";
			const messages = [userMessage("original message", 1)];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);

			// First pass: tag the original.
			const transcript1 = createPiTranscript(messages, sessionId);
			tagTranscript(sessionId, transcript1, tagger, db);

			// Second pass: messages now appear with §N§ prefix (this is
			// what would happen on a re-tag of an already-prefixed message).
			// saveSourceContent uses INSERT OR IGNORE so the original from
			// pass 1 is preserved.
			const messages2 = [userMessage("\u00a71\u00a7 original message", 2)];
			const transcript2 = createPiTranscript(messages2, sessionId);
			tagTranscript(sessionId, transcript2, tagger, db);

			// The persisted source should still be the very first stripped
			// form, not overwritten.
			const persisted = getSourceContents(db, sessionId, [1]);
			expect(persisted.get(1)).toBe("original message");
		} finally {
			closeQuietly(db);
		}
	});
});

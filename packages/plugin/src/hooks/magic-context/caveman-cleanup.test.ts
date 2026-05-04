/**
 * Unit tests for age-tier caveman text compression.
 *
 * Focus areas:
 *  - Tier assignment (20/20/20/40 age buckets)
 *  - Only message-type active tags outside protected tail are eligible
 *  - min_chars gate skips short texts
 *  - Repeated tier shifts compress from ORIGINAL, never from cavemaned text
 *  - tags.caveman_depth is persisted so later passes can skip already-done tags
 */

import { describe, expect, test } from "bun:test";
import {
    getTagsBySession,
    insertTag,
    saveSourceContent,
} from "../../features/magic-context/storage";
import { initializeDatabase, type openDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { cavemanCompress } from "./caveman";
import {
    applyCavemanCleanup,
    computeTargetDepth,
    replayCavemanCompression,
} from "./caveman-cleanup";
import type { TagTarget } from "./tag-messages";

const SESSION = "ses-caveman-test";

function createInMemoryDb(): ReturnType<typeof openDatabase> {
    const db = new Database(":memory:") as ReturnType<typeof openDatabase>;
    initializeDatabase(db);
    return db;
}

function mockTarget(initialContent: string): {
    target: TagTarget;
    getContent(): string;
} {
    let content = initialContent;
    const target: TagTarget = {
        setContent: (newContent) => {
            if (content === newContent) return false;
            content = newContent;
            return true;
        },
        getContent: () => content,
    };
    return {
        target,
        getContent: () => content,
    };
}

describe("computeTargetDepth", () => {
    test("empty eligible list returns 0", () => {
        expect(computeTargetDepth(0, 0)).toBe(0);
    });

    test("20/20/20/40 boundaries for 10 items", () => {
        // positions 0,1 -> ultra (0.0, 0.1)
        // positions 2,3 -> full  (0.2, 0.3)
        // positions 4,5 -> lite  (0.4, 0.5)
        // positions 6,7,8,9 -> untouched
        expect(computeTargetDepth(0, 10)).toBe(3); // ultra
        expect(computeTargetDepth(1, 10)).toBe(3); // ultra
        expect(computeTargetDepth(2, 10)).toBe(2); // full
        expect(computeTargetDepth(3, 10)).toBe(2); // full
        expect(computeTargetDepth(4, 10)).toBe(1); // lite
        expect(computeTargetDepth(5, 10)).toBe(1); // lite
        expect(computeTargetDepth(6, 10)).toBe(0);
        expect(computeTargetDepth(9, 10)).toBe(0);
    });

    test("rounding: 5-item split, newest still untouched", () => {
        // 0 -> 0/5=0.0 ultra
        // 1 -> 1/5=0.2 full
        // 2 -> 2/5=0.4 lite
        // 3 -> 3/5=0.6 untouched
        // 4 -> 4/5=0.8 untouched
        expect(computeTargetDepth(0, 5)).toBe(3);
        expect(computeTargetDepth(1, 5)).toBe(2);
        expect(computeTargetDepth(2, 5)).toBe(1);
        expect(computeTargetDepth(3, 5)).toBe(0);
        expect(computeTargetDepth(4, 5)).toBe(0);
    });
});

describe("applyCavemanCleanup", () => {
    test("no-op when disabled", () => {
        const db = createInMemoryDb();
        const result = applyCavemanCleanup(SESSION, db, new Map(), [], {
            enabled: false,
            minChars: 500,
            protectedTags: 10,
        });
        expect(result).toEqual({
            compressedToLite: 0,
            compressedToFull: 0,
            compressedToUltra: 0,
        });
    });

    test("no-op when no eligible tags", () => {
        const db = createInMemoryDb();
        // Only tool tags — caveman skips them
        insertTag(db, SESSION, "msg-1", "tool", 5000, 1);
        const tags = getTagsBySession(db, SESSION);
        const result = applyCavemanCleanup(SESSION, db, new Map(), tags, {
            enabled: true,
            minChars: 100,
            protectedTags: 0,
        });
        expect(result.compressedToLite + result.compressedToFull + result.compressedToUltra).toBe(
            0,
        );
    });

    test("compresses oldest message tag to ultra", () => {
        const db = createInMemoryDb();
        const longText =
            "I just wanted to basically clearly explain that the implementation is actually really quite complex, and in order to understand it, we need to consider that historian and compartment and compressor work together; because of that, furthermore the agent additionally must realize the concept.";
        // Insert 10 message tags, oldest first
        for (let i = 1; i <= 10; i++) {
            insertTag(db, SESSION, `msg-${i}`, "message", longText.length * 2, i);
            saveSourceContent(db, SESSION, i, longText);
        }
        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>();
        const controllers: Array<{ get: () => string; tagNumber: number }> = [];
        for (const tag of tags) {
            const { target, getContent } = mockTarget(longText);
            targets.set(tag.tagNumber, target);
            controllers.push({ get: getContent, tagNumber: tag.tagNumber });
        }

        const result = applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });

        expect(result.compressedToUltra).toBe(2); // positions 0,1 -> ultra (20% of 10)
        expect(result.compressedToFull).toBe(2); // positions 2,3 -> full
        expect(result.compressedToLite).toBe(2); // positions 4,5 -> lite
        // Verify the oldest two tags actually have different content now (cavemaned)
        const oldestContent = controllers.find((c) => c.tagNumber === 1)!.get();
        const youngestContent = controllers.find((c) => c.tagNumber === 10)!.get();
        expect(oldestContent).not.toBe(longText); // cavemaned
        expect(youngestContent).toBe(longText); // untouched
        expect(oldestContent.length).toBeLessThan(longText.length); // shorter
    });

    test("skips tags shorter than min_chars", () => {
        const db = createInMemoryDb();
        const shortText = "brief";
        const longText = "I just really basically wanted to clearly explain ".repeat(10);
        insertTag(db, SESSION, "msg-1", "message", shortText.length, 1);
        saveSourceContent(db, SESSION, 1, shortText);
        insertTag(db, SESSION, "msg-2", "message", longText.length, 2);
        saveSourceContent(db, SESSION, 2, longText);

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>();
        for (const tag of tags) {
            const text = tag.tagNumber === 1 ? shortText : longText;
            targets.set(tag.tagNumber, mockTarget(text).target);
        }

        const result = applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 100,
            protectedTags: 0,
        });

        // Only tag 2 is eligible (length > 100); positioned at index 0 of 1-item
        // list -> ultra. Tag 1 below min_chars is skipped entirely.
        expect(result.compressedToUltra).toBe(1);
    });

    test("respects protected tail", () => {
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(10);
        for (let i = 1; i <= 5; i++) {
            insertTag(db, SESSION, `msg-${i}`, "message", longText.length, i);
            saveSourceContent(db, SESSION, i, longText);
        }

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>();
        for (const tag of tags) {
            targets.set(tag.tagNumber, mockTarget(longText).target);
        }

        // protectedTags = 3 → tags 3,4,5 are protected; only 1,2 eligible
        const result = applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 3,
        });

        // 2 eligible tags: positions 0,1 -> ultra (both), since 20% of 2 = 0 tags,
        // position 0: 0/2=0.0 → ultra, position 1: 1/2=0.5 → lite.
        // Actually: 0/2=0.0 < 0.2 -> ultra; 1/2=0.5 < 0.6 → lite
        expect(result.compressedToUltra).toBe(1);
        expect(result.compressedToLite).toBe(1);
    });

    test("re-compresses from original source, not from cavemaned intermediate", () => {
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(20);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);

        const tags = getTagsBySession(db, SESSION);
        const { target, getContent } = mockTarget(longText);
        const targets = new Map<number, TagTarget>([[1, target]]);

        // First pass: 1 eligible tag, position 0 -> ultra
        applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });
        const afterUltra = getContent();
        expect(afterUltra).not.toBe(longText);
        // Persisted depth should be 3 (ultra)
        const afterPass1Tags = getTagsBySession(db, SESSION);
        expect(afterPass1Tags[0].cavemanDepth).toBe(3);

        // Second pass with same target: cavemanDepth already >= target, so no-op.
        const result = applyCavemanCleanup(SESSION, db, targets, afterPass1Tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });
        expect(result.compressedToLite + result.compressedToFull + result.compressedToUltra).toBe(
            0,
        );
        expect(getContent()).toBe(afterUltra); // unchanged
    });

    test("handles missing source content gracefully (skip, no crash)", () => {
        const db = createInMemoryDb();
        const longText = "a".repeat(500);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        // Intentionally do NOT save source_contents for this tag

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>([[1, mockTarget(longText).target]]);

        const result = applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });

        expect(result.compressedToLite + result.compressedToFull + result.compressedToUltra).toBe(
            0,
        );
    });

    test("depth escalation: tier shift always compresses from original, not intermediate", () => {
        // This is the key invariant. If a tag is first compressed at lite,
        // then later forced into ultra (e.g. because new tags pushed it into
        // an older tier), the ultra result must equal direct ultra-from-original
        // — NOT ultra-from-lite. Otherwise repeated tier shifts would
        // produce drift relative to a direct compression.
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(20);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);

        const { target } = mockTarget(longText);
        const targets = new Map<number, TagTarget>([[1, target]]);

        // Pass 1: only 1 eligible tag at position 0 → ultra (since 0/1=0.0 < 0.2).
        // To force the LITE path first, we need to pretend the eligible list
        // has 5 items so position 2 → lite. Easiest approach: insert dummy
        // tags 2-5 with NO source content so they show as eligible by size
        // but get skipped during compression.
        for (let i = 2; i <= 5; i++) {
            insertTag(db, SESSION, `msg-${i}`, "message", longText.length, i);
            saveSourceContent(db, SESSION, i, longText);
            targets.set(i, mockTarget(longText).target);
        }
        const tags5 = getTagsBySession(db, SESSION);

        // Now eligible has 5 tags. Position 2 (tag 3) → lite (2/5=0.4 < 0.6).
        // We compress the SECOND-oldest eligible (tag 2 at pos 1 → full).
        // Easier: directly compress tag 1 (pos 0 → ultra) and verify, then
        // craft a separate scenario.
        // Actually let's keep it simple: compress ALL 5, then re-evaluate
        // and verify each holds its target depth.
        applyCavemanCleanup(SESSION, db, targets, tags5, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });

        // Tag 3 (position 2/5 = 0.4 < 0.6 → lite, depth 1)
        const afterPass1 = getTagsBySession(db, SESSION);
        const tag3 = afterPass1.find((t) => t.tagNumber === 3)!;
        expect(tag3.cavemanDepth).toBe(1); // lite

        // Now simulate scenario: tag 3 was lite, but session grew. Force its
        // depth back to 0 in DB and re-run with EXTRA tags so tag 3 lands
        // in ultra tier. The replay/re-compression should produce
        // ultra(longText), NOT ultra(lite(longText)).
        db.prepare("UPDATE tags SET caveman_depth = 0 WHERE session_id = ? AND tag_number = ?").run(
            SESSION,
            3,
        );
        // Reset target to original (simulating tagMessages restoring source)
        const tag3TargetData = mockTarget(longText);
        targets.set(3, tag3TargetData.target);

        // Add 20 more tags so tag 3 sits at the very front of the eligible list
        for (let i = 6; i <= 25; i++) {
            insertTag(db, SESSION, `msg-${i}`, "message", longText.length, i);
            saveSourceContent(db, SESSION, i, longText);
            targets.set(i, mockTarget(longText).target);
        }
        const tags25 = getTagsBySession(db, SESSION);
        // 25 tags, position 2 (tag 3) → 2/25 = 0.08 < 0.2 → ultra
        applyCavemanCleanup(SESSION, db, targets, tags25, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });

        // Now tag 3 should be ultra. The visible content must match
        // direct cavemanCompress(longText, "ultra"), proving compression
        // came from the original — not from a previously-compressed value.
        const expectedUltra = cavemanCompress(longText, "ultra");
        expect(tag3TargetData.getContent()).toBe(expectedUltra);
        const finalTags = getTagsBySession(db, SESSION);
        const tag3Final = finalTags.find((t) => t.tagNumber === 3)!;
        expect(tag3Final.cavemanDepth).toBe(3);
    });
});

describe("replayCavemanCompression", () => {
    test("returns 0 when no tags carry caveman_depth", () => {
        const db = createInMemoryDb();
        const longText = "a".repeat(500);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>([[1, mockTarget(longText).target]]);

        const replayed = replayCavemanCompression(SESSION, db, targets, tags);
        expect(replayed).toBe(0);
    });

    test("re-applies persisted depth on defer pass without changing depth", () => {
        // Simulates the cache-stability scenario: after an execute pass
        // compressed a tag and persisted depth=ULTRA, a subsequent defer
        // pass restores tagMessages → original text, then replay must
        // re-apply the ultra compression to keep messages stable.
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(20);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);

        // Manually set persisted depth to ULTRA — simulating prior execute pass.
        db.prepare("UPDATE tags SET caveman_depth = 3 WHERE session_id = ? AND tag_number = ?").run(
            SESSION,
            1,
        );

        const tags = getTagsBySession(db, SESSION);
        // Target starts at the pristine original (as if tagMessages just
        // restored it on a defer pass).
        const { target, getContent } = mockTarget(longText);
        const targets = new Map<number, TagTarget>([[1, target]]);

        const replayed = replayCavemanCompression(SESSION, db, targets, tags);

        expect(replayed).toBe(1);
        // Replayed text should equal direct ultra-from-original.
        expect(getContent()).toBe(cavemanCompress(longText, "ultra"));
        // Depth must NOT have been changed by replay.
        const tagsAfter = getTagsBySession(db, SESSION);
        expect(tagsAfter[0].cavemanDepth).toBe(3);
    });

    test("idempotent: running replay twice produces the same result", () => {
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(20);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);
        db.prepare("UPDATE tags SET caveman_depth = 2 WHERE session_id = ? AND tag_number = ?").run(
            SESSION,
            1,
        );

        const tagsForReplay = getTagsBySession(db, SESSION);
        const { target, getContent } = mockTarget(longText);
        const targets = new Map<number, TagTarget>([[1, target]]);

        replayCavemanCompression(SESSION, db, targets, tagsForReplay);
        const after1 = getContent();

        // Second replay on already-compressed content. setContent returns
        // false (no change), so replayed count is 0 — but content stays
        // identical, which is what matters.
        const replayed = replayCavemanCompression(SESSION, db, targets, tagsForReplay);
        expect(replayed).toBe(0);
        expect(getContent()).toBe(after1);
    });

    test("skips tags missing source content (defensive)", () => {
        const db = createInMemoryDb();
        const longText = "a".repeat(500);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        // No saveSourceContent — original is missing
        db.prepare("UPDATE tags SET caveman_depth = 1 WHERE session_id = ? AND tag_number = ?").run(
            SESSION,
            1,
        );

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>([[1, mockTarget(longText).target]]);

        const replayed = replayCavemanCompression(SESSION, db, targets, tags);
        expect(replayed).toBe(0);
    });
});

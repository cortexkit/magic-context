/// <reference types="bun-types" />

/**
 * Issue 938 on real Pi and Oh My Pi hosts: a session that generates images.
 *
 * 1. Tool outputs that carry images are counted at the per-image token cost.
 *    They used to be counted at a few dozen tokens, so the protected tail
 *    covered every image output and queued drops on old images were refused as
 *    protected while the request kept carrying them.
 * 2. `/ctx-recomp` stages the native compaction marker for the history it
 *    rebuilt. A full recomp ends on the session's newest message, so it used to
 *    stage nothing; a marker still pending from an earlier summary (ending on a
 *    folded tool result) was then discarded and the host kept loading every
 *    summarized message.
 *
 * Run once per host: MC_E2E_HOST=pi and MC_E2E_HOST=omp. Set TMPDIR to a
 * throwaway root; every store the host opens lives under it.
 */

import { afterEach, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import { getProtectionWindowForSession } from "../../plugin/src/features/magic-context/protection-window";
import {
    getPendingPiCompactionMarkerState,
    setPendingPiCompactionMarkerState,
} from "../../plugin/src/features/magic-context/storage";
import { iterateEntriesToRawMessageRange } from "../../pi-plugin/src/read-session-pi";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import type { MockUsage } from "../src/mock-provider/server";
import { PiTestHarness } from "../src/pi-harness";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { processedImagePng } from "../src/processed-image-fixture";
import { forEachHost } from "../src/scenario-hosts";
import { createE2ETempDir } from "../src/temp-dir";
import { openTestDb } from "../src/test-db";

const PI_IMAGE_TOKENS = 1200;
const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

let harness: PiTestHarness | undefined;

afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
});

/** A Pi extension whose `generate_image` tool returns a caption and a PNG. */
function writeImageToolExtension(fixture: string, images: number): string {
    for (let index = 0; index < images; index += 1) {
        writeFileSync(join(fixture, `image-${index}.b64`), processedImagePng().toString("base64"));
    }
    const extension = join(fixture, "generate-image.mjs");
    writeFileSync(
        extension,
        `
import { readFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
    pi.registerTool({
        name: "generate_image",
        label: "Generate image",
        description: "Generate an image and return it",
        parameters: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
        async execute(_toolCallId, params) {
            const data = readFileSync(join(${JSON.stringify(fixture)}, "image-" + params.index + ".b64"), "utf8");
            return {
                content: [
                    { type: "text", text: "Generated image " + params.index },
                    { type: "image", data, mimeType: "image/png" },
                ],
                details: {},
            };
        },
    });
}
`,
    );
    return extension;
}

/**
 * The name a tool goes by on the wire. OMP prefixes tool names with an
 * underscore on Anthropic requests and maps the model's calls back.
 */
function wireToolName(body: Record<string, unknown>, name: string): string | undefined {
    if (!Array.isArray(body.tools)) return undefined;
    return body.tools
        .map((tool) => (tool as { name?: unknown }).name)
        .find((wire): wire is string => wire === name || wire === `_${name}`);
}

function isMainRequest(body: Record<string, unknown>): boolean {
    return (
        wireToolName(body, "generate_image") !== undefined &&
        !JSON.stringify(body.system ?? "").includes(HISTORIAN_SYSTEM_MARKER)
    );
}

function isHistorianRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes(HISTORIAN_SYSTEM_MARKER);
}

/** The base64 payload of every image block in a provider request. */
function wireImageData(value: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) wireImageData(item, found);
    } else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const source = record.source as { data?: unknown } | undefined;
        if (record.type === "image" && typeof source?.data === "string") found.add(source.data);
        else for (const item of Object.values(record)) wireImageData(item, found);
    }
    return found;
}

function countImages(value: unknown): number {
    if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countImages(item), 0);
    if (!value || typeof value !== "object") return 0;
    const record = value as Record<string, unknown>;
    if (record.type === "image") return 1;
    return Object.values(record).reduce((sum: number, item) => sum + countImages(item), 0);
}

function withoutImageData(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutImageData);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.type === "image") return { type: "image" };
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, withoutImageData(item)]));
}

/** What a provider would count: the text, plus each image at its per-image cost. */
function usageFor(body: Record<string, unknown>): MockUsage {
    const text = JSON.stringify(withoutImageData({ system: body.system, tools: body.tools, messages: body.messages }));
    return {
        input_tokens: Math.round(text.length / 4) + countImages(body.messages) * PI_IMAGE_TOKENS,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };
}

function toolUse(body: Record<string, unknown>, name: string, input: Record<string, unknown>, usage: MockUsage) {
    const wire = wireToolName(body, name);
    if (!wire) throw new Error(`the request offers no ${name} tool`);
    return {
        content: [{ type: "tool_use", id: `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, name: wire, input }],
        stop_reason: "tool_use" as const,
        usage,
    };
}

function hostVersion(host: "pi" | "omp"): string {
    return (JSON.parse(readFileSync(resolvePiHostInvocation(host).packageJson, "utf8")) as { version: string }).version;
}

interface ImageTagRow {
    tag_number: number;
    byte_size: number;
    token_count: number | null;
    status: string;
}

forEachHost(import.meta.url, "issue 938: image tool outputs and recomp markers", (host) => {
    if (host !== "pi" && host !== "omp") throw new Error(`unexpected host ${host}`);

    it("counts image tool outputs by image, so drops on old images land and leave the request", async () => {
        const fixture = createE2ETempDir("issue-938-images-");
        const images = 16;
        const extension = writeImageToolExtension(fixture, images);
        const h = await PiTestHarness.create({
            host,
            imageInput: true,
            modelContextLimit: 60_000,
            extensionsBeforeMagicContext: [extension],
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tokens: 6_000,
                historian: { disable: true },
                dreamer: { disable: true },
                compressor: { enabled: false },
            },
        });
        harness = h;

        type Step = (body: Record<string, unknown>, usage: MockUsage) => ReturnType<typeof toolUse>;
        let pending: Step[] = [];
        h.mock.addMatcher((body) => {
            if (!isMainRequest(body)) return null;
            const usage = usageFor(body);
            const next = pending.shift();
            return next ? next(body, usage) : { text: "Done.", usage };
        });
        const usageOfLastMain = () => {
            const main = h.mock.requests().filter((request) => isMainRequest(request.body));
            return { body: main.at(-1)!.body, usage: usageFor(main.at(-1)!.body) };
        };

        const sessionId = await h.createSession();
        // Four images per prompt: OMP's agent_end leaves the prompt out of a
        // long tool run, and the harness recognizes the turn's end by it.
        for (let batch = 0; batch < images / 4; batch += 1) {
            pending = Array.from({ length: 4 }, (_, offset): Step => (body, usage) =>
                toolUse(body, "generate_image", { index: batch * 4 + offset }, usage),
            );
            await h.sendPrompt(sessionId, `IMAGES_938: generate storyboard frames, batch ${batch + 1}`, {
                timeoutMs: 300_000,
            });
        }
        await h.waitForMockQuiescence({ label: "image turns" });

        const imageRows = () =>
            h
                .contextDb()
                .prepare(
                    "SELECT tag_number, byte_size, token_count, status FROM tags WHERE session_id = ? AND type = 'tool' AND tool_name = 'generate_image' ORDER BY tag_number",
                )
                .all(sessionId) as ImageTagRow[];
        const tagged = imageRows();
        expect(tagged).toHaveLength(images);
        // Each output counts its caption plus one image at the per-image cost:
        // never a caption-sized count, never its base64 length.
        for (const row of tagged) {
            expect(row.token_count ?? 0).toBeGreaterThanOrEqual(PI_IMAGE_TOKENS);
            expect(row.token_count ?? 0).toBeLessThan(PI_IMAGE_TOKENS + 50);
        }
        const wireBefore = wireImageData(usageOfLastMain().body.messages);
        const wireImagesBefore = countImages(usageOfLastMain().body.messages);
        const { usage: pressure } = usageOfLastMain();
        // Past the execute threshold on what the request really carries.
        expect(pressure.input_tokens / 60_000).toBeGreaterThan(0.25);

        // The protected tail now ends inside the image outputs instead of covering all of them.
        const window = getProtectionWindowForSession(h.contextDb() as never, sessionId);
        const protectedImages = tagged.filter((row) => window.protectedTagNumbers.has(row.tag_number));
        expect(protectedImages.length).toBeLessThan(images);
        expect(protectedImages.length).toBeGreaterThan(0);

        // The agent drops the eight oldest images.
        const oldest = tagged.slice(0, 8).map((row) => row.tag_number);
        expect(oldest.every((tag) => !window.protectedTagNumbers.has(tag))).toBe(true);
        pending = [(body, usage) => toolUse(body, "ctx_reduce", { drop: oldest.join(",") }, usage)];
        await h.sendPrompt(sessionId, "REDUCE_938: the first storyboard frames are final", { timeoutMs: 300_000 });
        await h.sendPrompt(sessionId, "AFTER_REDUCE_938: continue", { timeoutMs: 300_000 });
        await h.waitForMockQuiescence({ label: "after reduce" });

        const after = imageRows();
        expect(after.filter((row) => oldest.includes(row.tag_number)).map((row) => row.status)).toEqual(
            oldest.map(() => "dropped"),
        );
        expect(after.filter((row) => !oldest.includes(row.tag_number)).every((row) => row.status === "active")).toBe(
            true,
        );
        const wireAfter = wireImageData(usageOfLastMain().body.messages);
        const wireImagesAfter = countImages(usageOfLastMain().body.messages);
        // Tags follow generation order, so the eight oldest tags are images 0-7.
        const imageData = (index: number) => readFileSync(join(fixture, `image-${index}.b64`), "utf8");
        for (let index = 0; index < oldest.length; index += 1) {
            expect(wireAfter.has(imageData(index))).toBe(false);
        }
        if (host === "pi") {
            // Pi sends every image; the dropped ones are gone from the request now.
            expect(wireImagesBefore).toBe(images);
            expect(wireBefore.has(imageData(0))).toBe(true);
            expect(wireImagesAfter).toBe(images - oldest.length);
            for (let index = oldest.length; index < images; index += 1) {
                expect(wireAfter.has(imageData(index))).toBe(true);
            }
        }
        // OMP applies its own image budget and sends only the newest few images,
        // so there the dropped images were already off its request.

        console.log(
            `ISSUE938_IMAGES_PROOF ${JSON.stringify({
                host,
                version: hostVersion(host),
                pid: h.hostPid,
                tokenCounts: tagged.map((row) => row.token_count),
                byteSizes: tagged.map((row) => row.byte_size),
                protectionFloor: window.status.floor,
                protectedImageTags: protectedImages.map((row) => row.tag_number),
                droppedImageTags: oldest,
                requestTokensBefore: pressure.input_tokens,
                wireImagesBefore,
                wireImagesAfter,
                root: h.env.baseDir,
            })}`,
        );
    }, 900_000);

    it("/ctx-recomp stages the marker for the rebuilt history, so the host stops loading summarized messages", async () => {
        const fixture = createE2ETempDir("issue-938-recomp-");
        const extension = writeImageToolExtension(fixture, 2);
        const snapshotPath = join(fixture, "branch.json");
        const probe = join(fixture, "branch-probe.mjs");
        writeFileSync(
            probe,
            `
import { writeFileSync } from "node:fs";
export default function (pi) {
    pi.registerCommand("e2e-branch-snapshot", { description: "Capture the persisted branch", handler(_args, ctx) {
        writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify(ctx.sessionManager.getBranch()));
    }});
}
`,
        );
        const h = await PiTestHarness.create({
            host,
            imageInput: true,
            extensionsBeforeMagicContext: [extension, probe],
            magicContextConfig: {
                execute_threshold_percentage: 95,
                dreamer: { disable: true },
                compressor: { enabled: false },
            },
        });
        harness = h;

        let pending: Array<(body: Record<string, unknown>) => ReturnType<typeof toolUse>> = [];
        h.mock.addMatcher((body) => {
            if (!isHistorianRequest(body)) return null;
            const range = findHistorianOrdinalRange(body) ?? { start: 1, end: 1 };
            return {
                text: buildMockHistorianPayload({
                    start: range.start,
                    end: range.end,
                    title: "REBUILT_HISTORY_938",
                    body: "Generated two storyboard images on request.",
                }),
                usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
            };
        });
        h.mock.addMatcher((body) => {
            if (!isMainRequest(body)) return null;
            const next = pending.shift();
            return next ? next(body) : { text: "Done.", usage: usageFor(body) };
        });

        const sessionId = await h.createSession();
        const usage = { input_tokens: 1_000, output_tokens: 20 };
        pending = [(body) => toolUse(body, "generate_image", { index: 0 }, usage)];
        await h.sendPrompt(sessionId, "RAW_ONE_938: draw the first frame", { timeoutMs: 300_000 });
        pending = [(body) => toolUse(body, "generate_image", { index: 1 }, usage)];
        await h.sendPrompt(sessionId, "RAW_TWO_938: draw the second frame", { timeoutMs: 300_000 });
        await h.waitForMockQuiescence({ label: "raw turns" });

        const branch = async () => {
            await h.invokeExtensionCommand("e2e-branch-snapshot");
            return JSON.parse(readFileSync(snapshotPath, "utf8")) as Array<{ id: string; type: string }>;
        };
        const raw = [
            ...iterateEntriesToRawMessageRange(await branch(), 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        ];
        const folded = raw.find((message) => message.id.startsWith("synth-user-"));
        if (!folded) throw new Error(`no folded tool result in ${JSON.stringify(raw.map((m) => m.id))}`);
        const keptAfterFolded = raw.find((message) => message.ordinal > folded.ordinal && message.id.length > 0);
        if (!keptAfterFolded) throw new Error("no entry after the folded tool result");
        const lastOrdinal = raw.at(-1)!.ordinal;

        // An earlier historian run summarized through the first folded tool
        // result; its marker is still pending when the person runs /ctx-recomp.
        const db = openTestDb(h.contextDbPath());
        try {
            appendCompartments(db as never, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: folded.ordinal,
                    startMessageId: raw[0]!.id,
                    endMessageId: folded.id,
                    title: "PRE_RECOMP_HISTORY_938",
                    content: "The first frame was generated.",
                },
            ]);
            setPendingPiCompactionMarkerState(db as never, sessionId, {
                firstKeptEntryId: keptAfterFolded.id,
                endMessageId: folded.id,
                ordinal: folded.ordinal,
                tokensBefore: 400,
                summary: "PRE_RECOMP_MARKER_938",
                publishedAt: Date.now(),
            });
        } finally {
            db.close();
        }
        h.closeContextDb();
        await h.restart();

        await h.invokeExtensionCommand("ctx-recomp");
        await h.invokeExtensionCommand("ctx-recomp");
        const rebuiltEnd = await h.waitFor(
            () => {
                const row = h
                    .contextDb()
                    .prepare(
                        "SELECT end_message, end_message_id, title FROM compartments WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
                    )
                    .get(sessionId) as { end_message: number; end_message_id: string; title: string } | null;
                return row?.title === "REBUILT_HISTORY_938" &&
                    getPendingPiCompactionMarkerState(h.contextDb() as never, sessionId)?.endMessageId ===
                        row.end_message_id
                    ? row
                    : null;
            },
            { timeoutMs: 120_000, label: "recomp publishes and stages its marker" },
        );
        // The full recomp ends on the newest message, so no kept entry exists yet.
        expect(rebuiltEnd.end_message).toBeGreaterThanOrEqual(lastOrdinal);
        expect(getPendingPiCompactionMarkerState(h.contextDb() as never, sessionId)).toMatchObject({
            endMessageId: rebuiltEnd.end_message_id,
            ordinal: rebuiltEnd.end_message,
            firstKeptEntryId: null,
        });

        await h.sendPrompt(sessionId, "AFTER_RECOMP_938: draw nothing, just answer", { timeoutMs: 300_000 });
        await h.waitForMockQuiescence({ label: "after recomp" });
        const mainBodies = () =>
            h
                .mock.requests()
                .filter((request) => isMainRequest(request.body))
                .map((request) => JSON.stringify(request.body.messages));
        // The rebuilt history cuts the request at once.
        const afterRecomp = mainBodies().at(-1)!;
        expect(afterRecomp).toContain("REBUILT_HISTORY_938");
        expect(afterRecomp).not.toContain("RAW_ONE_938");
        expect(afterRecomp).not.toContain("RAW_TWO_938");
        // The marker moves only with a rebuild that consumes the published
        // history (this first render after the restart is not one); it waits.
        expect(getPendingPiCompactionMarkerState(h.contextDb() as never, sessionId)).toMatchObject({
            endMessageId: rebuiltEnd.end_message_id,
        });

        await h.invokeExtensionCommand("ctx-flush");
        await h.sendPrompt(sessionId, "AFTER_FLUSH_938: one more answer", { timeoutMs: 300_000 });
        await h.waitForMockQuiescence({ label: "after flush" });
        expect(await h.hasNativeCompactionMarker(rebuiltEnd.end_message)).toBe(true);
        expect(getPendingPiCompactionMarkerState(h.contextDb() as never, sessionId)).toBeNull();
        expect(mainBodies().at(-1)).not.toContain("RAW_ONE_938");

        // Rebuilt from the journal, the host itself no longer loads the summarized messages.
        await h.restart();
        const hostMessages = JSON.stringify(await h.getMessages());
        expect(hostMessages).not.toContain("RAW_ONE_938");
        expect(hostMessages).not.toContain("RAW_TWO_938");
        expect(hostMessages).toContain("AFTER_RECOMP_938");
        await h.sendPrompt(sessionId, "AFTER_RESTART_938: still there?", { timeoutMs: 300_000 });
        await h.waitForMockQuiescence({ label: "after restart" });
        const afterRestart = mainBodies().at(-1)!;
        expect(afterRestart).toContain("REBUILT_HISTORY_938");
        expect(afterRestart).not.toContain("RAW_ONE_938");
        expect(afterRestart).not.toContain("PRE_RECOMP_MARKER_938");

        const marker = (await branch()).filter((entry) => entry.type === "compaction").at(-1);
        console.log(
            `ISSUE938_RECOMP_PROOF ${JSON.stringify({
                host,
                version: hostVersion(host),
                pid: h.hostPid,
                foldedBoundary: { id: folded.id, ordinal: folded.ordinal },
                rebuiltEnd,
                marker,
                hostMessageCount: (await h.getMessages()).length,
                root: h.env.baseDir,
            })}`,
        );
    }, 900_000);
});

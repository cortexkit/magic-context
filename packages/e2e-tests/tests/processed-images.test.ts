import { openTestDb } from "../src/test-db";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "../../plugin/src/shared/sqlite";
import { processedImagePng } from "../src/processed-image-fixture";
import { sessionMetaFieldSelect } from "../src/session-meta-fields";
import { MockProvider } from "../src/mock-provider/server";
import { createIsolatedEnv, PLUGIN_ENTRY, spawnOpencode } from "../src/opencode-runner/spawn";

test("issue 699 OpenCode 1 wire image bytes drop after an admitted positive-watermark rewrite and stay frozen", async () => {
    const mock = new MockProvider();
    const { baseURL } = await mock.start();
    mock.setDefault({ text: "Image inspected", usage: { input_tokens: 1000, output_tokens: 20 } });
    const env = createIsolatedEnv();
    const fixture = join(env.workdir, "ballast-plugin.ts");
    writeFileSync(
        fixture,
        `import { tool } from ${JSON.stringify(resolve(import.meta.dir, "../../plugin/node_modules/@opencode-ai/plugin/dist/tool.js"))}; export default async () => ({ tool: { ballast_probe: tool({ description: "Return protection-window ballast", args: { index: tool.schema.number() }, async execute() { return "context ".repeat(6000); } }) } });`,
    );
    const host = await spawnOpencode({
        existingEnv: env,
        openCodeConfigExtra: {
            plugin: [
                `file://${process.env.MC_E2E_PLUGIN_ENTRY ?? PLUGIN_ENTRY}`,
                `file://${fixture}`,
            ],
        },
        mockProviderURL: baseURL,
        mockProviderID: "openai",
        mockProviderAPI: "@ai-sdk/openai",
        mockModelID: "mock-image-model",
        magicContextConfig: {
            execute_threshold_percentage: 80,
            historian: { disable: true },
            dreamer: { disable: true },
            memory: { enabled: false },
            embedding: { provider: "off" },
            protected_tokens: 4000,
        },
    });
    const db = openTestDb(join(host.env.dataDir, "cortexkit", "magic-context", "context.db"), undefined, Database);
    db.exec("PRAGMA busy_timeout = 5000");
    try {
        const health = (await fetch(`${host.url}/global/health`).then((response) =>
            response.json(),
        )) as { version: string };
        expect(health.version).toMatch(/^1\./);
        const session = (await fetch(`${host.url}/session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Processed images fixture" }),
        }).then((response) => response.json())) as { id: string };
        const bytes = processedImagePng();
        const data = bytes.toString("base64");
        const path = join(host.env.workdir, "screenshot.png");
        writeFileSync(path, bytes);
        let issued = false;
        let aged = false;
        mock.addMatcher((body) => {
            if (!aged && JSON.stringify(body.input).includes("IMAGE-AGE-TOOLS")) {
                aged = true;
                return {
                    openaiOutput: Array.from({ length: 3 }, (_, i) => ({
                        type: "function_call",
                        id: `fc_ballast_${i}`,
                        call_id: `ballast_${i}`,
                        name: "ballast_probe",
                        arguments: JSON.stringify({ index: i }),
                    })),
                    usage: { input_tokens: 1000, output_tokens: 20 },
                };
            }
            if (issued || !JSON.stringify(body.input).includes("IMAGE-FIRST")) return null;
            issued = true;
            return {
                openaiOutput: [
                    {
                        type: "function_call",
                        id: "fc_read_image",
                        call_id: "read_image",
                        name: "read",
                        arguments: JSON.stringify({ filePath: path }),
                    },
                ],
                usage: { input_tokens: 1000, output_tokens: 20 },
            };
        });
        const turn = async (text: string, withImage = false) => {
            const before = mock.requests().length;
            const response = await fetch(`${host.url}/session/${session.id}/message`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: { providerID: "openai", modelID: "mock-image-model" },
                    parts: [
                        { type: "text", text },
                        ...(withImage
                            ? [
                                  {
                                      type: "file",
                                      mime: "image/png",
                                      url: `data:image/png;base64,${data}`,
                                  },
                              ]
                            : []),
                    ],
                }),
                signal: AbortSignal.timeout(60_000),
            });
            expect(response.ok).toBe(true);
            const answer = (await response.json()) as { info?: { error?: unknown } };
            expect(answer.info?.error).toBeUndefined();
            const requests = mock
                .requests()
                .slice(before)
                .filter(
                    (request) =>
                        request.body.model === "mock-image-model" &&
                        JSON.stringify(request.body.input).includes(text),
                );
            expect(requests.length).toBeGreaterThan(0);
            return requests.at(-1)!.body;
        };
        const imageData = (body: unknown): string[] => {
            const urls: string[] = [];
            const walk = (value: unknown) => {
                if (!value || typeof value !== "object") return;
                if (Array.isArray(value)) {
                    for (const item of value) walk(item);
                    return;
                }
                const row = value as Record<string, unknown>;
                if (row.type === "input_image" && typeof row.image_url === "string")
                    urls.push(row.image_url);
                else for (const item of Object.values(row)) walk(item);
            };
            walk(body);
            return urls;
        };
        const first = await turn("IMAGE-FIRST inspect the image and read screenshot.png", true);
        expect(issued).toBe(true);
        expect(imageData(first).length).toBe(2);
        const before = await turn(`IMAGE-DEFER-BEFORE ${"context ".repeat(5000)}`);
        expect(imageData(before)).toEqual(imageData(first));
        expect(
            JSON.stringify(
                db
                    .prepare(
                        `SELECT ${sessionMetaFieldSelect("processed_image_stripped_ids")} FROM session_meta WHERE session_id = ?`,
                    )
                    .get(session.id),
            ),
        ).not.toContain("textMarkerIds");
        await turn("IMAGE-AGE-TOOLS generate three tool outputs");
        expect(aged).toBe(true);
        await turn("IMAGE-DROP-TAG");
        // Drop an unrelated, answered text tag after both images. The image tags
        // stay active, so only the processed-image lane can remove their payloads.
        const tag = db
            .prepare(
                "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'message' ORDER BY tag_number DESC LIMIT 1",
            )
            .get(session.id) as { tag_number: number };
        expect(tag.tag_number).toBeGreaterThan(0);
        db.prepare(
            "UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?",
        ).run(session.id, tag.tag_number);
        db.prepare(
            "UPDATE session_meta SET cached_m0_system_hash = 'stale' WHERE session_id = ?",
        ).run(session.id);
        const rewritten = await turn("IMAGE-REWRITE");
        expect(imageData(rewritten)).toEqual([]);
        expect(JSON.stringify(rewritten)).toContain("[image stripped]");
        const frozen = db
            .prepare(
                `SELECT ${sessionMetaFieldSelect("processed_image_stripped_ids")} FROM session_meta WHERE session_id = ?`,
            )
            .get(session.id) as { processed_image_stripped_ids: string };
        expect(JSON.parse(frozen.processed_image_stripped_ids).ids).toHaveLength(2);
        const replay = await turn("IMAGE-DEFER-AFTER");
        expect(imageData(replay)).toEqual([]);
        const input = (body: unknown) => (body as { input: unknown[] }).input;
        expect(input(replay).slice(0, input(rewritten).length)).toEqual(input(rewritten));
        console.log(
            JSON.stringify({
                host: health.version,
                bun: Bun.version,
                watermark: tag.tag_number,
                imageCounts: [
                    imageData(first).length,
                    imageData(before).length,
                    imageData(rewritten).length,
                    imageData(replay).length,
                ],
                imageBytes: [first, before, rewritten, replay].map((body) =>
                    imageData(body).reduce((sum, url) => sum + url.length, 0),
                ),
                frozen,
            }),
        );
    } catch (error) {
        console.error(host.env, host.stderr().slice(-4000));
        console.error("permissions", await fetch(`${host.url}/permission`).then((r) => r.text()));
        throw error;
    } finally {
        db.close();
        await host.kill();
        await mock.stop();
    }
}, 240_000);

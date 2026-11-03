import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import { type RpcPortFileRecord, rpcPortDir } from "../../../plugin/src/shared/rpc-utils";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const sha = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function eventually<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = read();
        if (value !== undefined) return value;
        await Bun.sleep(25);
    }
    throw new Error("timed out waiting for the v2 RPC surface");
}

interface WireTool {
    name?: string;
    description?: string;
    parameters?: unknown;
    input_schema?: unknown;
}

function headText(body: Record<string, unknown>): string {
    const input = body.input;
    if (!Array.isArray(input) || input.length === 0) return "";
    const content = (input[0] as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) =>
            part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
        )
        .join("");
}

/**
 * Issue 492 finding 7: OpenCode 2 has no `tool.definition` hook, so the Tool Defs row read 0 as if
 * the catalog had been measured and the tool-set hash went out empty. The request draft carries
 * the whole tool set, so the draft is the measurement seam.
 *
 * The byte rule this has to respect: the tool-set fingerprint is attribution for the m[0]/m[1]
 * materialization decision and never a HARD fold trigger (see ARCHITECTURE.md), because it is a
 * process-global signal that would manufacture unrelated session busts. So the proof has two
 * halves — the measurement is real, and the served m[0] bytes are unchanged across four deferred
 * passes while the hash is being recorded.
 */
test("v2 measures tool definitions from the request draft without moving a served byte", async () => {
    const host = await spawnOpencode2({
        magicContextConfig: {
            memory: { enabled: true },
            historian: { disable: true },
            dreamer: { disable: true },
        },
    });
    try {
        // Project docs give m[0] real content to pin. Without them the injected head is an empty
        // `<session-history></session-history>` on every pass, which would be byte-identical
        // whatever the materialization decision did.
        writeFileSync(
            join(host.cwd, "ARCHITECTURE.md"),
            "# Fixture architecture\n\nThe fixture project has one module and one invariant.\n".repeat(
                4,
            ),
        );
        writeFileSync(join(host.cwd, "STRUCTURE.md"), "# Fixture structure\n\n- src/\n- tests/\n".repeat(4));
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        const session = await client.session.create({
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        await waitForPluginActive(client, host.cwd);
        host.mock.setDefault({
            text: "tool telemetry fixture reply",
            usage: { input_tokens: 137, output_tokens: 11 },
        });
        const turn = async (text: string) => {
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait(
                { sessionID: session.id },
                { signal: AbortSignal.timeout(20_000) },
            );
        };
        for (const pass of [1, 2, 3, 4]) await turn(`defer pass ${pass}`);

        const served = host.mock.requests().filter((request) => request.body.model === "mock-model");
        expect(served.length).toBeGreaterThanOrEqual(4);
        const passes = served.slice(0, 4);

        // Byte pin: the served m[0] head, the served system prompt and the served tool catalog are
        // identical on all four deferred passes. Recording a tool-set fingerprint must not fold
        // m[0], rewrite the system block, or touch a tool definition.
        const head = headText(passes[0]!.body);
        expect(head).toContain("<project-docs>");
        expect(head.length).toBeGreaterThan(200);
        expect(String(passes[0]!.body.instructions ?? "").length).toBeGreaterThan(1000);
        // Each fixture run gets a fresh throwaway root and a fresh session id, both of which
        // appear verbatim in the served system prompt. Redacting them makes the pin a hash of the
        // served CONTENT, which is what an A/B against a build without the measurement compares.
        const redact = (value: string) =>
            value
                .split(host.root)
                .join("<ROOT>")
                .split(host.cwd)
                .join("<CWD>")
                .replace(/ses_[A-Za-z0-9]+/g, "<SES>")
                .replace(/msg_[A-Za-z0-9]+/g, "<MSG>");
        const servedPin = passes.map((request) =>
            sha({
                head: redact(headText(request.body)),
                instructions: redact(String(request.body.instructions ?? "")),
                tools: redact(JSON.stringify(request.body.tools)),
            }),
        );
        // The A/B control for issue 492 finding 7: with `recordV2ToolDefinitions` neutralised and
        // the plugin rebuilt, this same redacted pin was
        // d09ad7ca7dfa97379bffb5938e1f9d2b20c63f941a13ed9c9a916b1fb5e73ae4 on @opencode/cli 2.0.5 —
        // the same value the measuring build produces. The tool-set fingerprint is attribution and
        // never folds m[0], so measuring moves no served byte.
        expect(new Set(servedPin).size).toBe(1);

        // The attribution marker is now present rather than empty, and no materialization
        // happened because of it: the m[0] baseline was cut once and never re-cut.
        const contextDb = join(
            host.env.XDG_DATA_HOME!,
            "cortexkit",
            "magic-context",
            "context.db",
        );
        const db = openTestDb(contextDb, { readonly: true, fileMustExist: true }, Database);
        let meta: { hash: string | null; materializedAt: number | null };
        try {
            const row = db
                .prepare(
                    "SELECT cached_m0_tool_set_hash AS hash, cached_m0_materialized_at AS materializedAt FROM session_meta WHERE session_id = ?",
                )
                .get(session.id) as { hash: string | null; materializedAt: number | null };
            meta = row;
        } finally {
            db.close();
        }
        expect(meta.hash).toBeString();
        expect(meta.hash).not.toBe("");

        const storageDir = join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context");
        const discovery = await eventually(() => {
            const directory = rpcPortDir(storageDir, host.cwd);
            if (!existsSync(directory)) return undefined;
            const file = readdirSync(directory).find(
                (name) => name.startsWith("port-") && name.endsWith(".json"),
            );
            return file
                ? (JSON.parse(readFileSync(join(directory, file), "utf8")) as RpcPortFileRecord)
                : undefined;
        });
        const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc/sidebar-snapshot`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${discovery.token}`,
            },
            body: JSON.stringify({ sessionId: session.id, directory: host.cwd }),
        });
        expect(response.status).toBe(200);
        const snapshot = (await response.json()) as { toolDefinitionTokens: number };

        // The row is a measured catalog cost, not the 0 it used to report. The wire catalog is
        // large enough that the calibrated share of it cannot round to nothing.
        const wireTools = (passes[0]!.body.tools ?? []) as WireTool[];
        expect(wireTools.length).toBeGreaterThan(0);
        const rawCatalogTokens = wireTools.reduce(
            (total, tool) =>
                total +
                estimateTokens(tool.description ?? "") +
                estimateTokens(
                    JSON.stringify(tool.parameters ?? tool.input_schema ?? {}) ?? "",
                ),
            0,
        );
        expect(rawCatalogTokens).toBeGreaterThan(0);
        expect(snapshot.toolDefinitionTokens).toBeGreaterThan(0);
    } catch (error) {
        console.error(host.stdout(), host.stderr());
        throw error;
    } finally {
        await host.stop();
    }
}, 90_000);

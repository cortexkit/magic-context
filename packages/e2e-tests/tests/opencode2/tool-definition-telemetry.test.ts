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
    // In a Responses request a developer item can come before the first user item,
    // and the first user item is the one Magic Context writes its history into.
    const content = input.find((item) => item?.role === "user")?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) =>
            part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
        )
        .join("");
}

function systemText(body: Record<string, unknown>): string {
    const developer = Array.isArray(body.input) ? body.input.filter((item) => item?.role === "developer") : [];
    return JSON.stringify([body.instructions, ...developer]);
}

/**
 * OpenCode 2 has no `tool.definition` hook. Its request draft carries the
 * whole catalog, so the token cost of the tool definitions that the sidebar
 * shows must be measured from the draft.
 *
 * Recording the measurement must not change bytes when the catalog is unchanged.
 * Changing the session's own tool names or descriptions is different: the tool
 * list comes before the messages, so the provider's cache is lost anyway and the
 * plugin may rebuild the history it writes into the first user message.
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
        expect(systemText(passes[0]!.body).length).toBeGreaterThan(1000);
        // Normalize the fixture paths and generated IDs when comparing the served content.
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
                instructions: redact(systemText(request.body)),
                tools: redact(JSON.stringify(request.body.tools)),
            }),
        );
        expect(new Set(servedPin).size).toBe(1);

        // The attribution marker is now present rather than empty, and no materialization
        // happened because of it: the m[0] baseline was cut once and never re-cut.
        const contextDb = join(
            host.env.XDG_DATA_HOME!,
            "cortexkit",
            "magic-context",
            "context.db",
        );
        const db = new Database(contextDb, { readonly: true, fileMustExist: true });
        db.exec("PRAGMA busy_timeout = 5000");
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
